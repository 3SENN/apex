/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The updater's clock: timers and "now" behind one seam, so the machine,
// the backoff, the schedule and the install watchdog run on a fake clock in
// tests and smoke (a 16-minute backoff takes no time there).

export type TimerHandle = { readonly id: number }

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle | null): void
}

let nextId = 1

/** Real time. */
export function systemClock(): Clock {
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const handle = { id: nextId++ }
      const timer = setTimeout(() => {
        timers.delete(handle.id)
        fn()
      }, ms)
      // Never keep the process alive just for an update check.
      timer.unref?.()
      timers.set(handle.id, timer)
      return handle
    },
    clearTimeout(handle) {
      if (!handle) return
      clearTimeout(timers.get(handle.id))
      timers.delete(handle.id)
    },
  }
}

/** A clock that moves only when told to; due timers fire in time order. */
export class ManualClock implements Clock {
  #now: number
  readonly #timers = new Map<number, { at: number; fn: () => void }>()

  constructor(start = Date.UTC(2026, 9, 29, 9, 0, 0)) {
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = { id: nextId++ }
    this.#timers.set(handle.id, { at: this.#now + Math.max(0, ms), fn })
    return handle
  }

  clearTimeout(handle: TimerHandle | null): void {
    if (handle) this.#timers.delete(handle.id)
  }

  /** How many timers are waiting. */
  get pending(): number {
    return this.#timers.size
  }

  /** The time the next timer is due, or null. */
  nextAt(): number | null {
    let next: number | null = null
    for (const t of this.#timers.values()) if (next === null || t.at < next) next = t.at
    return next
  }

  /** Moves time forward, firing each due timer at its own time (timers set while firing count too). */
  advance(ms: number): void {
    const until = this.#now + ms
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null
      for (const entry of this.#timers) if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry
      if (!due) break
      this.#timers.delete(due[0])
      this.#now = Math.max(this.#now, due[1].at)
      due[1].fn()
    }
    this.#now = until
  }
}
