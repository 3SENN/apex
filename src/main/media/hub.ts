/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { webFrameMain, type WebContents } from 'electron'
import {
  EMPTY_MEDIA_MEMORY,
  EMPTY_MEDIA_STATE,
  clampRate,
  mediaHubState,
  observeMedia,
  type MediaCommand,
  type MediaEvent,
  type MediaHubState,
  type MediaMemory,
  type MediaTabInput,
  type PageMediaCommand,
  type PageMediaReport,
  PAGE_MEDIA,
} from '@shared/media'
import type { WindowContext } from '../features/types'
import { MEDIA_WORLD, PAUSE_SCRIPT, PLAY_SCRIPT } from '../mediaSessions'
import { PIP_WORLD } from '../pip'

// The media hub (MD-01): every tab's media, from its frames' page helpers
// (preload/page/media.ts) and what Chromium hears, merged into each window's
// sources. One hub serves the app, since tabs move between windows; a window
// lists its own tabs and those of other windows on the same session (the
// same profile, never a private window's). Commands go to the frame that
// leads the tab's media; without a report (sound from a page the helper
// can't see), play and pause fall back to the media card's own scripts.

interface FrameEntry {
  report: PageMediaReport
  processId: number
  routingId: number
  /** When it last reported, and last started playing (a running count). */
  seq: number
  playingSeq: number
}

/** Toggles picture-in-picture for the frame's best video (the playing one with the largest picture). */
export const TOGGLE_PIP_SCRIPT = `(async () => {
  if (document.pictureInPictureElement) { try { await document.exitPictureInPicture() } catch {} return false }
  if (!document.pictureInPictureEnabled) return false
  const videos = Array.from(document.querySelectorAll('video')).filter((v) => v.videoWidth > 0 && !v.disablePictureInPicture)
  const area = (v) => v.clientWidth * v.clientHeight
  const video = videos.filter((v) => !v.paused && !v.ended).sort((a, b) => area(b) - area(a))[0] ?? videos.sort((a, b) => area(b) - area(a))[0]
  if (!video) return false
  try { await video.requestPictureInPicture(); return true } catch { return false }
})()`

/** The media element under a point of the main frame (CSS px), into open shadow roots. */
export function pipAtPointScript(x: number, y: number): string {
  return `(async () => {
  let root = document, el = null
  for (let i = 0; i < 8 && root; i++) {
    const hit = root.elementsFromPoint(${x}, ${y})
    const media = hit.find((n) => n instanceof HTMLVideoElement)
    if (media) { el = media; break }
    const host = hit.find((n) => n.shadowRoot)
    root = host ? host.shadowRoot : null
  }
  if (document.pictureInPictureElement) { try { await document.exitPictureInPicture() } catch {} return false }
  if (!el || el.disablePictureInPicture) return false
  try { await el.requestPictureInPicture(); return true } catch { return false }
})()`
}

export interface MediaHubDeps {
  windows(): readonly WindowContext[]
  /** How long changes gather before the windows hear about them. */
  delayMs?: number
}

export class MediaHub {
  readonly #deps: MediaHubDeps
  readonly #frames = new Map<string, Map<string, FrameEntry>>()
  #memory: MediaMemory = EMPTY_MEDIA_MEMORY
  #wasPlaying: Map<string, boolean> = new Map()
  #seq = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  readonly #sent = new Map<number, string>()

  constructor(deps: MediaHubDeps) {
    this.#deps = deps
  }

  // ── reports ──

  /** A frame's page helper reported (null: its media is gone). */
  report(tabId: string, frame: { processId: number; routingId: number }, report: PageMediaReport | null): void {
    const key = `${frame.processId}:${frame.routingId}`
    let frames = this.#frames.get(tabId)
    if (!report) {
      frames?.delete(key)
      if (frames?.size === 0) this.#frames.delete(tabId)
      this.schedule()
      return
    }
    if (!frames) this.#frames.set(tabId, (frames = new Map()))
    const before = frames.get(key)
    const seq = ++this.#seq
    const playingSeq = report.playing && !before?.report.playing ? seq : (before?.playingSeq ?? 0)
    frames.set(key, { report, processId: frame.processId, routingId: frame.routingId, seq, playingSeq })
    this.schedule()
  }

  /** The tab closed or loaded a new page: its frames' reports end. */
  forget(tabId: string): void {
    if (this.#frames.delete(tabId)) this.schedule()
  }

  /** The frame leading a tab's media: the one that started playing last, else the one that reported last. */
  #lead(tabId: string): FrameEntry | null {
    const frames = [...(this.#frames.get(tabId)?.values() ?? [])]
    const playing = frames.filter((f) => f.report.playing).sort((a, b) => b.playingSeq - a.playingSeq)[0]
    return playing ?? frames.sort((a, b) => b.seq - a.seq)[0] ?? null
  }

  /** The lead frame's report, for automatic picture-in-picture. */
  reportOf(tabId: string): PageMediaReport | null {
    return this.#lead(tabId)?.report ?? null
  }

  // ── state ──

  #inputs(win: WindowContext, elsewhere: boolean): MediaTabInput[] {
    const visible = new Set(win.tabs.visibleIds())
    return win.tabs.all().map((tab) => {
      const info = win.tabs.info(tab)
      return {
        id: tab.id,
        title: info.title,
        url: info.url,
        favicon: info.favicon,
        audible: info.audible,
        muted: info.muted,
        visible: visible.has(tab.id),
        elsewhere,
        report: this.reportOf(tab.id),
      }
    })
  }

  #live(): WindowContext[] {
    return this.#deps.windows().filter((w) => !w.window.isDestroyed() && !w.chrome.isDestroyed())
  }

