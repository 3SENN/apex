/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, describe, expect, it } from 'vitest'
import { STORAGE_SYNC_PREFIX, installStorageSync } from '@shared/extensionStorageSync'
import { CONTENT_COMPAT_FILE, applyContentCompat, contentCompatSource } from '../src/main/extensions/contentCompat'

// Chrome.storage.sync for extensions. Electron's own fails every call,
// so Atelier keeps sync's data on this computer (as Chrome does with sync off),
// inside storage.local under a reserved prefix that storage.local no longer
// shows. Content scripts of Web Store installs get the same mapping from a
// prelude Atelier puts first in each content_scripts entry.

const dir = mkdtempSync(join(tmpdir(), 'atelier-storage-sync-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>

/** A storage.local with Chrome's promise API and change events, backed by one object shared by every "context". */
function fakeStorage(data: Record<string, unknown> = {}) {
  const any: Array<(c: Changes, area: string) => void> = []
  const area: Array<(c: Changes) => void> = []
  const fire = (changes: Changes): void => {
    for (const fn of [...any]) fn(changes, 'local')
    for (const fn of [...area]) fn(changes)
  }
  const pick = (keys: unknown): Record<string, unknown> => {
    if (keys === null || keys === undefined) return { ...data }
    const list = typeof keys === 'string' ? [keys] : (keys as string[])
    return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]))
  }
  const local = {
    get: async (keys?: unknown) => pick(keys),
    set: async (items: Record<string, unknown>) => {
      const changes: Changes = {}
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: v }
        data[k] = v
      }
      fire(changes)
    },
    remove: async (keys: string | string[]) => {
      const changes: Changes = {}
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (!(k in data)) continue
        changes[k] = { oldValue: data[k] }
        delete data[k]
      }
      if (Object.keys(changes).length) fire(changes)
    },
    clear: async () => {
      for (const k of Object.keys(data)) delete data[k]
    },
    getKeys: async () => Object.keys(data),
    onChanged: { addListener: (fn: (c: Changes) => void) => void area.push(fn), removeListener: (fn: (c: Changes) => void) => void area.splice(area.indexOf(fn), 1) },
  }
  const failing = async (): Promise<never> => {
    throw new Error('"sync" is not available in this instance of Chrome')
  }
  const chrome = {
    storage: {
      local,
      sync: { get: failing, set: failing },
      onChanged: { addListener: (fn: (c: Changes, a: string) => void) => void any.push(fn), removeListener: (fn: (c: Changes, a: string) => void) => void any.splice(any.indexOf(fn), 1) },
    },
  }
  return { chrome: chrome as unknown as { storage: Record<string, Record<string, (...a: unknown[]) => unknown>> }, data }
}

/** Runs the installer as the preloads do: in a world of its own, serialized. */
function install(chrome: unknown): void {
  runInNewContext(`(${installStorageSync.toString()})()`, { chrome, console, Promise, Object, JSON, Error })
}

describe('chrome.storage.sync', () => {
  it('reads defaults, sets, removes and clears, in both callback and promise style', async () => {
    const { chrome, data } = fakeStorage({ theme: 'dark' })
    install(chrome)
    const sync = chrome.storage.sync!
    expect(await sync.get!({ enableInPageAutoFill: true, allowExtensionToControlAutoFillSettings: true })).toEqual({ enableInPageAutoFill: true, allowExtensionToControlAutoFillSettings: true })
    await sync.set!({ enableInPageAutoFill: false })
    expect(data[`${STORAGE_SYNC_PREFIX}enableInPageAutoFill`]).toBe(false)
    const viaCallback = await new Promise((resolve) => sync.get!({ enableInPageAutoFill: true, other: 1 }, resolve))
    expect(viaCallback).toEqual({ enableInPageAutoFill: false, other: 1 })
    expect(await sync.get!(null)).toEqual({ enableInPageAutoFill: false })
    expect(await sync.getBytesInUse!(null)).toBeGreaterThan(0)
    await sync.remove!('enableInPageAutoFill')
    expect(await sync.get!(null)).toEqual({})
    await sync.set!({ a: 1, b: 2 })
    await sync.clear!()
    expect(await sync.getKeys!()).toEqual([])
    // storage.local's own data is untouched by any of it.
    expect(data.theme).toBe('dark')
  })

  it('keeps sync’s keys out of storage.local and splits change events by area', async () => {
    const { chrome } = fakeStorage({ theme: 'dark' })
    install(chrome)
    const seen: Array<[string, Changes]> = []
    ;(chrome.storage.onChanged as unknown as { addListener: (fn: (c: Changes, a: string) => void) => void }).addListener((c, a) => void seen.push([a, c]))
    const syncOnly: Changes[] = []
    ;(chrome.storage.sync!.onChanged as unknown as { addListener: (fn: (c: Changes) => void) => void }).addListener((c) => void syncOnly.push(c))
    await chrome.storage.sync!.set!({ pref: 'on' })
    await chrome.storage.local!.set!({ theme: 'light' })
    expect(seen).toEqual([
      ['sync', { pref: { newValue: 'on' } }],
      ['local', { theme: { oldValue: 'dark', newValue: 'light' } }],
    ])
    expect(syncOnly).toEqual([{ pref: { newValue: 'on' } }])
    expect(await chrome.storage.local!.get!(null)).toEqual({ theme: 'light' })
    expect(await chrome.storage.local!.getKeys!()).toEqual(['theme'])
    await chrome.storage.local!.clear!()
    expect(await chrome.storage.sync!.get!('pref')).toEqual({ pref: 'on' })
  })

  it('enforces Chrome’s per-item quota and shares data between contexts', async () => {
    const shared: Record<string, unknown> = {}
    const worker = fakeStorage(shared)
    const content = fakeStorage(shared)
    install(worker.chrome)
    install(content.chrome)
    await expect(worker.chrome.storage.sync!.set!({ big: 'x'.repeat(9000) })).rejects.toThrow(/QUOTA_BYTES_PER_ITEM/)
    await worker.chrome.storage.sync!.set!({ enableInPageAutoFill: false })
    expect(await content.chrome.storage.sync!.get!({ enableInPageAutoFill: true })).toEqual({ enableInPageAutoFill: false })
  })
})

describe('the content-script prelude', () => {
  it('goes first in every content_scripts entry of a store install, once', () => {
    const copy = join(dir, 'pm')
    cpSync(join(__dirname, 'fixtures/extensions/password-manager'), copy, { recursive: true })
    expect(applyContentCompat(copy)).toBe(true)
    const m = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')) as { content_scripts: Array<{ js: string[] }> }
    expect(m.content_scripts[0]?.js).toEqual([CONTENT_COMPAT_FILE, 'content.js'])
    expect(readFileSync(join(copy, CONTENT_COMPAT_FILE), 'utf8')).toBe(contentCompatSource())
    expect(applyContentCompat(copy)).toBe(false)
    // Chromium refuses extension files whose names start with "_".
    expect(CONTENT_COMPAT_FILE.startsWith('_')).toBe(false)
  })

  it('is self-contained: it installs storage.sync when run on its own', async () => {
    const { chrome } = fakeStorage()
    runInNewContext(contentCompatSource(), { chrome, console, Promise, Object, JSON, Error })
    await (chrome.storage.sync as unknown as { set: (i: unknown) => Promise<void> }).set({ x: 1 })
    expect(await chrome.storage.sync!.get!('x')).toEqual({ x: 1 })
  })
})
