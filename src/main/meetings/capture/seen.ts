/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { log } from '../../log'

// Which meetings already had their card (MV-09): each meeting key (or
// calendar event) triggers it once, and keys are forgotten after 7 days so
// the file stays small. Private windows keep their keys in memory only, so
// no trace of a private meeting reaches the disk.

export const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SEEN_MAX = 500

/** Drops keys older than the TTL, then the oldest beyond the cap. Pure. */
export function pruneSeen(entries: Record<string, number>, now: number): Record<string, number> {
  const kept = Object.entries(entries)
    .filter(([key, at]) => typeof key === 'string' && Number.isFinite(at) && now - at < SEEN_TTL_MS && at <= now + 60_000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEEN_MAX)
  return Object.fromEntries(kept)
}

export class SeenKeys {
  readonly #path: string | null
  #saved: Record<string, number> = {}
  readonly #memory = new Map<string, number>()

  /** `path` null keeps everything in memory (tests). */
  constructor(path: string | null, now = Date.now()) {
    this.#path = path
    if (!path) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.#saved = pruneSeen(raw as Record<string, number>, now)
    } catch {
      // No file yet, or an unreadable one: start empty.
    }
  }

  has(key: string, now = Date.now()): boolean {
    const at = this.#saved[key] ?? this.#memory.get(key)
    return at !== undefined && now - at < SEEN_TTL_MS
  }

  add(key: string, options: { private?: boolean; now?: number } = {}): void {
    const now = options.now ?? Date.now()
    if (options.private || !this.#path) {
      this.#memory.set(key, now)
      return
    }
    this.#saved = pruneSeen({ ...this.#saved, [key]: now }, now)
    this.#write()
  }

  #write(): void {
    if (!this.#path) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temp = `${this.#path}.tmp`
      writeFileSync(temp, JSON.stringify(this.#saved), { mode: 0o600 })
      renameSync(temp, this.#path)
    } catch (err) {
      log.warn('meeting-capture', 'Saving the seen meetings failed', { error: String(err) })
    }
  }
}
