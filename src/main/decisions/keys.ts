/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isProviderId } from '@shared/decisions'
import { registerSecret } from '../log'
import { writeAtomic } from '../workspace/fsutil'

// Decision-model keys (DC-03): one per provider (and per server of your own), kept together in one file
// that this computer's secure storage encrypts (the Keychain on a Mac), like
// the Anthropic key. They never reach a settings file, a log line or a page.

export interface Sealer {
  available(): boolean
  seal(text: string): Buffer
  open(data: Buffer): string
}

export const KEYS_FILE = 'decision-keys.bin'

export class DecisionKeys {
  readonly #path: string
  readonly #sealer: Sealer
  #keys: Record<string, string> | null = null

  constructor(dataDir: string, sealer: Sealer) {
    this.#path = join(dataDir, KEYS_FILE)
    this.#sealer = sealer
  }

  get(provider: string): string | null {
    return this.#all()[provider] ?? null
  }

  has(provider: string): boolean {
    return Boolean(this.get(provider))
  }

  set(provider: string, key: string | null): void {
    if (!isProviderId(provider)) throw new Error('Unknown decision provider.')
    const next = { ...this.#all() }
    const value = key?.trim() ?? ''
    if (value) {
      if (!this.#sealer.available()) throw new Error('Secure storage is unavailable on this computer, so the key cannot be saved.')
      next[provider] = value
      registerSecret(value)
    } else {
      delete next[provider]
    }
    this.#keys = next
    if (Object.keys(next).length === 0) rmSync(this.#path, { force: true })
    else writeAtomic(this.#path, this.#sealer.seal(JSON.stringify(next)))
  }

  /** Forgets every key, on disk and in memory (Reset Atelier with secrets). */
  clear(): void {
    this.#keys = {}
    rmSync(this.#path, { force: true })
  }

  /** Forgets the keys of servers of yours that are gone, so a key never outlives its server. */
  retainServers(ids: ReadonlySet<string>): void {
    const all = this.#all()
    for (const id of Object.keys(all)) if (id.startsWith('server-') && !ids.has(id)) this.set(id, null)
  }

  #all(): Record<string, string> {
    if (this.#keys) return this.#keys
    this.#keys = {}
    if (existsSync(this.#path) && this.#sealer.available()) {
      try {
        const parsed = JSON.parse(this.#sealer.open(readFileSync(this.#path))) as Record<string, unknown>
        for (const [k, v] of Object.entries(parsed)) {
          if (isProviderId(k) && typeof v === 'string' && v) {
            this.#keys[k] = v
            registerSecret(v)
          }
        }
      } catch {
        // An unreadable file (another computer's Keychain) counts as no keys.
      }
    }
    return this.#keys
  }
}