  /** The window's sources: its own tabs, then other windows' on the same session. */
  state(win: WindowContext): MediaHubState {
    if (win.window.isDestroyed()) return EMPTY_MEDIA_STATE
    const tabs = [...this.#inputs(win, false), ...this.#live().filter((w) => w !== win && w.session === win.session).flatMap((w) => this.#inputs(w, true))]
    return mediaHubState(tabs, this.#memory)
  }

  schedule(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => this.flush(), this.#deps.delayMs ?? 80)
    this.#timer.unref?.()
  }

  /** Looks at every tab, then tells each window whose sources changed. */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    const windows = this.#live()
    const all = windows.flatMap((w) => this.#inputs(w, false))
    ;[this.#memory, this.#wasPlaying] = observeMedia(this.#memory, this.#wasPlaying, all)
    for (const id of [...this.#frames.keys()]) if (!all.some((t) => t.id === id)) this.#frames.delete(id)
    for (const id of [...this.#sent.keys()]) if (!windows.some((w) => w.id === id)) this.#sent.delete(id)
    for (const win of windows) {
      const state = this.state(win)
      const json = JSON.stringify(state)
      if (this.#sent.get(win.id) === json) continue
      this.#sent.set(win.id, json)
      // The chrome passes it on to an open now-playing popover (useNowPlayingPopover).
      const event: MediaEvent = { type: 'media', state }
      win.send(event)
    }
  }

  // ── commands ──

  #find(tabId: string): { win: WindowContext; wc: WebContents } | null {
    for (const win of this.#live()) {
      const tab = win.tabs.find(tabId)
      if (tab && !tab.view.webContents.isDestroyed()) return { win, wc: tab.view.webContents }
    }
    return null
  }

  /** Sends a command to the tab's lead frame; false when there is none to send to. */
  #send(tabId: string, command: PageMediaCommand): boolean {
    const lead = this.#lead(tabId)
    if (!lead) return false
    const frame = webFrameMain.fromId(lead.processId, lead.routingId)
    if (!frame || frame.isDestroyed()) return false
    frame.send(PAGE_MEDIA.command, command)
    return true
  }

  async control(tabId: string, command: MediaCommand): Promise<void> {
    const found = this.#find(tabId)
    if (!found) return
    const { win, wc } = found
    switch (command) {
      case 'play':
      case 'pause':
        if (!this.#send(tabId, { kind: command })) {
          await wc.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code: command === 'pause' ? PAUSE_SCRIPT : PLAY_SCRIPT }], true).catch(() => 0)
        }
        if (command === 'pause') this.#memory = { ...this.#memory, held: tabId }
        break
      case 'previous':
      case 'next':
        this.#send(tabId, { kind: 'action', action: command === 'next' ? 'nexttrack' : 'previoustrack' })
        break
      case 'mute':
      case 'unmute':
        win.tabs.setMuted(tabId, command === 'mute')
        break
      case 'dismiss': {
        const dismissed = new Set(this.#memory.dismissed).add(tabId)
        this.#memory = { ...this.#memory, dismissed, held: this.#memory.held === tabId ? null : this.#memory.held }
        break
      }
    }
    this.schedule()
  }

  async setRate(tabId: string, rate: number): Promise<void> {
    const found = this.#find(tabId)
    if (!found) return
    const r = clampRate(rate)
    if (!this.#send(tabId, { kind: 'rate', rate: r })) {
      await found.wc.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code: `(() => { for (const m of document.querySelectorAll('video, audio')) m.playbackRate = ${r} })()` }]).catch(() => undefined)
    }
  }

  /** Into picture-in-picture or out: in the main frame from Apex's own world, in a subframe from the frame's. */
  async pictureInPicture(tabId: string): Promise<boolean> {
    const found = this.#find(tabId)
    if (!found) return false
    const lead = this.#lead(tabId)
    const frame = lead ? webFrameMain.fromId(lead.processId, lead.routingId) : null
    let result: unknown = false
    const main = found.wc.mainFrame
    if (frame && !frame.isDestroyed() && (frame.processId !== main.processId || frame.routingId !== main.routingId)) result = await frame.executeJavaScript(TOGGLE_PIP_SCRIPT, true).catch(() => false)
    else result = await found.wc.executeJavaScriptInIsolatedWorld(PIP_WORLD, [{ code: TOGGLE_PIP_SCRIPT }], true).catch(() => false)
    this.schedule()
    return result === true
  }

  focus(tabId: string): void {
    const found = this.#find(tabId)
    if (!found) return
    const { win } = found
    if (win.window.isMinimized()) win.window.restore()
    win.window.focus()
    win.tabs.activate(tabId)
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}
