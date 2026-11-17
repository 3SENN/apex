/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OverlayResult, Rect, SurfaceAnchor, SurfaceId, SurfaceProps } from '@shared/overlay'
import type { FindState } from '@shared/find'
import { bubbleText, type LinkPreview } from '@shared/links'
import type { PeekState } from '@shared/services'
import type { LoadInfo } from './loadProgress'
import type { WindowContext } from './features/types'
import { log } from './log'
import type { Tab } from './tabs'

// The overlay surfaces main drives around the page: the link bubble and
// preview card, the page-progress bar, the find bar and the peek frame.
// Each slot holds at most one instance and keeps its id so later changes
// update it in place instead of opening another.

/** How long the finished bar stays to fade out before it is closed. */
export const PROGRESS_FADE_MS = 320

type Overlay = WindowContext['overlay']

export class SurfaceSlot<S extends SurfaceId> {
  #id: string | null = null
  #tabId: string | null = null

  constructor(
    private readonly overlay: () => Overlay | null,
    private readonly surface: S,
    private readonly onResult?: (result: OverlayResult) => void,
  ) {}

  get open(): boolean {
    return this.#id !== null
  }

  get tabId(): string | null {
    return this.#tabId
  }

  /** Opens the surface, or updates the open one when it belongs to the same tab. */
  show(anchor: SurfaceAnchor, props: SurfaceProps<S>, tabId: string | null = null): void {
    const overlay = this.overlay()
    if (!overlay?.attached) return
    if (this.#id && this.#tabId === tabId) {
      overlay.update(this.#id, props)
      return
    }
    this.hide()
    const before = new Set(overlay.openSurfaces().map((s) => s.instanceId))
    let result: Promise<OverlayResult>
    try {
      result = overlay.open(this.surface, anchor, props, tabId ? { tabId } : {})
    } catch (err) {
      log.debug('addressSurfaces', 'Overlay refused a surface', { surface: this.surface, error: err instanceof Error ? err.message : String(err) })
      return
    }
    const id = overlay.openSurfaces().find((s) => s.surface === this.surface && !before.has(s.instanceId))?.instanceId ?? null
    this.#id = id
    this.#tabId = tabId
    const done = (r: OverlayResult | null): void => {
      if (this.#id === id) {
        this.#id = null
        this.#tabId = null
      }
      if (r) this.onResult?.(r)
    }
    void result.then(done, () => done(null))
  }

  hide(): void {
    const id = this.#id
    this.#id = null
    this.#tabId = null
    if (id) this.overlay()?.close(id)
  }
}

/** One window's link, progress, find and peek surfaces. */
export class AddressSurfaces {
  readonly #win: WindowContext
  readonly #bubble: SurfaceSlot<'link-bubble'>
  readonly #preview: SurfaceSlot<'link-preview'>
  readonly #peek: SurfaceSlot<'peek-frame'>
  readonly #progress = new Map<string, { slot: SurfaceSlot<'page-progress'>; timer: ReturnType<typeof setTimeout> | null }>()
  readonly #find = new Map<string, { slot: SurfaceSlot<'find-bar'>; focus: number; state: FindState | null }>()
  /** Tabs that are loading: the bubble stays hidden for them. */
  readonly #loading = new Set<string>()

