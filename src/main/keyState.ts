/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoreEvent } from '@shared/services/core'

// Key state. Held keys and taps that no accelerator can
// express: ⌘ held for about 300 ms shows the 1–8 tab hints, a quick ⌃Tab tap
// flips to the previous tab, and holding ⌃ over ⌃Tab for about 150 ms opens
// the recent-tabs switcher (open, step, commit, cancel). Edge reveal polls
// the cursor every 40 ms, and only while the sidebar is hidden. Timers and
// the cursor are injected so the rules are unit-tested.

export const NUMBER_HINTS_MS = 300
export const RECENT_TABS_HOLD_MS = 150
export const EDGE_POLL_MS = 40
/** The pointer counts as at the edge within this many window px of it. */
export const EDGE_ZONE_PX = 6
/**
 * And from this far outside it: a window short of the screen's edge (a gap of
 * a few px to a few dozen) still reveals when the pointer stops at the screen's
 * edge, instead of asking for a 6 px strip inside the window.
 */
export const EDGE_OUTSIDE_PX = 32

export interface KeyTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realTimers: KeyTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** The part of Electron's Input the machine reads. */
export interface KeyInput {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat?: boolean
}

type KeyEvent = Extract<CoreEvent, { type: 'number-hints' | 'recent-tabs' }>

export interface KeyStateHooks {
  emit(event: KeyEvent): void
  /** A quick ⌃Tab tap: 1 flips to the previous tab, -1 (⌃⇧Tab) steps back one. */
  tap(delta: 1 | -1): void
}

export class KeyStateMachine {
  readonly #hooks: KeyStateHooks
  readonly #timers: KeyTimers
  readonly #mac: boolean
  #hintTimer: unknown = null
  #hints = false
  #recent: 'idle' | 'pending' | 'open' = 'idle'
  #recentDelta: 1 | -1 = 1
  #recentTimer: unknown = null

  constructor(hooks: KeyStateHooks, opts: { platform?: string; timers?: KeyTimers } = {}) {
    this.#hooks = hooks
    this.#timers = opts.timers ?? realTimers
    this.#mac = (opts.platform ?? process.platform) === 'darwin'
  }

  get hintsShown(): boolean {
    return this.#hints
  }

  get switcher(): 'idle' | 'pending' | 'open' {
    return this.#recent
  }

  /** Feeds one key event; true when the machine consumed it (the router then calls preventDefault). */
  input(i: KeyInput): boolean {
    const consumed = this.#recentInput(i)
    this.#hintInput(i)
    return consumed
  }

  /** The window lost focus: hints hide and an open switcher cancels. */
  blur(): void {
    this.#stopHints()
    this.#clearRecentTimer()
    if (this.#recent === 'open') this.#hooks.emit({ type: 'recent-tabs', phase: 'cancel', delta: this.#recentDelta })
    this.#recent = 'idle'
  }

  dispose(): void {
    this.blur()
  }

  // ---- ⌘ hold: number hints ----

  #hintInput(i: KeyInput): void {
    const modifierKey = this.#mac ? 'Meta' : 'Control'
    const held = this.#mac ? i.meta : i.control
    if (i.type === 'keyDown' && i.key === modifierKey) {
      if (i.isAutoRepeat || this.#hintTimer !== null || this.#hints) return
      // Only a bare ⌘: another modifier already down means a chord is coming.
      const others = this.#mac ? i.control || i.alt || i.shift : i.meta || i.alt || i.shift
      if (others) return
      this.#hintTimer = this.#timers.set(() => {
        this.#hintTimer = null
        this.#hints = true
        this.#hooks.emit({ type: 'number-hints', show: true })
      }, NUMBER_HINTS_MS)
      return
    }
    if (i.type === 'keyUp' && i.key === modifierKey) {
      this.#stopHints()
      return
    }
    // Any other key (⌘1 included) hides them; so does the modifier going away unseen.
    if (i.type === 'keyDown' || !held) this.#stopHints()
  }

  #stopHints(): void {
    if (this.#hintTimer !== null) this.#timers.clear(this.#hintTimer)
    this.#hintTimer = null
    if (this.#hints) {
      this.#hints = false
      this.#hooks.emit({ type: 'number-hints', show: false })
    }
  }

  // ---- ⌃Tab: tap flips, hold opens the switcher ----

  #recentInput(i: KeyInput): boolean {
    const isTab = i.key === 'Tab' && i.control && !i.meta && !i.alt
    if (i.type === 'keyDown' && isTab) {
      const delta: 1 | -1 = i.shift ? -1 : 1
      if (this.#recent === 'idle') {
        this.#recent = 'pending'
        this.#recentDelta = delta
        this.#recentTimer = this.#timers.set(() => {
          this.#recentTimer = null
          if (this.#recent !== 'pending') return
          this.#recent = 'open'
          this.#hooks.emit({ type: 'recent-tabs', phase: 'open', delta: this.#recentDelta })
        }, RECENT_TABS_HOLD_MS)
      } else if (this.#recent === 'pending') {
        // A second Tab before the hold time: the switcher opens now and steps.
        this.#clearRecentTimer()
        this.#recent = 'open'
        this.#hooks.emit({ type: 'recent-tabs', phase: 'open', delta: this.#recentDelta })
        this.#hooks.emit({ type: 'recent-tabs', phase: 'step', delta })
      } else {
        this.#hooks.emit({ type: 'recent-tabs', phase: 'step', delta })
      }
      return true
    }
    if (this.#recent === 'idle') return false
    if (i.type === 'keyDown' && i.key === 'Escape') {
      this.#clearRecentTimer()
      if (this.#recent === 'open') this.#hooks.emit({ type: 'recent-tabs', phase: 'cancel', delta: this.#recentDelta })
      this.#recent = 'idle'
      return true
    }
    if (i.type === 'keyUp' && i.key === 'Control') {
      this.#clearRecentTimer()
      const was = this.#recent
      this.#recent = 'idle'
      if (was === 'open') this.#hooks.emit({ type: 'recent-tabs', phase: 'commit', delta: this.#recentDelta })
      else this.#hooks.tap(this.#recentDelta)
      return false
    }
    // Shift going down or up between Tabs is part of the gesture.
    if (i.key === 'Shift') return false
    return false
  }

  #clearRecentTimer(): void {
    if (this.#recentTimer !== null) this.#timers.clear(this.#recentTimer)
    this.#recentTimer = null
  }
}

