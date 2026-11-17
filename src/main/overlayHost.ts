/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { WebContentsView, ipcMain, webContents as allWebContents, type BrowserWindow, type IpcMainEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { PAGE, UI } from '@shared/ipc'
import {
  OVERLAY_PROPS_MAX_BYTES,
  isSurfaceId,
  type OverlayDismissReason,
  type OverlayOpenMessage,
  type OverlayResult,
  type OverlayTier,
  type Rect,
  type SurfaceAnchor,
  type SurfaceId,
  type SurfacePolicy,
  type SurfaceProps,
} from '@shared/overlay'
import { EXIT_SAFETY_MS, clipRect, resolveAnchorRect, toCssPx, toWindowPx } from '@shared/overlayLayout'
import type { AppEvent } from '@shared/services'
import { log } from './log'
import { OverlayState, type OverlayEffect, type OverlayInstance } from './overlayState'
import { PassiveLayer } from './passiveLayer'
import type { TabManager } from './tabs'
import { CrashBudget } from './window'
import { uiOriginOf } from '@shared/url'

// The per-window overlay host. Two tiers are created
// hidden with the window (OV-03): an interactive WebContentsView above the
// tabs, sized to the union of the open surfaces so pages stay clickable
// everywhere else, and a passive click-through child window for hints.
// Main enforces each surface's policy: tab switches, scrolls, outside
// presses, stacking, exits with a safety timeout, focus in and back out,
// and crash recovery (SS-08).

export interface OverlayOpenOptions {
  tabId?: string
}

export interface OverlayAttachOptions {
  window: BrowserWindow
  chrome: WebContents
  tabs: TabManager
  /** The chrome UI's address; tiers load it with their role in the hash. */
  uiUrl: string
  /** The ui preload. */
  preload: string
}

/** Surfaces that have not mounted by then resolve as timed out. */
const MOUNT_TIMEOUT_MS = 5000

interface Waiter {
  resolve(result: OverlayResult): void
  /** Chrome-opened instances report results over UI.overlayResult. */
  toChrome: boolean
}

interface Tier {
  tier: OverlayTier
  wc: WebContents
  ready: boolean
  queue: [channel: string, payload: unknown][]
  budget: CrashBudget
}

export class OverlayHost {
  readonly windowId: number
  readonly #state = new OverlayState()
  readonly #waiters = new Map<string, Waiter>()
  readonly #timers = new Map<string, NodeJS.Timeout>()
  #opts: OverlayAttachOptions | null = null
  #view: WebContentsView | null = null
  #passive: PassiveLayer | null = null
  #tiers: Tier[] = []
  #viewVisible = false
  #focusReturn: WebContents | null = null
  #focused = false
  #covering = false
  #tabsPending = false
  /** The chrome is veiled for a whole-window dialog; `#veilRun` drops a stale capture. */
  #veiled = false
  #veilRun = 0
  readonly #scroll = new Map<string, { x: number; y: number }>()

  constructor(windowId: number) {
    this.windowId = windowId
  }

  /** Creates both tiers, hidden (OV-03). Until this runs, open() rejects and callers keep their fallbacks. */
  attach(opts: OverlayAttachOptions): void {
    if (this.#opts) return
    this.#opts = opts
    const { window, tabs } = opts
    const url = (role: string): string => `${opts.uiUrl.split('#')[0]}#overlay=${role}`

    const view = new WebContentsView({
      webPreferences: { preload: opts.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
    })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    window.contentView.addChildView(view)
    this.#view = view
    void view.webContents.loadURL(url('interactive')).catch(() => undefined)

    const passive = new PassiveLayer(window, { preload: opts.preload, url: url('passive') })
    this.#passive = passive

    this.#tiers = [this.#guardTier('interactive', view.webContents), this.#guardTier('passive', passive.webContents)]
    for (const t of this.#tiers) this.#lockDown(t.wc)

    // New tab views are added on top; the overlay goes back above them.
    tabs.on('created', (tab) => {
      this.#stack()
      this.#watchPresses(tab.view.webContents)
    })
    // A tab that goes to sleep gets a fresh view, added on top too: the overlay goes back above it, and hears its presses.
    tabs.on('view-replaced', (tab) => {
      this.#stack()
      this.#watchPresses(tab.view.webContents)
    })
    tabs.on('closed', (tab) => {
      this.#scroll.delete(tab.id)
      this.#apply(this.#state.matching((i) => i.tabId === tab.id).map((i) => ({ kind: 'close', id: i.id, reason: 'tab-switch' })))
    })
    tabs.on('activated', () => this.#tabSwitched())
    tabs.on('changed', () => {
      this.#reanchorTabs()
      this.#tabsChanged()
    })
    for (const tab of tabs.all()) this.#watchPresses(tab.view.webContents)
    this.#watchPresses(opts.chrome)
    window.on('blur', () => this.#apply(this.#state.outsidePress()))
    window.on('resize', () => this.#resendAll())
    window.once('closed', () => this.#closeEverything('closed'))
  }

  get attached(): boolean {
    return this.#opts !== null
  }

  // ---- the API ----

  open<S extends SurfaceId>(surface: S, anchor: SurfaceAnchor, props: SurfaceProps<S>, opts: OverlayOpenOptions = {}): Promise<OverlayResult> {
    return new Promise((resolve, reject) => {
      try {
        this.#begin(surface, anchor, props, opts, { resolve, toChrome: false })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** The chrome's open: the result arrives over UI.overlayResult. */
  openFromChrome(surface: SurfaceId, anchor: SurfaceAnchor, props: unknown): { instanceId: string } {
    const id = this.#begin(surface, anchor, props, {}, { resolve: () => undefined, toChrome: true })
    return { instanceId: id }
  }

  update(instanceId: string, props: unknown): void {
    checkPropsSize(props)
    if (!this.#state.update(instanceId, props)) return
    const i = this.#state.get(instanceId)
    if (i) this.#show(i, true)
  }

  close(instanceId: string, reason: OverlayDismissReason = 'closed'): void {
    this.#finish(instanceId, { instanceId, dismissed: reason })
  }

  closeAll(filter?: (surface: SurfaceId) => boolean): void {
    for (const i of this.#state.matching((x) => !filter || filter(x.surface))) this.close(i.id, 'closed')
  }

  /** Whether a webContents is one of this window's overlay views (sender routing). */
  ownsWebContents(webContentsId: number): boolean {
    return this.#tiers.some((t) => !t.wc.isDestroyed() && t.wc.id === webContentsId)
  }

  /** The open instances (the smoke test and the ⌘W close order read it). */
  openSurfaces(): { instanceId: string; surface: SurfaceId; tier: OverlayTier; layer: SurfacePolicy['layer'] }[] {
    return this.#state.open().map((i) => ({ instanceId: i.id, surface: i.surface, tier: i.tier, layer: this.#state.policyOf(i).layer }))
  }

  /** The interactive view's bounds in window px while visible (smoke and tests). */
  interactiveBounds(): Rect | null {
    return this.#view && this.#viewVisible ? this.#view.getBounds() : null
  }

  tierWebContents(tier: OverlayTier): WebContents | null {
    return this.#tiers.find((t) => t.tier === tier)?.wc ?? null
  }

  /** Theme and settings events reach the overlay renderers too (OV-04). */
  relay(event: AppEvent): void {
    for (const t of this.#tiers) this.#send(t, UI.appEvent, event)
  }

  /** A page scrolled (PAGE.scroll). */
  pageScrolled(tabId: string, x: number, y: number): void {
    const last = this.#scroll.get(tabId)
    this.#scroll.set(tabId, { x, y })
    if (!last) return
    this.#apply(this.#state.scrolled(tabId, x - last.x, y - last.y))
  }

  // ---- messages from the overlay renderers ----

  mounted(sender: WebContents, instanceId: string, policy: SurfacePolicy): void {
    if (!this.#fromTierOf(sender, instanceId)) return this.#forgotten(sender, instanceId)
    this.#clearTimer(instanceId)
    // Popovers of different kinds don't stack: the newest transient one wins (overlayState).
    for (const other of this.#state.mounted(instanceId, policy)) this.close(other, 'replaced')
    this.#layout()
  }

  bounds(sender: WebContents, instanceId: string, rect: Rect): void {
    if (!this.#fromTierOf(sender, instanceId)) return this.#forgotten(sender, instanceId)
    this.#state.setRect(instanceId, rect)
    this.#layout()
  }

  resolved(sender: WebContents, instanceId: string, value: unknown): void {
    if (!this.#fromTierOf(sender, instanceId)) return
    this.#finish(instanceId, { instanceId, value })
  }

  dismissed(sender: WebContents, instanceId: string, reason: 'escape' | 'closed'): void {
    if (!this.#fromTierOf(sender, instanceId)) return
    this.#finish(instanceId, { instanceId, dismissed: reason })
  }

  removed(sender: WebContents, instanceId: string): void {
    if (!this.#fromTierOf(sender, instanceId)) return
    this.#drop(instanceId)
  }

  // ---- internals ----

  #begin(surface: SurfaceId, anchor: SurfaceAnchor, props: unknown, opts: OverlayOpenOptions, waiter: Waiter): string {
    if (!this.#opts) throw new Error('Not available yet')
    if (!isSurfaceId(surface)) throw new Error(`Unknown surface ${String(surface)}.`)
    checkPropsSize(props)
    const id = randomUUID()
    const { instance, replaced } = this.#state.add({ id, surface, anchor, props, tabId: opts.tabId ?? null })
    this.#waiters.set(id, waiter)
    for (const old of replaced) this.close(old, 'replaced')
    this.#timers.set(
      id,
      setTimeout(() => {
        this.#timers.delete(id)
        const i = this.#state.get(id)
        if (i && !i.policy && !i.closing) {
          log.warn('overlay', 'A surface did not mount in time', { surface })
          this.#finish(id, { instanceId: id, dismissed: 'timeout' })
        }
      }, MOUNT_TIMEOUT_MS),
    )
    if (surface === 'cover') this.#syncCover()
    // Ahead of the show, so the revealed sidebar starts from the tabs of now.
    if (surface === 'sidebar-reveal') this.#sendTabs(instance)
    this.#show(instance, false)
    return id
  }

  /** Only the revealed sidebar (SH-04) lists the window's tabs, so they go out, batched, while it is open. */
  #tabsChanged(): void {
    if (this.#tabsPending) return
    this.#tabsPending = true
    setImmediate(() => {
      this.#tabsPending = false
      const reveal = this.#state.open().find((i) => i.surface === 'sidebar-reveal')
      if (reveal) this.#sendTabs(reveal)
    })
  }

  #sendTabs(i: OverlayInstance): void {
    const tier = this.#tierOf(i)
    if (tier && this.#opts) this.#send(tier, UI.tabsChanged, this.#opts.tabs.snapshot())
  }

  /** Delivers the result once, then lets the renderer play the exit. */
  #finish(id: string, result: OverlayResult): void {
    if (!this.#state.beginClose(id)) return
    const waiter = this.#waiters.get(id)
    this.#waiters.delete(id)
    waiter?.resolve(result)
    if (waiter?.toChrome && this.#opts && !this.#opts.chrome.isDestroyed()) this.#opts.chrome.send(UI.overlayResult, result)
    const i = this.#state.get(id)
    if (!i) return
    this.#clearTimer(id)
    const tier = this.#tierOf(i)
    if (!tier || !tier.ready) return this.#drop(id)
    this.#send(tier, UI.overlayHide, { instanceId: id })
    // A stuck exit never leaves a dead layer (DS-82).
    this.#timers.set(
      id,
      setTimeout(() => this.#drop(id), this.#state.policyOf(i).exitMs + EXIT_SAFETY_MS),
    )
    this.#layout()
  }

  #drop(id: string): void {
    this.#clearTimer(id)
    // A surface that opens and closes before its renderer has loaded must never reach it: the queued show
    // would otherwise arrive after main forgot it, and the renderer would keep a frame main can't close.
    for (const t of this.#tiers) t.queue = t.queue.filter(([, payload]) => (payload as { instanceId?: unknown } | null)?.instanceId !== id)
    const i = this.#state.remove(id)
    if (!i) return
    const waiter = this.#waiters.get(id)
    if (waiter) {
      this.#waiters.delete(id)
      const result: OverlayResult = { instanceId: id, dismissed: 'closed' }
      waiter.resolve(result)
      if (waiter.toChrome && this.#opts && !this.#opts.chrome.isDestroyed()) this.#opts.chrome.send(UI.overlayResult, result)
    }
    if (i.surface === 'cover') this.#syncCover()
    this.#layout()
  }

  #clearTimer(id: string): void {
    const t = this.#timers.get(id)
    if (t) clearTimeout(t)
    this.#timers.delete(id)
  }

  #apply(effects: OverlayEffect[]): void {
    for (const e of effects) {
      const i = this.#state.get(e.id)
      if (!i) continue
      if (e.kind === 'close') this.close(e.id, e.reason)
      else if (e.kind === 'hide' || e.kind === 'show') {
        this.#state.setHidden(e.id, e.kind === 'hide')
        this.#show(i, true)
      } else this.#show(i, true)
    }
    if (effects.length > 0) this.#layout()
  }

  #tabSwitched(): void {
    const tabs = this.#opts?.tabs
    if (!tabs) return
    this.#apply(this.#state.tabSwitched(tabs.activeId(), tabs.visibleIds()))
  }

  /** Tab panes move (split, sidebar, layout): tab-anchored surfaces follow. */
  #reanchorTabs(): void {
    for (const i of this.#state.open()) if (i.tabId !== null && i.anchor.kind === 'tab') this.#show(i, true)
  }

  #resendAll(): void {
    this.#passive?.sync()
    for (const i of this.#state.all()) this.#show(i, true)
    this.#layout()
  }

  #zoom(): number {
    const chrome = this.#opts?.chrome
    return chrome && !chrome.isDestroyed() ? chrome.getZoomFactor() || 1 : 1
  }

  #viewport(): Rect {
    const window = this.#opts?.window
    if (!window || window.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const { width, height } = window.getContentBounds()
    return toCssPx({ x: 0, y: 0, width, height }, this.#zoom())
  }

  #paneOf = (tabId: string): Rect | null => {
    const pane = this.#opts?.tabs.paneBounds(tabId)
    return pane ? toCssPx(pane, this.#zoom()) : null
  }

  #show(i: OverlayInstance, update: boolean): void {
    const tier = this.#tierOf(i)
    if (!tier) return
    const rect = resolveAnchorRect(i.anchor, this.#paneOf)
    // A tab-anchored surface whose tab has no pane right now waits, hidden.
    const hidden = i.hidden || (i.tabId !== null && i.anchor.kind === 'tab' && rect === null)
    const message: OverlayOpenMessage = {
      instanceId: i.id,
      surface: i.surface,
      anchor: i.anchor,
      props: i.props,
      windowId: this.windowId,
      rect,
      viewport: this.#viewport(),
      tabId: i.tabId,
      hidden,
      update,
    }
    if (!tier.wc.isDestroyed()) tier.wc.setZoomFactor(this.#zoom())
    this.#send(tier, UI.overlayShow, message)
  }

  #send(tier: Tier, channel: string, payload: unknown): void {
    if (tier.wc.isDestroyed()) return
    if (!tier.ready) {
      tier.queue.push([channel, payload])
      return
    }
    tier.wc.send(channel, payload)
  }

  #tierOf(i: OverlayInstance): Tier | undefined {
    return this.#tiers.find((t) => t.tier === i.tier)
  }

  /**
   * One of this window's overlay renderers draws a surface main no longer has. Its frame would still count
   * in the renderer's own layout (the origin it shifts everything by), putting every real surface out of
   * the view main sized, so it goes.
   */
  #forgotten(sender: WebContents, instanceId: string): void {
    if (this.#state.get(instanceId)) return
    const tier = this.#tiers.find((t) => !t.wc.isDestroyed() && t.wc.id === sender.id)
    if (tier?.ready) tier.wc.send(UI.overlayHide, { instanceId })
  }

  #fromTierOf(sender: WebContents, instanceId: string): boolean {
    const i = this.#state.get(instanceId)
    const tier = i && this.#tierOf(i)
    return Boolean(tier && !tier.wc.isDestroyed() && tier.wc.id === sender.id)
  }

  /** Sizes the interactive view to the open surfaces, shows the passive tier while it draws, moves focus. */
  #layout(): void {
    const opts = this.#opts
    const view = this.#view
    if (!opts || !view || opts.window.isDestroyed()) return
    const viewport = this.#viewport()
    const zoom = this.#zoom()
    const union = this.#state.interactiveUnion(viewport)
    const clipped = union && clipRect(union, viewport)
    if (clipped) {
      view.setBounds(toWindowPx(clipped, zoom))
      if (!this.#viewVisible) {
        this.#viewVisible = true
        this.#stack()
        view.setVisible(true)
      }
    } else if (this.#viewVisible) {
      // Hidden only once the renderer removed the last surface, so a stale frame never shows on the next open.
      this.#viewVisible = false
      view.setVisible(false)
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
    if (this.#state.modalOpen()) this.#stack()
    this.#syncVeil()

    // The passive tier sits above everything, so it hides while a modal is open.
    const passiveShown = this.#state.shown('passive').length > 0 && !this.#state.modalOpen()
    this.#passive?.setVisible(passiveShown)

    this.#syncFocus()
    // The chrome lifts its drag regions under the interactive surfaces, or they would swallow clicks.
    const rects = this.#state.shown('interactive').map((i) => (this.#state.policyOf(i).size === 'fill-window' ? viewport : i.rect)).filter((r): r is Rect => r !== null)
    if (!opts.chrome.isDestroyed()) opts.chrome.send(UI.appEvent, { type: 'overlay-region', rects } satisfies AppEvent)
  }

  #syncFocus(): void {
    const view = this.#view
    if (!view) return
    const owner = this.#state.focusOwner()
    if (owner && this.#viewVisible) {
      if (!this.#focused) {
        const current = allWebContents.getFocusedWebContents()
        this.#focusReturn = current && current.id !== view.webContents.id ? current : null
        this.#focused = true
      }
      if (!view.webContents.isFocused()) view.webContents.focus()
    } else if (this.#focused) {
      this.#focused = false
      // Focus doesn't fall back by itself once the focused view hides.
      const back = this.#focusReturn
      this.#focusReturn = null
      const target = back && !back.isDestroyed() ? back : this.#opts?.chrome
      if (target && !target.isDestroyed() && this.#opts?.window.isFocused()) target.focus()
    }
  }

  /** tabs < overlay < peek; a modal lifts the overlay above the peek too. */
  #stack(): void {
    const opts = this.#opts
    const view = this.#view
    if (!opts || !view || opts.window.isDestroyed()) return
    const content = opts.window.contentView
    const tabViews = new Set(opts.tabs.all().map((t) => t.view))
    const others = content.children.filter((c) => c !== view && !tabViews.has(c as WebContentsView))
    if (this.#state.modalOpen() || others.length === 0) {
      content.addChildView(view)
      return
    }
    const rest = content.children.filter((c) => c !== view)
    const index = rest.indexOf(others[0] as (typeof rest)[number])
    content.addChildView(view, Math.max(0, index))
  }

  /**
   * A whole-window dialog blurs and washes everything, chrome
   * included. The overlay's own backdrop-filter can't reach the views below
   * it, so the chrome blurs itself, and the showing pages (native views above
   * the chrome) are captured, hidden and drawn by the chrome as stills.
   */
  #syncVeil(): void {
    const opts = this.#opts
    if (!opts) return
    const veiled = this.#state.veiled()
    if (veiled === this.#veiled) return
    this.#veiled = veiled
    const run = ++this.#veilRun
    const send = (event: AppEvent): void => {
      if (!opts.chrome.isDestroyed()) opts.chrome.send(UI.appEvent, event)
    }
    if (!veiled) {
      opts.tabs.setHidden('overlay-veil', false)
      send({ type: 'window-veil', on: false, stills: [] })
      return
    }
    // The chrome blurs at once; the stills follow as soon as they are captured.
    send({ type: 'window-veil', on: true, stills: [] })
    const zoom = this.#zoom()
    // Apex pages are drawn by the chrome itself, so only web pages need a still.
    const web = opts.tabs.visibleIds().filter((id) => {
      const tab = opts.tabs.find(id)
      return tab !== undefined && !opts.tabs.isChromeDrawn(tab)
    })
    const shots = web.map(async (id) => {
      const pane = opts.tabs.paneBounds(id)
      const src = pane ? await opts.tabs.capture(id, opts.chrome).catch(() => null) : null
      return pane && src ? { rect: toCssPx(pane, zoom), src } : null
    })
    void Promise.all(shots).then((stills) => {
      if (run !== this.#veilRun || !this.#veiled) return
      const drawn = stills.filter((s): s is { rect: Rect; src: string } => s !== null)
      send({ type: 'window-veil', on: true, stills: drawn })
      opts.tabs.setHidden('overlay-veil', true)
    })
  }

  #syncCover(): void {
    const tabs = this.#opts?.tabs
    if (!tabs) return
    // The legacy holdOverlay shim: the chrome draws under the pages, so they hide while a cover is open.
    const covering = this.#state.all().some((i) => i.surface === 'cover')
    if (covering === this.#covering) return
    this.#covering = covering
    tabs.setHidden('overlay-cover', covering)
  }

  #watchPresses(wc: WebContents): void {
    wc.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseDown') return
      const zoom = wc === this.#opts?.chrome ? this.#zoom() : 1
      const point = { x: mouse.x / zoom, y: mouse.y / zoom }
      // A press on a surface's own anchor is the opener's toggle, not an outside press.
      const effects = this.#state.outsidePress().filter((e) => {
        if (e.kind !== 'close' || wc !== this.#opts?.chrome) return true
        const anchor = this.#state.get(e.id)?.anchor
        if (anchor?.kind !== 'window') return true
        const r = anchor.rect
        return !(point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height)
      })
      this.#apply(effects)
    })
  }

  /** Overlay views only ever show the UI: no navigation away, no new windows. */
  #lockDown(wc: WebContents): void {
    const uiOrigin = uiOriginOf(this.#opts?.uiUrl ?? 'app://apex')
    wc.on('will-navigate', (event) => {
      if (uiOrigin === null || uiOriginOf(event.url) !== uiOrigin) event.preventDefault()
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.#opts?.tabs.create(url, { afterId: this.#opts.tabs.activeId() ?? undefined })
      return { action: 'deny' }
    })
  }

  /** Readiness, queued messages and crash recovery for one tier's renderer (SS-08). */
  #guardTier(tier: OverlayTier, wc: WebContents): Tier {
    const t: Tier = { tier, wc, ready: false, queue: [], budget: new CrashBudget() }
    const uiOrigin = uiOriginOf(this.#opts?.uiUrl ?? 'app://apex')
    wc.on('did-start-loading', () => {
      t.ready = false
    })
    wc.on('did-finish-load', () => {
      if (uiOrigin === null || uiOriginOf(wc.getURL()) !== uiOrigin) return
      t.ready = true
      wc.setZoomFactor(this.#zoom())
      for (const [channel, payload] of t.queue.splice(0)) wc.send(channel, payload)
    })
    const recover = (why: string): void => {
      log.warn('overlay', `The ${tier} overlay stopped drawing`, { reason: why })
      t.ready = false
      t.queue = []
      for (const i of this.#state.matching((x) => x.tier === tier)) this.#finish(i.id, { instanceId: i.id, dismissed: 'crashed' })
      for (const i of this.#state.all().filter((x) => x.tier === tier)) this.#drop(i.id)
      if (!t.budget.record(Date.now()) || !this.#opts) return
      const url = `${this.#opts.uiUrl.split('#')[0]}#overlay=${tier}`
      setTimeout(() => {
        if (!wc.isDestroyed()) void wc.loadURL(url).catch(() => undefined)
      }, 300 * t.budget.count)
    }
    wc.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') recover(details.reason)
    })
    wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) recover(`load failed (${code})`)
    })
    return t
  }

  #closeEverything(reason: OverlayDismissReason): void {
    for (const i of this.#state.matching(() => true)) this.#finish(i.id, { instanceId: i.id, dismissed: reason })
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }
}

function checkPropsSize(props: unknown): void {
  let size: number
  try {
    size = JSON.stringify(props ?? null).length
  } catch {
    throw new Error('Overlay props must be plain data.')
  }
  if (size > OVERLAY_PROPS_MAX_BYTES) throw new Error('Overlay props are too large.')
}

// ---- IPC (registered once, routed to each window's host by sender) ----

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()
export const anchorSchema: z.ZodType<SurfaceAnchor> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('window'), rect }).strict(),
  z.object({ kind: z.literal('tab'), tabId: z.string().min(1).max(64), rect: rect.nullable() }).strict(),
  z.object({ kind: z.literal('point'), x: z.number().finite(), y: z.number().finite() }).strict(),
])
const surfaceSchema = z.string().max(64).refine(isSurfaceId, 'Unknown surface')
const instanceId = z.string().uuid()
const policySchema: z.ZodType<SurfacePolicy> = z
  .object({
    tier: z.enum(['interactive', 'passive']),
    size: z.enum(['fixed', 'fill-window', 'fill-tab']),
    outsideClick: z.enum(['close', 'ignore']),
    blocksPage: z.boolean(),
    onTabSwitch: z.enum(['close', 'follow', 'stay', 'hide-until-return']),
    onScroll: z.enum(['follow', 'close']).optional(),
    layer: z.enum(['modal', 'menu', 'hint']),
    focus: z.boolean(),
    exitMs: z.number().int().min(0).max(2000),
    veil: z.boolean().optional(),
  })
  .strict()
const scrollSchema = z.object({ scrollX: z.number().finite(), scrollY: z.number().finite() }).strict()

export interface OverlayRouting {
  /** The window whose chrome (main frame) sent the message, or null. */
  chromeHost(event: IpcMainEvent | Electron.IpcMainInvokeEvent): OverlayHost | null
  /** The window that owns this overlay renderer, or null. */
  overlayHost(sender: WebContents): OverlayHost | null
  /** The window and tab id of a page's webContents. */
  tabOf(sender: WebContents): { host: OverlayHost; tabId: string } | null
}

let registered = false

/** Wires the overlay channels once for every window. */
export function registerOverlayIpc(routing: OverlayRouting): void {
  if (registered) return
  registered = true
  ipcMain.handle(UI.overlayOpen, (event, ...raw: unknown[]) => {
    const host = routing.chromeHost(event)
    if (!host) throw new Error('Rejected IPC from an untrusted sender.')
    const [surface, anchor, props] = z.tuple([surfaceSchema, anchorSchema, z.unknown()]).parse(raw)
    return host.openFromChrome(surface as SurfaceId, anchor, props)
  })
  const fromChrome = (channel: string, schema: z.ZodType<unknown[]>, fn: (host: OverlayHost, args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...raw: unknown[]) => {
      const host = routing.chromeHost(event)
      const parsed = schema.safeParse(raw)
      if (!host || !parsed.success) return
      try {
        fn(host, parsed.data)
      } catch (err) {
        log.warn('overlay', `${channel} failed`, { error: err instanceof Error ? err.message : String(err) })
      }
    })
  }
  fromChrome(UI.overlayUpdate, z.tuple([instanceId, z.unknown()]), (host, [id, props]) => host.update(id as string, props))
  fromChrome(UI.overlayClose, z.tuple([instanceId]), (host, [id]) => host.close(id as string, 'closed'))
  // Both tiers are created with the window, so there is nothing more to warm (OV-03).
  fromChrome(UI.overlayPrewarm, z.tuple([surfaceSchema]), () => undefined)

  const fromOverlay = (channel: string, schema: z.ZodType<unknown[]>, fn: (host: OverlayHost, sender: WebContents, args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...raw: unknown[]) => {
      const host = routing.overlayHost(event.sender)
      const parsed = schema.safeParse(raw)
      if (!host || !parsed.success || event.senderFrame !== event.sender.mainFrame) return
      fn(host, event.sender, parsed.data)
    })
  }
  fromOverlay(UI.overlayMounted, z.tuple([instanceId, policySchema]), (host, sender, [id, policy]) => host.mounted(sender, id as string, policy as SurfacePolicy))
  fromOverlay(UI.overlayBounds, z.tuple([instanceId, rect]), (host, sender, [id, r]) => host.bounds(sender, id as string, r as Rect))
  fromOverlay(UI.overlayResolve, z.tuple([instanceId, z.unknown()]), (host, sender, [id, value]) => {
    // Results go back over IPC, so they get the same cap as props.
    try {
      checkPropsSize(value)
    } catch {
      return
    }
    host.resolved(sender, id as string, value)
  })
  fromOverlay(UI.overlayDismiss, z.tuple([instanceId, z.enum(['escape', 'closed'])]), (host, sender, [id, reason]) => host.dismissed(sender, id as string, reason as 'escape' | 'closed'))
  fromOverlay(UI.overlayRemoved, z.tuple([instanceId]), (host, sender, [id]) => host.removed(sender, id as string))

  // Page-anchored surfaces follow or close as the page scrolls.
  ipcMain.on(PAGE.scroll, (event, raw: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    const at = routing.tabOf(event.sender)
    const parsed = scrollSchema.safeParse(raw)
    if (at && parsed.success) at.host.pageScrolled(at.tabId, parsed.data.scrollX, parsed.data.scrollY)
  })
}