  constructor(win: WindowContext, private readonly closeFind: (tabId: string) => void) {
    this.#win = win
    const overlay = (): Overlay | null => (win.window.isDestroyed() ? null : win.overlay)
    this.#bubble = new SurfaceSlot(overlay, 'link-bubble')
    this.#preview = new SurfaceSlot(overlay, 'link-preview')
    this.#peek = new SurfaceSlot(overlay, 'peek-frame', (r) => {
      // The backdrop, Esc or the header's close; "Open as tab" promotes it.
      if ('value' in r && r.value === 'promote') win.peek.promote()
      else win.peek.close()
    })
  }

  #overlay(): Overlay | null {
    return this.#win.window.isDestroyed() ? null : this.#win.overlay
  }

  // ---- links ----

  /** update-target-url: the bubble at the bottom left of the tab's pane, hidden while it loads. */
  linkHover(tab: Tab, url: string | null): void {
    const active = this.#win.tabs.active()
    if (!url || active?.id !== tab.id || this.#loading.has(tab.id)) {
      if (this.#bubble.tabId === tab.id || !url) this.#bubble.hide()
      return
    }
    this.#bubble.show({ kind: 'tab', tabId: tab.id, rect: null }, { text: bubbleText(url) }, tab.id)
  }

  /** ⌥-hover or a long press: the card under the link; a null rect closes it. */
  linkPreview(tab: Tab, url: string, rect: Rect | null, preview: LinkPreview | null, failed: boolean): void {
    if (!rect || !url) {
      this.#preview.hide()
      return
    }
    this.#preview.show({ kind: 'tab', tabId: tab.id, rect }, { url, preview, failed }, tab.id)
  }

  // ---- loading ----

  /** Each load stage: the bar shows while loading and fades out once finished. */
  load(tab: Tab, info: LoadInfo): void {
    const loading = info.loadStage !== 'idle' && info.loadStage !== 'finished'
    if (loading) {
      this.#loading.add(tab.id)
      if (this.#bubble.tabId === tab.id) this.#bubble.hide()
    } else this.#loading.delete(tab.id)
    if (this.#win.tabs.isChromeDrawn(tab)) return
    let entry = this.#progress.get(tab.id)
    if (info.loadStage === 'idle') {
      if (entry) this.#dropProgress(tab.id)
      return
    }
    if (!entry) {
      if (!loading) return
      entry = { slot: new SurfaceSlot(() => this.#overlay(), 'page-progress'), timer: null }
      this.#progress.set(tab.id, entry)
    }
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.slot.show({ kind: 'tab', tabId: tab.id, rect: null }, { stage: info.loadStage, startedAt: info.loadStartedAt }, tab.id)
    if (!loading) entry.timer = setTimeout(() => this.#dropProgress(tab.id), PROGRESS_FADE_MS)
  }

  #dropProgress(tabId: string): void {
    const entry = this.#progress.get(tabId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.slot.hide()
    this.#progress.delete(tabId)
  }

  // ---- find ----

  /** ⌘F: opens the tab's find bar, or refocuses the one already open. */
  openFind(tabId: string): void {
    let entry = this.#find.get(tabId)
    if (!entry) {
      const slot = new SurfaceSlot(() => this.#overlay(), 'find-bar', (r) => {
        // Esc in the bar resolves 'close' after closing main's state; any other dismissal closes it too.
        if (this.#find.get(tabId)?.slot === slot) this.#find.delete(tabId)
        if (!('value' in r)) this.closeFind(tabId)
      })
      entry = { slot, focus: 0, state: null }
      this.#find.set(tabId, entry)
    }
    entry.focus += 1
    entry.slot.show({ kind: 'tab', tabId, rect: null }, { tabId, focus: entry.focus, ...(entry.state ? { state: entry.state } : {}) }, tabId)
  }

  /** Main's find state for a tab: closing it elsewhere closes the bar. */
  findState(tabId: string, state: FindState): void {
    const entry = this.#find.get(tabId)
    if (!entry) return
    entry.state = state
    if (state.open) {
      if (entry.slot.open) entry.slot.show({ kind: 'tab', tabId, rect: null }, { tabId, focus: entry.focus, state }, tabId)
      return
    }
    this.#find.delete(tabId)
    entry.slot.hide()
  }

  // ---- peek ----

  peekState(state: PeekState): void {
    if (!state.open) {
      this.#peek.hide()
      return
    }
    const content = this.#win.window.getContentBounds()
    const zoom = this.#win.chrome.isDestroyed() ? 1 : this.#win.chrome.getZoomFactor() || 1
    this.#peek.show({ kind: 'window', rect: { x: 0, y: 0, width: content.width / zoom, height: content.height / zoom } }, { url: state.url, title: state.title, loading: state.loading })
  }

  /** A tab closed. */
  forget(tabId: string): void {
    this.#loading.delete(tabId)
    this.#dropProgress(tabId)
    const find = this.#find.get(tabId)
    this.#find.delete(tabId)
    find?.slot.hide()
    if (this.#bubble.tabId === tabId) this.#bubble.hide()
    if (this.#preview.tabId === tabId) this.#preview.hide()
  }
}

const perWindow = new WeakMap<WindowContext, AddressSurfaces>()

export function bindAddressSurfaces(win: WindowContext, closeFind: (tabId: string) => void): AddressSurfaces {
  const existing = perWindow.get(win)
  if (existing) return existing
  const surfaces = new AddressSurfaces(win, closeFind)
  perWindow.set(win, surfaces)
  return surfaces
}

export function addressSurfacesOf(win: WindowContext | null | undefined): AddressSurfaces | null {
  return win ? (perWindow.get(win) ?? null) : null
}
