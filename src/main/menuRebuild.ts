/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// When the native menus rebuild (SH-59): debounced, so a burst of state
// changes costs one rebuild, and deferred while any menu is open, because
// replacing the application menu under an open menu closes it on macOS.
// No Electron here, so it is unit-tested with fake timers.

export interface RebuildTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: RebuildTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class RebuildScheduler {
  readonly #build: () => void
  readonly #delayMs: number
  readonly #timers: RebuildTimers
  readonly #maxDeferMs: number
  #timer: unknown = null
  #guard: unknown = null
  #open = 0
  #dirty = false

  /** `maxDeferMs` caps a deferral, in case a menu's close event never arrives. */
  constructor(build: () => void, delayMs = 100, timers: RebuildTimers = realTimers, maxDeferMs = 15_000) {
    this.#build = build
    this.#delayMs = delayMs
    this.#timers = timers
    this.#maxDeferMs = maxDeferMs
  }

  /** Asks for a rebuild; several in a row cost one. */
  request(): void {
    if (this.#open > 0) {
      this.#dirty = true
      this.#armGuard()
      return
    }
    if (this.#timer !== null) return
    this.#timer = this.#timers.set(() => {
      this.#timer = null
      if (this.#open > 0) {
        this.#dirty = true
        this.#armGuard()
        return
      }
      this.#dirty = false
      this.#build()
    }, this.#delayMs)
  }

  menuOpened(): void {
    this.#open++
  }

  menuClosed(): void {
    this.#open = Math.max(0, this.#open - 1)
    if (this.#open === 0 && this.#guard !== null) {
      this.#timers.clear(this.#guard)
      this.#guard = null
    }
    if (this.#open === 0 && this.#dirty) {
      this.#dirty = false
      this.request()
    }
  }

  get menuOpen(): boolean {
    return this.#open > 0
  }

  dispose(): void {
    if (this.#timer !== null) this.#timers.clear(this.#timer)
    if (this.#guard !== null) this.#timers.clear(this.#guard)
    this.#timer = null
    this.#guard = null
  }

  #armGuard(): void {
    if (this.#guard !== null) return
    this.#guard = this.#timers.set(() => {
      this.#guard = null
      if (this.#open === 0) return
      // A lost close event must not freeze the menus for the rest of the run.
      this.#open = 0
      this.menuClosed()
    }, this.#maxDeferMs)
  }
}
