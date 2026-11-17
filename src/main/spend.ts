/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { spendMonth, type SpendView } from '@shared/pricing'
import { writeAtomic } from './settings'
import { readJson } from './stores'

// This month's spend on your own key (DS-18): each finished turn adds its
// cost. The file holds one month; a new month starts again from zero.

interface SpendFile {
  month: string
  usd: number
}

export class SpendStore extends EventEmitter<{ changed: [view: Omit<SpendView, 'budgetUsd'>] }> {
  readonly #file: string
  readonly #now: () => number
  #state: SpendFile

  constructor(dataDir: string, now: () => number = Date.now) {
    super()
    this.#file = join(dataDir, 'spend.json')
    this.#now = now
    const raw = readJson(this.#file) as Partial<SpendFile> | null
    const valid = raw && typeof raw.month === 'string' && /^\d{4}-\d{2}$/.test(raw.month) && typeof raw.usd === 'number' && Number.isFinite(raw.usd) && raw.usd >= 0
    this.#state = valid ? { month: raw.month as string, usd: raw.usd as number } : { month: spendMonth(now()), usd: 0 }
  }

  /** Adds a turn's cost (ignored when not a positive number). */
  add(usd: number): void {
    if (!(usd > 0) || !Number.isFinite(usd)) return
    this.#roll()
    this.#state = { ...this.#state, usd: this.#state.usd + usd }
    try {
      writeAtomic(this.#file, JSON.stringify(this.#state))
    } catch (err) {
      console.warn('Could not save the spend total:', err)
    }
    this.emit('changed', this.view())
  }

  view(): Omit<SpendView, 'budgetUsd'> {
    this.#roll()
    return { month: this.#state.month, usd: Math.round(this.#state.usd * 10_000) / 10_000 }
  }

  #roll(): void {
    const month = spendMonth(this.#now())
    if (month !== this.#state.month) this.#state = { month, usd: 0 }
  }
}