// ---- edge reveal ----

export interface EdgeRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Whether the pointer is at the window's left edge: from EDGE_OUTSIDE_PX
 * outside it to EDGE_ZONE_PX inside. Once active it stays so until the
 * pointer leaves the band `exitWidth` px wide (the revealed sidebar).
 */
export function edgeActive(cursor: { x: number; y: number }, content: EdgeRect, wasActive: boolean, exitWidth: number): boolean {
  const insideY = cursor.y >= content.y && cursor.y < content.y + content.height
  if (!insideY) return false
  const dx = cursor.x - content.x
  if (dx < -EDGE_OUTSIDE_PX) return false
  return wasActive ? dx <= exitWidth : dx <= EDGE_ZONE_PX
}

export interface EdgePollDeps {
  cursor(): { x: number; y: number }
  content(): EdgeRect | null
  /** How wide the revealed sidebar is, so moving onto it keeps the reveal. */
  exitWidth(): number
  emit(active: boolean): void
  every?(fn: () => void, ms: number): () => void
}

/** Polls only while `setPolling(true)` (the sidebar is hidden and the window focused). */
export class EdgeRevealPoller {
  readonly #deps: EdgePollDeps
  #stop: (() => void) | null = null
  #active = false
  #atEdge = false

  constructor(deps: EdgePollDeps) {
    this.#deps = deps
  }

  get polling(): boolean {
    return this.#stop !== null
  }

  setPolling(on: boolean): void {
    if (on && !this.#stop) {
      const every =
        this.#deps.every ??
        ((fn: () => void, ms: number) => {
          const t = setInterval(fn, ms)
          return () => clearInterval(t)
        })
      this.#stop = every(() => this.tick(), EDGE_POLL_MS)
    } else if (!on && this.#stop) {
      this.#stop()
      this.#stop = null
      this.#atEdge = false
      this.#set(false)
    }
  }

  tick(): void {
    const content = this.#deps.content()
    if (!content) {
      this.#atEdge = false
      return this.#set(false)
    }
    const cursor = this.#deps.cursor()
    const atEdge = edgeActive(cursor, content, false, 0)
    // Back at the edge while still active asks again: the reveal may have gone in between (a click on the
    // page, Escape, the pointer just past the sidebar). One that is still open ignores it.
    if (atEdge && !this.#atEdge && this.#active) this.#deps.emit(true)
    this.#atEdge = atEdge
    this.#set(edgeActive(cursor, content, this.#active, this.#deps.exitWidth()))
  }

  dispose(): void {
    this.setPolling(false)
  }

  #set(active: boolean): void {
    if (active === this.#active) return
    this.#active = active
    this.#deps.emit(active)
  }
}
