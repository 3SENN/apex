/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomBytes } from 'node:crypto'

// Viewer tokens: each open document gets an opaque token that names it
// in later calls and in apex-file://<token>/ URLs. A token belongs to the tab
// that shows it and expires with that tab; tokens without a tab (quick look)
// expire on release or after a long idle time, and the registry is capped.

export const TOKEN_IDLE_MS = 2 * 60 * 60_000
export const TOKEN_LIMIT = 400

export interface TokenEntry<T> {
  value: T
  owner: string | null
  lastUsed: number
}

export class TokenRegistry<T> {
  readonly #entries = new Map<string, TokenEntry<T>>()
  readonly #now: () => number
  readonly #idleMs: number
  readonly #limit: number

  constructor({ now = Date.now, idleMs = TOKEN_IDLE_MS, limit = TOKEN_LIMIT }: { now?: () => number; idleMs?: number; limit?: number } = {}) {
    this.#now = now
    this.#idleMs = idleMs
    this.#limit = limit
  }

  /** A new token: 32 lowercase hex characters, since standard schemes lowercase their host. */
  issue(value: T, owner: string | null): string {
    this.#sweep()
    const token = randomBytes(16).toString('hex')
    this.#entries.set(token, { value, owner, lastUsed: this.#now() })
    while (this.#entries.size > this.#limit) {
      const oldest = [...this.#entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
      if (!oldest) break
      this.#entries.delete(oldest[0])
    }
    return token
  }

  /** The token's value, or null when it never existed or has expired. Using a token keeps it alive. */
  get(token: string): T | null {
    const entry = this.#entries.get(token)
    if (!entry) return null
    if (entry.owner === null && this.#now() - entry.lastUsed > this.#idleMs) {
      this.#entries.delete(token)
      return null
    }
    entry.lastUsed = this.#now()
    return entry.value
  }

  set(token: string, value: T): void {
    const entry = this.#entries.get(token)
    if (entry) entry.value = value
  }

  release(token: string): void {
    this.#entries.delete(token)
  }

  /** The tab closed: every token it held expires. */
  releaseOwner(owner: string): number {
    let n = 0
    for (const [token, entry] of this.#entries) {
      if (entry.owner === owner) {
        this.#entries.delete(token)
        n++
      }
    }
    return n
  }

  /** Tokens whose value matches, e.g. every view of a file that was deleted. */
  findAll(match: (value: T) => boolean): string[] {
    return [...this.#entries].filter(([, e]) => match(e.value)).map(([t]) => t)
  }

  get size(): number {
    return this.#entries.size
  }

  #sweep(): void {
    const now = this.#now()
    for (const [token, entry] of this.#entries) if (entry.owner === null && now - entry.lastUsed > this.#idleMs) this.#entries.delete(token)
  }
}
