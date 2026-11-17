/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// chrome.storage.sync for extensions in Apex. Electron's binding for
// it exists but every call fails ("sync" is not available), so an extension
// that keeps its settings there (most do) breaks. Apex has no account sync,
// so sync data stays on this computer, which is what Chrome does when sync
// is off: here it lives in storage.local under a reserved prefix, with
// storage.sync's own API, quotas and change events, and storage.local no
// longer shows those keys. Every context of the extension installs the same
// mapping (the worker and page preloads, and a content-script prelude for
// Web Store installs), so they all see the same data.
//
// `installStorageSync` is serialized into the extension's own world, so it
// must not reference anything outside itself.

export const STORAGE_SYNC_PREFIX = '__apex_sync__:'

export function installStorageSync(): void {
  type Fn = (...args: unknown[]) => unknown
  type Area = Record<string, Fn | unknown>
  type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>
  const g = globalThis as unknown as { chrome?: { storage?: Record<string, unknown> }; __apexStorageSync?: boolean }
  const storage = g.chrome?.storage
  const local = storage?.local as Area | undefined
  if (!storage || !local || typeof local.get !== 'function' || g.__apexStorageSync) return
  g.__apexStorageSync = true

  const PREFIX = '__apex_sync__:'
  const QUOTA_BYTES = 102400
  const QUOTA_BYTES_PER_ITEM = 8192
  const MAX_ITEMS = 512
  const raw = {
    get: (local.get as Fn).bind(local) as (keys?: unknown) => Promise<Record<string, unknown>>,
    set: (local.set as Fn).bind(local) as (items: Record<string, unknown>) => Promise<void>,
    remove: (local.remove as Fn).bind(local) as (keys: string | string[]) => Promise<void>,
  }
  const isSync = (k: string): boolean => k.startsWith(PREFIX)
  const strip = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => isSync(k)).map(([k, v]) => [k.slice(PREFIX.length), v]))
  const localOnly = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !isSync(k)))
  const size = (k: string, v: unknown): number => k.length + (JSON.stringify(v) ?? '').length

  /** Chrome's dual style: a trailing callback, or a promise. */
  const dual =
    (impl: (...args: unknown[]) => Promise<unknown>): Fn =>
    (...args: unknown[]) => {
      const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as Fn) : null
      const p = impl(...args)
      if (!cb) return p
      p.then(
        (v) => cb(v),
        (err: unknown) => {
          console.error(`Unchecked runtime.lastError: ${err instanceof Error ? err.message : String(err)}`)
          cb()
        },
      )
      return undefined
    }

  const syncGet = async (keys?: unknown): Promise<Record<string, unknown>> => {
    if (keys === null || keys === undefined) return strip(await raw.get(null))
    if (typeof keys === 'string') return strip(await raw.get([PREFIX + keys]))
    if (Array.isArray(keys)) return strip(await raw.get(keys.map((k) => PREFIX + String(k))))
    if (typeof keys === 'object') {
      const defaults = keys as Record<string, unknown>
      return { ...defaults, ...strip(await raw.get(Object.keys(defaults).map((k) => PREFIX + k))) }
    }
    throw new Error('Invalid keys.')
  }
  const syncSet = async (items: unknown): Promise<void> => {
    if (!items || typeof items !== 'object') throw new Error('Invalid items.')
    const entries = Object.entries(items as Record<string, unknown>).filter(([, v]) => v !== undefined)
    for (const [k, v] of entries) if (size(k, v) > QUOTA_BYTES_PER_ITEM) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded.')
    const all = strip(await raw.get(null))
    for (const [k, v] of entries) all[k] = v
    if (Object.keys(all).length > MAX_ITEMS) throw new Error('MAX_ITEMS quota exceeded.')
    if (Object.entries(all).reduce((n, [k, v]) => n + size(k, v), 0) > QUOTA_BYTES) throw new Error('QUOTA_BYTES quota exceeded.')
    await raw.set(Object.fromEntries(entries.map(([k, v]) => [PREFIX + k, v])))
  }
  const keyList = (keys: unknown): string[] => (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys.map(String) : [])
  const syncRemove = async (keys: unknown): Promise<void> => raw.remove(keyList(keys).map((k) => PREFIX + k))
  const syncClear = async (): Promise<void> => raw.remove(Object.keys(await raw.get(null)).filter(isSync))
  const syncBytes = async (keys?: unknown): Promise<number> => {
    const all = strip(await raw.get(null))
    const pick = keys === null || keys === undefined ? Object.keys(all) : keyList(keys)
    return pick.reduce((n, k) => (k in all ? n + size(k, all[k]) : n), 0)
  }

  // Change events: one native listener per wrapped one, splitting local changes into "sync" and "local".
  type Listener = (changes: Changes, area?: string) => void
  const split = (changes: Changes): { sync: Changes; local: Changes } => {
    const sync: Changes = {}
    const rest: Changes = {}
    for (const [k, v] of Object.entries(changes)) {
      if (isSync(k)) sync[k.slice(PREFIX.length)] = v
      else rest[k] = v
    }
    return { sync, local: rest }
  }
  const wrapEvent = (native: Area | undefined, translate: (fn: Listener) => Listener): Area | undefined => {
    if (!native || typeof native.addListener !== 'function') return native
    const wrapped = new Map<Listener, Listener>()
    const add = (native.addListener as Fn).bind(native)
    const remove = (native.removeListener as Fn).bind(native)
    return {
      addListener: (fn: unknown) => {
        if (typeof fn !== 'function' || wrapped.has(fn as Listener)) return
        const w = translate(fn as Listener)
        wrapped.set(fn as Listener, w)
        add(w)
      },
      removeListener: (fn: unknown) => {
        const w = wrapped.get(fn as Listener)
        if (!w) return
        wrapped.delete(fn as Listener)
        remove(w)
      },
      hasListener: (fn: unknown) => wrapped.has(fn as Listener),
      hasListeners: () => wrapped.size > 0,
    }
  }
  const onAnyChanged = wrapEvent(storage.onChanged as Area | undefined, (fn) => (changes, area) => {
    if (area !== 'local') return fn(changes, area)
    const { sync, local: rest } = split(changes)
    if (Object.keys(rest).length) fn(rest, 'local')
    if (Object.keys(sync).length) fn(sync, 'sync')
  })
  const nativeLocalChanged = local.onChanged as Area | undefined
  const onLocalChanged = wrapEvent(nativeLocalChanged, (fn) => (changes) => {
    const { local: rest } = split(changes)
    if (Object.keys(rest).length) fn(rest)
  })
  const onSyncChanged = wrapEvent(nativeLocalChanged ?? (storage.onChanged as Area | undefined), (fn) => (changes, area) => {
    if (area !== undefined && area !== 'local') return
    const { sync } = split(changes)
    if (Object.keys(sync).length) fn(sync)
  })

  const sync: Area = {
    QUOTA_BYTES,
    QUOTA_BYTES_PER_ITEM,
    MAX_ITEMS,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    get: dual(syncGet),
    set: dual(syncSet),
    remove: dual(syncRemove),
    clear: dual(syncClear),
    getBytesInUse: dual(syncBytes),
    getKeys: dual(async () => Object.keys(strip(await raw.get(null)))),
    setAccessLevel: dual(async () => {
      throw new Error('This StorageArea does not support setAccessLevel.')
    }),
    onChanged: onSyncChanged,
  }
  const define = (target: object, key: string, value: unknown): void => {
    try {
      Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value })
    } catch {
      // A frozen namespace: that part stays Electron's.
    }
  }
  // storage.local stops showing sync's keys: listing, clearing and its own change events. The
  // native methods stay on their own object (they check what they're called on).
  define(
    local,
    'get',
    dual(async (keys?: unknown) => {
      const got = await raw.get(keys === undefined ? null : keys)
      return keys === null || keys === undefined ? localOnly(got) : got
    }),
  )
  define(local, 'clear', dual(async () => raw.remove(Object.keys(await raw.get(null)).filter((k) => !isSync(k)))))
  if (typeof local.getKeys === 'function') define(local, 'getKeys', dual(async () => Object.keys(localOnly(await raw.get(null)))))
  if (onLocalChanged) define(local, 'onChanged', onLocalChanged)
  define(storage, 'sync', sync)
  if (onAnyChanged) define(storage, 'onChanged', onAnyChanged)
}
