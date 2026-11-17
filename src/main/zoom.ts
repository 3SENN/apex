/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './settings'

// Page zoom (SH-45): 10% steps from 25% to 500%, remembered per
// host in zoom.json and applied to every tab on that host. Private sessions
// keep it in memory only. Apex pages never come here: their keys go to
// the interface zoom (uiZoom.ts).

export const ZOOM_MIN = 25
export const ZOOM_MAX = 500
export const ZOOM_STEP = 10
export const ZOOM_DEFAULT = 100

/** The next level from `percent`: snaps onto the 10% grid, then steps, within 25–500%. */
export function stepZoom(percent: number, delta: 1 | -1): number {
  const current = Number.isFinite(percent) ? percent : ZOOM_DEFAULT
  const next = delta > 0 ? Math.floor(current / ZOOM_STEP) * ZOOM_STEP + ZOOM_STEP : Math.ceil(current / ZOOM_STEP) * ZOOM_STEP - ZOOM_STEP
  return clampZoom(next)
}

export function clampZoom(percent: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent)))
}

/** The key a page's zoom is saved under: its host for web pages, 'file' for local files; null for anything else. */
export function zoomKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.hostname.toLowerCase() || null
    if (parsed.protocol === 'file:') return 'file'
    return null
  } catch {
    return null
  }
}

const KEYS_MAX = 2000

/** Per-host zoom levels; a level of 100% is not stored. `path` null keeps them in memory (private windows). */
export class ZoomStore {
  readonly #path: string | null
  readonly #levels = new Map<string, number>()

  constructor(path: string | null) {
    this.#path = path
    if (!path) return
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const hosts = raw && typeof raw === 'object' && 'hosts' in raw ? (raw as { hosts: unknown }).hosts : raw
      if (hosts && typeof hosts === 'object') {
        for (const [host, level] of Object.entries(hosts as Record<string, unknown>)) {
          if (typeof level === 'number' && Number.isFinite(level) && host.length <= 253) this.#levels.set(host, clampZoom(level))
        }
      }
    } catch {
      // First run, or an unreadable file: every site at 100%.
    }
  }

  static forDataDir(dataDir: string): ZoomStore {
    return new ZoomStore(join(dataDir, 'zoom.json'))
  }

  get persistent(): boolean {
    return this.#path !== null
  }

  get(key: string): number {
    return this.#levels.get(key) ?? ZOOM_DEFAULT
  }

  set(key: string, percent: number): void {
    const level = clampZoom(percent)
    if (level === ZOOM_DEFAULT) this.#levels.delete(key)
    else {
      this.#levels.delete(key)
      this.#levels.set(key, level)
      // The oldest change goes first when the list grows past its cap.
      while (this.#levels.size > KEYS_MAX) this.#levels.delete(this.#levels.keys().next().value as string)
    }
    this.#save()
  }

  entries(): Array<[string, number]> {
    return [...this.#levels]
  }

  clear(): void {
    this.#levels.clear()
    this.#save()
  }

  #save(): void {
    if (this.#path) writeAtomic(this.#path, JSON.stringify({ version: 1, hosts: Object.fromEntries(this.#levels) }, null, 2))
  }
}
