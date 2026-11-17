/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The card shows one floating save pill for all of its fields (the big name,
// the instructions, the personality, the Dock toggle and the look). Each
// field reports here; the pill shows the most urgent state, and closing or
// switching the card flushes every pending write first.

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const RANK: Record<SaveState, number> = { idle: 0, saved: 1, saving: 2, error: 3 }

/** Error beats saving beats saved beats idle. */
export function combineSaves(states: Iterable<SaveState>): SaveState {
  let best: SaveState = 'idle'
  for (const s of states) if (RANK[s] > RANK[best]) best = s
  return best
}

export interface SaveEntry {
  state: SaveState
  retry?: () => void
  /** Writes a pending change now. */
  flush?: () => Promise<void>
}

export interface SaveSummary {
  state: SaveState
  /** Retries every field whose last write failed. */
  retry: (() => void) | null
  /** A long action in progress ("Duplicating…"), shown in the same pill. */
  busy: string | null
}

export interface SaveRegistry {
  report(key: string, entry: SaveEntry | null): void
  setBusy(label: string | null): void
  summary(): SaveSummary
  /** Flushes every field, giving up after `timeoutMs` so a stuck write never traps the card. */
  flushAll(timeoutMs?: number): Promise<void>
  subscribe(listener: () => void): () => void
}

export function createSaveRegistry(): SaveRegistry {
  const entries = new Map<string, SaveEntry>()
  const listeners = new Set<() => void>()
  let busy: string | null = null
  let cached: SaveSummary | null = null
  const emit = (): void => {
    cached = null
    listeners.forEach((l) => l())
  }
  return {
    report(key, entry) {
      const before = entries.get(key)
      if (entry === null) {
        if (!before) return
        entries.delete(key)
      } else {
        entries.set(key, entry)
        // Fresh callbacks with the same state change nothing on screen.
        if (before && before.state === entry.state && !!before.retry === !!entry.retry) return
      }
      emit()
    },
    setBusy(label) {
      if (label === busy) return
      busy = label
      emit()
    },
    summary() {
      if (cached) return cached
      const state = combineSaves([...entries.values()].map((e) => e.state))
      const canRetry = [...entries.values()].some((e) => e.state === 'error' && e.retry)
      // Reads the entries when pressed, so it always calls the newest callbacks.
      const retry = (): void => [...entries.values()].forEach((e) => e.state === 'error' && e.retry?.())
      cached = { state, busy, retry: canRetry ? retry : null }
      return cached
    },
    async flushAll(timeoutMs = 1500) {
      const jobs = [...entries.values()].map((e) => e.flush?.().catch(() => undefined))
      await Promise.race([Promise.all(jobs), new Promise((resolve) => setTimeout(resolve, timeoutMs))])
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Parses a CSS time ("240ms", "0.16s", "0s"), or null if it isn't one. */
export function parseDuration(text: string | null | undefined): number | null {
  const m = /^\s*(-?[\d.]+)(ms|s)\s*$/i.exec(text ?? '')
  if (!m) return null
  const n = parseFloat(m[1]!)
  if (!Number.isFinite(n)) return null
  return Math.max(0, m[2]!.toLowerCase() === 's' ? n * 1000 : n)
}
