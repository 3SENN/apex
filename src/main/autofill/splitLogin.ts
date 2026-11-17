/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Split-login memory for one tab (OV-28). The username from the first page of
// a two-page login, so the password page can fill and the save offer has it;
// and the last typed credentials per URL for 60 s, so the offer still works
// after the form is gone. In memory only, and cleared when the tab closes.

export const TYPED_TTL_MS = 60_000
/** A first-page username older than this belongs to an abandoned sign-in. */
export const USERNAME_TTL_MS = 10 * 60_000

export interface TypedLogin {
  url: string
  origin: string
  username: string
  password: string
  at: number
}

export class SplitLoginMemory {
  readonly #now: () => number
  readonly #usernames = new Map<string, { username: string; at: number }>()
  readonly #typed = new Map<string, TypedLogin>()

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  rememberUsername(origin: string, username: string): void {
    if (username) this.#usernames.set(origin, { username, at: this.#now() })
  }

  /** The first page's username for this origin, while it is fresh. */
  username(origin: string): string | null {
    const entry = this.#usernames.get(origin)
    if (!entry) return null
    if (this.#now() - entry.at > USERNAME_TTL_MS) {
      this.#usernames.delete(origin)
      return null
    }
    return entry.username
  }

  rememberTyped(login: Omit<TypedLogin, 'at'>): void {
    this.#typed.set(login.url, { ...login, at: this.#now() })
  }

  typed(url: string): TypedLogin | null {
    this.#prune()
    return this.#typed.get(url) ?? null
  }

  /** The most recent typed login on this origin within the TTL. */
  latest(origin: string): TypedLogin | null {
    this.#prune()
    let best: TypedLogin | null = null
    for (const entry of this.#typed.values()) if (entry.origin === origin && (!best || entry.at > best.at)) best = entry
    return best
  }

  forget(url: string): void {
    this.#typed.delete(url)
  }

  clear(): void {
    this.#usernames.clear()
    this.#typed.clear()
  }

  #prune(): void {
    const now = this.#now()
    for (const [url, entry] of this.#typed) if (now - entry.at > TYPED_TTL_MS) this.#typed.delete(url)
  }
}
