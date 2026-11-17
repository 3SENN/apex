/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Debounced autosave with a visible status: saving, saved, or couldn't save
// with a retry. Only the newest value is ever written, and a failed write is
// kept so Retry can send it again.

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface AutosaveOptions<T> {
  save(value: T): Promise<unknown>
  onState(state: SaveState): void
  /** Quiet time after the last change before writing (default 600 ms). */
  delay?: number
  /** How long "saved" shows before going back to idle (default 2 s). */
  savedFor?: number
  timers?: Timers
}

export interface Autosave<T> {
  /** A new value to save once typing pauses. */
  change(value: T): void
  /** Writes any pending value now. Never rejects; failures show as 'error'. */
  flush(): Promise<void>
  /** Writes the value that failed last time. */
  retry(): Promise<void>
  /** Stops timers and writes a pending value, without further state updates. */
  dispose(): void
  readonly state: SaveState
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createAutosave<T>(o: AutosaveOptions<T>): Autosave<T> {
  const delay = o.delay ?? 600
  const savedFor = o.savedFor ?? 2000
  const timers = o.timers ?? realTimers
  let state: SaveState = 'idle'
  let pending: { value: T } | null = null
  let failed: { value: T } | null = null
  let inFlight: Promise<void> | null = null
  let debounce: unknown = null
  let idle: unknown = null
  let disposed = false

  const setState = (next: SaveState): void => {
    if (disposed || next === state) return
    state = next
    o.onState(next)
  }
  const clear = (handle: unknown): null => {
    if (handle !== null) timers.clear(handle)
    return null
  }

  const write = async (value: T): Promise<void> => {
    setState('saving')
    try {
      await o.save(value)
      if (pending) return // a newer value is next; stay on "saving"
      setState('saved')
      idle = clear(idle)
      idle = timers.set(() => {
        if (state === 'saved') setState('idle')
      }, savedFor)
    } catch {
      // A newer value replaces the one that failed.
      if (pending) return
      failed = { value }
      setState('error')
    }
  }

  const flush = async (): Promise<void> => {
    debounce = clear(debounce)
    for (;;) {
      if (inFlight) {
        await inFlight
        continue
      }
      if (!pending) return
      const { value } = pending
      pending = null
      inFlight = write(value).finally(() => {
        inFlight = null
      })
    }
  }

  return {
    get state() {
      return state
    },
    change(value) {
      pending = { value }
      failed = null
      idle = clear(idle)
      debounce = clear(debounce)
      if (disposed) return
      debounce = timers.set(() => void flush(), delay)
    },
    flush,
    retry() {
      if (failed && !pending) pending = failed
      failed = null
      return flush()
    },
    dispose() {
      debounce = clear(debounce)
      idle = clear(idle)
      disposed = true
      if (pending) void flush()
    },
  }
}
