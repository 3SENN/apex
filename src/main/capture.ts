/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { NO_CAPTURE, type CaptureKind, type CaptureState } from '@shared/sites'

// What each tab is capturing, for TabInfo.capture, the tab
// icons the tab strip draws and the sharing bar. Main's own record is the floor: a kind
// is on from the moment Apex grants it until the page navigates, closes or
// the person stops it. The page trackers (preload/page/capture.ts, one per
// document in every frame) then narrow it to the tracks still live, so a call
// that ends in a single-page app clears its icon. Narrowing fails visible: a
// kind goes off only once the trackers have seen every capture Apex granted
// and saw each of its tracks (clones too) end. A capture no tracker saw (a
// frame without one, an API it doesn't wrap) keeps the icon on, and Stop
// reloads the page to end it. No Electron here, so it is unit-tested.

const KINDS: readonly CaptureKind[] = ['camera', 'microphone', 'screen']

export type CaptureCounts = Record<CaptureKind, number>

/** One document's tracker report. */
export interface CaptureReport {
  /** The document's id, made in the isolated world where pages can't reach it. */
  doc: string
  /** The frame it lives in: a new document there means the old one's tracks ended. */
  frame: string
  /** Captures the tracker saw handed out since the document loaded. */
  seen: CaptureCounts
  /** Tracks (and clones) it holds that haven't ended. */
  live: CaptureCounts
  /** The document is going away (its pagehide): its tracks end with it. */
  gone: boolean
}

interface DocCapture {
  frame: string
  seen: CaptureCounts
  live: CaptureCounts
  gone: boolean
}

interface TabCapture {
  granted: CaptureState
  /** Captures Apex granted per kind since the kind last turned on. */
  grants: CaptureCounts
  /** What the trackers had seen when each kind last turned on; only later sightings answer for its grants. */
  base: CaptureCounts
  docs: Map<string, DocCapture>
  /** The tab whose content this tab is sharing, if it shares a tab. */
  sharedTabId: string | null
}

const zero = (): CaptureCounts => ({ camera: 0, microphone: 0, screen: 0 })

export class CaptureTracker extends EventEmitter<{ changed: [tabId: string] }> {
  readonly #tabs = new Map<string, TabCapture>()

  #entry(tabId: string): TabCapture {
    let entry = this.#tabs.get(tabId)
    if (!entry) {
      entry = { granted: { ...NO_CAPTURE }, grants: zero(), base: zero(), docs: new Map(), sharedTabId: null }
      this.#tabs.set(tabId, entry)
    }
    return entry
  }

  /** Apex granted these kinds to the tab (a camera or microphone answer, or a source chosen in the screen picker). */
  grant(tabId: string, kinds: readonly CaptureKind[], sharedTabId: string | null = null): void {
    const entry = this.#entry(tabId)
    for (const kind of kinds) {
      if (!entry.granted[kind]) {
        entry.granted[kind] = true
        entry.grants[kind] = 0
        entry.base[kind] = seenTotal(entry, kind)
      }
      // Counts as live until a tracker reports seeing it.
      entry.grants[kind]++
    }
    if (kinds.includes('screen')) entry.sharedTabId = sharedTabId
    this.emit('changed', tabId)
  }

  /** A page tracker's report for one document of the tab. */
  report(tabId: string, r: CaptureReport): void {
    const entry = this.#entry(tabId)
    const before = this.state(tabId)
    const doc = entry.docs.get(r.doc)
    // A document that went away stays gone, whatever arrives after.
    if (doc?.gone) return
    for (const [id, other] of entry.docs) if (id !== r.doc && other.frame === r.frame) other.live = zero()
    const seen = zero()
    for (const kind of KINDS) seen[kind] = Math.max(doc?.seen[kind] ?? 0, r.seen[kind])
    entry.docs.set(r.doc, { frame: r.frame, seen, live: r.gone ? zero() : { ...r.live }, gone: r.gone })
    if (!this.state(tabId).screen) entry.sharedTabId = null
    if (!sameState(before, this.state(tabId))) this.emit('changed', tabId)
  }

  /** Ends these kinds (Stop, revoke), or the whole page's record when none are named (navigation, close, crash). */
  clear(tabId: string, kinds?: readonly CaptureKind[]): void {
    const entry = this.#tabs.get(tabId)
    if (!entry) return
    const before = this.state(tabId)
    if (!kinds) this.#tabs.delete(tabId)
    else {
      for (const kind of kinds) {
        entry.granted[kind] = false
        entry.grants[kind] = 0
        entry.base[kind] = seenTotal(entry, kind)
      }
      if (kinds.includes('screen')) entry.sharedTabId = null
    }
    if (!sameState(before, this.state(tabId))) this.emit('changed', tabId)
  }

  state(tabId: string): CaptureState {
    const entry = this.#tabs.get(tabId)
    if (!entry) return { ...NO_CAPTURE }
    const on = (kind: CaptureKind): boolean => entry.granted[kind] && (unseen(entry, kind) > 0 || liveTotal(entry, kind) > 0)
    return { camera: on('camera'), microphone: on('microphone'), screen: on('screen') }
  }

  /** Whether a granted capture of these kinds was never seen by a tracker, so only a reload can be sure to end it. */
  untracked(tabId: string, kinds: readonly CaptureKind[]): boolean {
    const entry = this.#tabs.get(tabId)
    return !!entry && kinds.some((k) => entry.granted[k] && unseen(entry, k) > 0)
  }

  /** Whether the trackers still hold live tracks of these kinds (the page ignored Stop). */
  holds(tabId: string, kinds: readonly CaptureKind[]): boolean {
    const entry = this.#tabs.get(tabId)
    return !!entry && kinds.some((k) => liveTotal(entry, k) > 0)
  }

  /** Whether any tracker has reported for this tab since its page loaded. */
  reported(tabId: string): boolean {
    return (this.#tabs.get(tabId)?.docs.size ?? 0) > 0
  }

  /** The tab this one is sharing, while it shares one. */
  sharedTab(tabId: string): string | null {
    return this.state(tabId).screen ? (this.#tabs.get(tabId)?.sharedTabId ?? null) : null
  }

  /** A shared tab stays awake (tab sleeping skips it) until the capture of it ends. */
  isShared(tabId: string): boolean {
    for (const [id, entry] of this.#tabs) if (entry.sharedTabId === tabId && this.state(id).screen) return true
    return false
  }

  /** Tabs capturing anything right now. */
  active(): string[] {
    return [...this.#tabs.keys()].filter((id) => anyCapture(this.state(id)))
  }
}

function seenTotal(entry: TabCapture, kind: CaptureKind): number {
  let n = 0
  for (const doc of entry.docs.values()) n += doc.seen[kind]
  return n
}

function liveTotal(entry: TabCapture, kind: CaptureKind): number {
  let n = 0
  for (const doc of entry.docs.values()) n += doc.live[kind]
  return n
}

/** Granted captures no tracker has answered for yet. */
function unseen(entry: TabCapture, kind: CaptureKind): number {
  return entry.grants[kind] - (seenTotal(entry, kind) - entry.base[kind])
}

export function anyCapture(s: CaptureState): boolean {
  return s.camera || s.microphone || s.screen
}

function sameState(a: CaptureState, b: CaptureState): boolean {
  return a.camera === b.camera && a.microphone === b.microphone && a.screen === b.screen
}

/** The app-wide tracker (TabInfo decorators in every window read it). */
export const captureTracker = new CaptureTracker()
