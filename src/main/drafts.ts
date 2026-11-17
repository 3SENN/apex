/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { log } from './log'
import { writeAtomic } from './settings'
import { readJson } from './stores'

// Unsent composer text per chat, kept on disk so it survives a chrome
// reload, a restart and the hand-over between the panel and a chat page.
// Writes are debounced; the chrome debounces its calls too.

const DRAFT_MAX = 20_000
const DRAFTS_MAX = 500
const WRITE_DELAY_MS = 500
const CHAT_ID = /^[0-9a-f-]{36}$/

export class DraftStore {
  readonly #file: string
  readonly #drafts = new Map<string, { text: string; at: number }>()
  #timer: NodeJS.Timeout | null = null

  constructor(dataDir: string, readonly delayMs = WRITE_DELAY_MS) {
    this.#file = join(dataDir, 'chats', 'drafts.json')
    const raw = readJson(this.#file)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = value as { text?: unknown; at?: unknown } | null
        if (CHAT_ID.test(id) && typeof entry?.text === 'string' && entry.text) {
          this.#drafts.set(id, { text: entry.text.slice(0, DRAFT_MAX), at: typeof entry.at === 'number' ? entry.at : 0 })
        }
      }
    }
  }

  get(id: string): string {
    return this.#drafts.get(id)?.text ?? ''
  }

  set(id: string, text: string, now = Date.now()): void {
    const clean = text.slice(0, DRAFT_MAX)
    const known = this.#drafts.get(id)?.text ?? ''
    if (clean === known) return
    if (clean.trim()) this.#drafts.set(id, { text: clean, at: now })
    else this.#drafts.delete(id)
    this.#trim()
    this.#schedule()
  }

  /** Chats that were deleted lose their drafts. */
  remove(ids: readonly string[]): void {
    let changed = false
    for (const id of ids) changed = this.#drafts.delete(id) || changed
    if (changed) this.#schedule()
  }

  /** Writes now (on quit). */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    try {
      writeAtomic(this.#file, JSON.stringify(Object.fromEntries(this.#drafts)))
    } catch (err) {
      log.warn('drafts', 'Could not save composer drafts', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  #trim(): void {
    if (this.#drafts.size <= DRAFTS_MAX) return
    const oldest = [...this.#drafts.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [id] of oldest.slice(0, this.#drafts.size - DRAFTS_MAX)) this.#drafts.delete(id)
  }

  #schedule(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => this.flush(), this.delayMs)
    this.#timer.unref?.()
  }
}
