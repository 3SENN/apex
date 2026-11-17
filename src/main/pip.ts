/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents } from 'electron'
import { autoPipEligible } from '@shared/media'
import { mediaReportOf } from './media/registry'
import type { Tab, TabManager } from './tabs'

// Automatic picture-in-picture (ST-29). Leaving a tab while a video plays
// with sound moves it into the floating player; coming back returns it.
// Clicking another app leaves the video as it is (a video in full screen
// stays in full screen): only the person takes it out. The scripts run in an isolated world (they share
// the DOM, not the page's script) with a user gesture, which the browser
// requires for requestPictureInPicture. MD-02: with the media hub's report for
// the tab, a video playing with its sound on qualifies even in a quiet passage,
// and audio alone or muted autoplay doesn't (autoPipEligible, shared/media.ts).

/** Apex's isolated world for picture-in-picture (999 is page full screen, 1005 the media card). */
export const PIP_WORLD = 1004

/** Picks a video that is playing with sound and allows picture-in-picture; muted autoplay is skipped. */
export const ENTER_PIP_SCRIPT = `(async () => {
  if (document.pictureInPictureElement || !document.pictureInPictureEnabled) return false
  const video = Array.from(document.querySelectorAll('video')).find((v) => !v.paused && !v.ended && !v.muted && v.volume > 0 && v.readyState >= 2 && v.videoWidth > 0 && !v.disablePictureInPicture)
  if (!video) return false
  try { await video.requestPictureInPicture(); return true } catch { return false }
})()`

export const EXIT_PIP_SCRIPT = `(async () => {
  if (!document.pictureInPictureElement) return false
  try { await document.exitPictureInPicture(); return true } catch { return false }
})()`

export interface PipCandidate {
  audible: boolean
  muted: boolean
  agentControlled: boolean
  chromeDrawn: boolean
}

/** Only a page playing with sound, never an agent-controlled tab or a chrome-drawn page. */
export function pipEligible(tab: PipCandidate, enabled: boolean): boolean {
  return enabled && tab.audible && !tab.muted && !tab.agentControlled && !tab.chromeDrawn
}

export class AutoPip {
  readonly #tabs: TabManager
  readonly #enabled: () => boolean
  /** Tabs Apex moved into picture-in-picture, so only those come back. */
  readonly #entered = new Set<string>()
  #lastActive: string | null = null
  readonly #off: (() => void)[] = []

  constructor({ tabs, enabled }: { tabs: TabManager; enabled(): boolean }) {
    this.#tabs = tabs
    this.#enabled = enabled
    this.#lastActive = tabs.activeId()
    const onActivated = (tab: Tab): void => {
      const previous = this.#lastActive
      this.#lastActive = tab.id
      if (previous && previous !== tab.id && !this.#inSplit(previous)) void this.#enter(previous)
      void this.#exit(tab.id)
    }
    const onClosed = (tab: Tab): void => {
      this.#entered.delete(tab.id)
    }
    tabs.on('activated', onActivated)
    tabs.on('closed', onClosed)
    this.#off.push(
      () => tabs.off('activated', onActivated),
      () => tabs.off('closed', onClosed),
    )
  }

  dispose(): void {
    for (const off of this.#off.splice(0)) off()
  }

  #inSplit(id: string): boolean {
    const split = this.#tabs.split()
    return split !== null && (split.primaryId === id || split.secondaryId === id) && this.#tabs.activeId() !== null && (split.primaryId === this.#tabs.activeId() || split.secondaryId === this.#tabs.activeId())
  }

  #page(id: string): WebContents | null {
    const tab = this.#tabs.find(id)
    if (!tab || tab.view.webContents.isDestroyed()) return null
    return tab.view.webContents
  }

  async #enter(id: string): Promise<void> {
    const tab = this.#tabs.find(id)
    const wc = this.#page(id)
    if (!tab || !wc) return
    const eligible = autoPipEligible({
      enabled: this.#enabled(),
      audible: wc.isCurrentlyAudible(),
      tabMuted: wc.isAudioMuted(),
      agentControlled: tab.agentControlled,
      chromeDrawn: this.#tabs.isChromeDrawn(tab),
      report: mediaReportOf(id),
    })
    if (!eligible) return
    const entered = await wc.executeJavaScriptInIsolatedWorld(PIP_WORLD, [{ code: ENTER_PIP_SCRIPT }], true).catch(() => false)
    if (entered === true) this.#entered.add(id)
  }

  async #exit(id: string): Promise<void> {
    if (!this.#entered.delete(id)) return
    const wc = this.#page(id)
    if (wc) await wc.executeJavaScriptInIsolatedWorld(PIP_WORLD, [{ code: EXIT_PIP_SCRIPT }], true).catch(() => false)
  }
}
