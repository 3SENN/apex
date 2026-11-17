/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TabMedia, MediaAction } from '@shared/tabs'
import type { TabManager } from './tabs'

// The media card (SH-17): while a background tab plays sound or video, the
// sidebar shows it with go to tab, play or pause, mute and dismiss. Pausing
// from the card remembers the tab so the card can resume it. The card hides
// while that tab shows, and the `mediaCard` setting turns it on.

/** The isolated world the card's play and pause scripts run in. */
export const MEDIA_WORLD = 1005

// The isolated world keeps its own globals for the document's life, so the
// card remembers exactly which elements it paused without touching the page.
export const PAUSE_SCRIPT = `(() => {
  const playing = Array.from(document.querySelectorAll('video, audio')).filter((m) => !m.paused && !m.ended)
  for (const m of playing) m.pause()
  window.__atelierCardPaused = playing
  return playing.length
})()`

export const PLAY_SCRIPT = `(() => {
  const list = (window.__atelierCardPaused || []).filter((m) => m.isConnected)
  window.__atelierCardPaused = []
  const targets = list.length ? list : Array.from(document.querySelectorAll('video, audio')).filter((m) => m.paused && m.currentTime > 0).slice(0, 1)
  for (const m of targets) m.play().catch(() => undefined)
  return targets.length
})()`

export interface MediaTabState {
  id: string
  title: string
  url: string
  favicon: string | null
  audible: boolean
  muted: boolean
  /** Showing now (active, or either split pane). */
  visible: boolean
}

export interface MediaMemory {
  /** The tab the card paused (it keeps the card until it plays, closes or is dismissed). */
  pausedId: string | null
  /** Dismissed tabs stay hidden until they go quiet and play again. */
  dismissed: ReadonlySet<string>
  /** Tabs in the order they last started making sound, newest last. */
  started: readonly string[]
}

/** The card's tab: the newest background tab making sound, else the one the card paused. */
export function pickMediaCard(tabs: readonly MediaTabState[], memory: MediaMemory, enabled: boolean): TabMedia | null {
  if (!enabled) return null
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const playing = [...memory.started].reverse().map((id) => byId.get(id)).find((t) => t && t.audible && !t.visible && !memory.dismissed.has(t.id))
  const tab = playing ?? (memory.pausedId ? byId.get(memory.pausedId) : undefined)
  if (!tab || tab.visible || memory.dismissed.has(tab.id)) return null
  return { tabId: tab.id, title: tab.title, url: tab.url, favicon: tab.favicon, playing: tab.audible, muted: tab.muted }
}

export class MediaSessions {
  readonly #tabs: TabManager
  readonly #enabled: () => boolean
  #pausedId: string | null = null
  readonly #dismissed = new Set<string>()
  #started: string[] = []
  readonly #audible = new Map<string, boolean>()
  readonly #off: () => void

  constructor({ tabs, enabled }: { tabs: TabManager; enabled(): boolean }) {
    this.#tabs = tabs
    this.#enabled = enabled
    const onChanged = (): void => this.#observe()
    tabs.on('changed', onChanged)
    this.#off = () => tabs.off('changed', onChanged)
  }

  dispose(): void {
    this.#off()
  }

  current(): TabMedia | null {
    return pickMediaCard(this.#states(), { pausedId: this.#pausedId, dismissed: this.#dismissed, started: this.#started }, this.#enabled())
  }

  async control(tabId: string, action: MediaAction): Promise<void> {
    const tab = this.#tabs.get(tabId)
    const wc = tab.view.webContents
    switch (action) {
      case 'pause':
        await wc.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code: PAUSE_SCRIPT }], true).catch(() => 0)
        this.#pausedId = tabId
        break
      case 'play':
        await wc.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code: PLAY_SCRIPT }], true).catch(() => 0)
        break
      case 'mute':
      case 'unmute':
        this.#tabs.setMuted(tabId, action === 'mute')
        break
      case 'dismiss':
        this.#dismissed.add(tabId)
        if (this.#pausedId === tabId) this.#pausedId = null
        break
    }
    this.#tabs.refresh()
  }

  #states(): MediaTabState[] {
    const split = this.#tabs.split()
    const active = this.#tabs.activeId()
    return this.#tabs.all().map((t) => {
      const info = this.#tabs.info(t)
      const visible = t.id === active || (split !== null && active !== null && (split.primaryId === active || split.secondaryId === active) && (split.primaryId === t.id || split.secondaryId === t.id))
      return { id: t.id, title: info.title, url: info.url, favicon: info.favicon, audible: info.audible, muted: info.muted, visible }
    })
  }

  /** Tracks sound starting and stopping; a dismissal ends once the tab goes quiet. */
  #observe(): void {
    const ids = new Set<string>()
    for (const t of this.#tabs.all()) {
      ids.add(t.id)
      const wc = t.view.webContents
      const audible = !wc.isDestroyed() && wc.isCurrentlyAudible()
      const before = this.#audible.get(t.id) ?? false
      if (audible && !before) {
        this.#started = [...this.#started.filter((id) => id !== t.id), t.id]
        // Playing again (from the page or the card) ends the card's pause.
        if (this.#pausedId === t.id) this.#pausedId = null
      }
      if (!audible && before && this.#pausedId !== t.id) this.#dismissed.delete(t.id)
      this.#audible.set(t.id, audible)
    }
    for (const id of [...this.#audible.keys()]) if (!ids.has(id)) this.#audible.delete(id)
    this.#started = this.#started.filter((id) => ids.has(id))
    if (this.#pausedId && !ids.has(this.#pausedId)) this.#pausedId = null
    for (const id of [...this.#dismissed]) if (!ids.has(id)) this.#dismissed.delete(id)
  }
}
