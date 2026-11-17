/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFilters, type CosmeticFilter } from '@ghostery/adblocker-electron'
import { getDomain } from 'tldts'
import { COOKIE_LISTS, type CookieListId, type CookieListStatus } from '@shared/privacyPack'

// The optional cookie-banner lists (privacy pack). Nothing is bundled: a
// list is downloaded from its maintainers when the person turns it on, kept
// in <data>/cookie-lists/ and refreshed weekly. The ad blocker's own parser
// (Ghostery's) reads it; only plain element-hiding rules are kept (generic
// ones, and ones for named sites with their exceptions). Scriptlets,
// procedural selectors and network rules are dropped, so a list can hide
// elements and nothing else.

export const LIST_MAX_BYTES = 8 * 1024 * 1024
export const LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface CompiledList {
  generic: string[]
  specific: CosmeticFilter[]
  /** #@# rules for named sites: the selector is shown there again. */
  unhide: CosmeticFilter[]
  rules: number
}

const EMPTY: CompiledList = { generic: [], specific: [], unhide: [], rules: 0 }

export function compileList(text: string): CompiledList {
  const { cosmeticFilters } = parseFilters(text, {
    loadNetworkFilters: false,
    loadCosmeticFilters: true,
    loadGenericCosmeticsFilters: true,
    loadExtendedSelectors: false,
    enableHtmlFiltering: false,
  })
  const out: CompiledList = { generic: [], specific: [], unhide: [], rules: 0 }
  for (const f of cosmeticFilters) {
    if (f.isScriptInject() || f.isExtended() || f.isHtmlFiltering() || f.hasCustomStyle() || f.isRemove()) continue
    if (f.isUnhide()) {
      if (f.hasHostnameConstraint()) out.unhide.push(f)
      continue
    }
    if (f.hasHostnameConstraint()) out.specific.push(f)
    else out.generic.push(f.getSelector())
  }
  out.rules = out.generic.length + out.specific.length
  return out
}

/** A page's hiding selectors from one list: its generic rules and its rules for the page's site, less what the site unhides. */
export function selectorsFor(list: CompiledList, hostname: string): string[] {
  const host = hostname.toLowerCase()
  const domain = getDomain(host) ?? host
  const unhidden = new Set(list.unhide.filter((f) => f.match(host, domain)).map((f) => f.getSelector()))
  const out: string[] = []
  for (const s of list.generic) if (!unhidden.has(s)) out.push(s)
  for (const f of list.specific) {
    const s = f.getSelector()
    if (!unhidden.has(s) && f.match(host, domain)) out.push(s)
  }
  return out
}

/** What a download must look like before it replaces the copy on disk: text with hiding rules, within the size limit. */
export function looksLikeFilterList(text: string): boolean {
  return text.length > 0 && text.length <= LIST_MAX_BYTES && /^[^!\n]*##/m.test(text) && !/^\s*</.test(text)
}

export interface CookieListsOptions {
  dir: string
  fetchText(url: string): Promise<string>
  now?(): number
  /** Told after a list's rules change (a download or the first load). */
  onChange?(): void
}

interface Entry {
  list: CompiledList
  updatedAt: number | null
  state: CookieListStatus['state']
}

export class CookieLists {
  readonly #dir: string
  readonly #fetch: (url: string) => Promise<string>
  readonly #now: () => number
  readonly #onChange: () => void
  readonly #entries = new Map<CookieListId, Entry>()
  readonly #loading = new Map<CookieListId, Promise<void>>()
  readonly #cache = new Map<string, string[]>()

  constructor(opts: CookieListsOptions) {
    this.#dir = opts.dir
    this.#fetch = opts.fetchText
    this.#now = opts.now ?? Date.now
    this.#onChange = opts.onChange ?? (() => undefined)
  }

  #file(id: CookieListId): string {
    return join(this.#dir, `${id}.txt`)
  }

  #entry(id: CookieListId): Entry {
    let e = this.#entries.get(id)
    if (!e) {
      e = { list: EMPTY, updatedAt: null, state: 'idle' }
      this.#entries.set(id, e)
    }
    return e
  }

  #changed(): void {
    this.#cache.clear()
    this.#onChange()
  }

  /** Reads the copy on disk once; downloads when there is none or it is a week old and downloading is allowed. */
  ensure(ids: readonly CookieListId[], opts: { download: boolean }): Promise<void> {
    return Promise.all(ids.map((id) => this.#ensureOne(id, opts.download))).then(() => undefined)
  }

  #ensureOne(id: CookieListId, download: boolean): Promise<void> {
    const running = this.#loading.get(id)
    if (running) return running
    const job = (async () => {
      const e = this.#entry(id)
      if (e.updatedAt === null) await this.#readDisk(id)
      const stale = e.updatedAt === null || this.#now() - e.updatedAt > LIST_MAX_AGE_MS
      if (stale && download) await this.#download(id)
    })().finally(() => this.#loading.delete(id))
    this.#loading.set(id, job)
    return job
  }

  async #readDisk(id: CookieListId): Promise<void> {
    const e = this.#entry(id)
    try {
      const [text, info] = await Promise.all([readFile(this.#file(id), 'utf8'), stat(this.#file(id))])
      if (!looksLikeFilterList(text)) return
      e.list = compileList(text)
      e.updatedAt = info.mtimeMs
      this.#changed()
    } catch {
      // Not downloaded yet.
    }
  }

  async #download(id: CookieListId): Promise<void> {
    const info = COOKIE_LISTS.find((l) => l.id === id)
    if (!info) return
    const e = this.#entry(id)
    e.state = 'updating'
    try {
      const text = await this.#fetch(info.url)
      if (!looksLikeFilterList(text)) throw new Error('The download is not a filter list.')
      await mkdir(this.#dir, { recursive: true })
      await writeFile(this.#file(id), text)
      e.list = compileList(text)
      e.updatedAt = this.#now()
      e.state = 'idle'
      this.#changed()
    } catch {
      // The copy on disk (if any) stays in use.
      e.state = 'failed'
    }
  }

  /** Downloads the lists again now, whatever their age. */
  async update(ids: readonly CookieListId[]): Promise<void> {
    await Promise.all(ids.map((id) => this.#download(id)))
  }

  /** The enabled lists' selectors for a host (memoised until a list changes). */
  selectors(ids: readonly CookieListId[], hostname: string): string[] {
    if (ids.length === 0) return []
    const key = `${[...ids].sort().join(',')}|${hostname}`
    const hit = this.#cache.get(key)
    if (hit) return hit
    const out = ids.flatMap((id) => {
      const e = this.#entries.get(id)
      return e ? selectorsFor(e.list, hostname) : []
    })
    if (this.#cache.size > 200) this.#cache.clear()
    this.#cache.set(key, out)
    return out
  }

  status(enabled: readonly CookieListId[]): CookieListStatus[] {
    return COOKIE_LISTS.map((l) => {
      const e = this.#entries.get(l.id)
      return { id: l.id, enabled: enabled.includes(l.id), updatedAt: e?.updatedAt ?? null, rules: e?.list.rules ?? 0, state: e?.state ?? 'idle' }
    })
  }
}
