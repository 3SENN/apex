/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../settings'

// Connector icons: a site's own favicon, fetched at runtime through
// the default profile's session and cached on disk, or null so the page
// draws Apex's generic category icon. Off in smoke and tests, so no fetch
// ever leaves the machine there.

const HIT_TTL = 7 * 24 * 3600_000
const MISS_TTL = 24 * 3600_000
const MAX_BYTES = 100_000
const TIMEOUT_MS = 5000

export type IconFetch = (url: string, signal: AbortSignal) => Promise<{ ok: boolean; contentType: string | null; body: ArrayBuffer }>

interface Entry {
  data: string | null
  at: number
}

export class FaviconCache {
  readonly #path: string
  readonly #fetch: IconFetch | null
  readonly #now: () => number
  #entries: Record<string, Entry>
  readonly #pending = new Map<string, Promise<string | null>>()

  /** `fetch` null turns fetching off (smoke, tests): everything gets the generic icon. */
  constructor(dataDir: string, fetch: IconFetch | null, now: () => number = Date.now) {
    this.#path = join(dataDir, 'connector-icons.json')
    this.#fetch = fetch
    this.#now = now
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      this.#entries = typeof raw === 'object' && raw !== null ? (raw as Record<string, Entry>) : {}
    } catch {
      this.#entries = {}
    }
  }

  async get(site: string): Promise<string | null> {
    const cached = this.#entries[site]
    if (cached && this.#now() - cached.at < (cached.data ? HIT_TTL : MISS_TTL)) return cached.data
    if (!this.#fetch) return cached?.data ?? null
    const pending = this.#pending.get(site)
    if (pending) return pending
    const run = this.#load(site).finally(() => this.#pending.delete(site))
    this.#pending.set(site, run)
    return run
  }

  async #load(site: string): Promise<string | null> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
    let data: string | null = null
    try {
      const res = await this.#fetch!(`https://${site}/favicon.ico`, abort.signal)
      const type = (res.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (res.ok && type.startsWith('image/') && res.body.byteLength > 0 && res.body.byteLength <= MAX_BYTES) {
        data = `data:${type};base64,${Buffer.from(res.body).toString('base64')}`
      }
    } catch {
      data = null
    } finally {
      clearTimeout(timer)
    }
    this.#entries[site] = { data, at: this.#now() }
    try {
      writeAtomic(this.#path, JSON.stringify(this.#entries))
    } catch {
      // A cache that can't be written only costs a refetch.
    }
    return data
  }
}
