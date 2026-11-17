/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import type { Session } from 'electron'
import type { PrivacyExceptionKind, PrivacyExceptions } from '@shared/privacyPack'
import { writeAtomic } from '../settings'
import { readJson } from '../stores'
import { hostKey } from './httpsFirst'

// The privacy pack's per-site exceptions (Settings › Privacy): sites the
// person let load without HTTPS (Continue to site on the HTTPS-First page)
// and sites where cookie banners are left alone. One file per profile,
// privacy-exceptions.json beside sites.json; a private window keeps its own
// in memory and forgets them when it closes.

const FILE = 'privacy-exceptions.json'
const KINDS: readonly PrivacyExceptionKind[] = ['https', 'cookieBanners']
/** Enough for anyone's real list; a runaway caller can't grow the file without bound. */
export const MAX_EXCEPTIONS = 2000

/** A host the lists accept: a hostname or IP literal, nothing with a path or a scheme. */
export function validHost(host: string): string | null {
  const h = hostKey(host.trim())
  if (!h || h.length > 253 || !/^[a-z0-9.:_-]+$/.test(h)) return null
  return h
}

export class PrivacyExceptionStore {
  /** Null keeps everything in memory (private windows). */
  readonly file: string | null
  readonly #lists: Record<PrivacyExceptionKind, Set<string>> = { https: new Set(), cookieBanners: new Set() }

  constructor(file: string | null) {
    this.file = file
    if (!file) return
    const raw = readJson(file) as Partial<Record<PrivacyExceptionKind, unknown>> | undefined
    for (const kind of KINDS) {
      const list = raw?.[kind]
      if (!Array.isArray(list)) continue
      for (const item of list.slice(0, MAX_EXCEPTIONS)) {
        const host = typeof item === 'string' ? validHost(item) : null
        if (host) this.#lists[kind].add(host)
      }
    }
  }

  has(kind: PrivacyExceptionKind, host: string): boolean {
    const h = validHost(host)
    return h !== null && this.#lists[kind].has(h)
  }

  /** Adds or removes a host; returns whether anything changed. */
  set(kind: PrivacyExceptionKind, host: string, on: boolean): boolean {
    const h = validHost(host)
    if (!h) return false
    const list = this.#lists[kind]
    if (on === list.has(h)) return false
    if (on) {
      if (list.size >= MAX_EXCEPTIONS) return false
      list.add(h)
    } else {
      list.delete(h)
    }
    this.#save()
    return true
  }

  list(): PrivacyExceptions {
    return { https: [...this.#lists.https].sort(), cookieBanners: [...this.#lists.cookieBanners].sort() }
  }

  #save(): void {
    if (!this.file) return
    writeAtomic(this.file, JSON.stringify({ version: 1, ...this.list() }, null, 2))
  }
}

const stores = new WeakMap<Session, PrivacyExceptionStore>()
let fallback: PrivacyExceptionStore | null = null

export const privacyExceptions = {
  /** Binds a session to its profile's file, or to memory for a private window. */
  attach(session: Session, opts: { private: boolean; dataDir: string }): PrivacyExceptionStore {
    const existing = stores.get(session)
    if (existing) return existing
    const store = new PrivacyExceptionStore(opts.private ? null : join(opts.dataDir, FILE))
    stores.set(session, store)
    if (!opts.private && !fallback) fallback = store
    return store
  },
  /** The session's store (the default profile's when it was never attached). */
  storeFor(session: Session | null | undefined): PrivacyExceptionStore | null {
    return (session && stores.get(session)) || fallback
  },
}
