/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { EXTENSION_ID } from '@shared/extensions'
import { log } from '../log'

// The small per-profile store: which extensions are enabled and
// pinned, the optional permissions a person granted, and their native-host
// decisions. Electron forgets loaded extensions between runs, so this file
// is what brings them back. Field-by-field fallback: a damaged entry loses
// only its own bad fields.

export const STATE_VERSION = 2

export interface ExtensionRecord {
  enabled: boolean
  pinned: boolean
  /** Optional permissions and host patterns the person allowed. */
  granted: string[]
  source: 'store' | 'unpacked'
  /** Unpacked extensions load from where they are; store ones from the profile's Extensions folder. */
  path: string | null
  installedAt: number
  /** chrome.privacy settings this extension set (setting key → value); they apply while it runs. */
  settings?: Record<string, unknown>
  /** chrome.declarativeContent rules, kept across restarts as Chrome keeps them. */
  contentRules?: unknown[]
  /** chrome.contextMenus items, kept across restarts as Chrome keeps them for Manifest V3 workers. */
  menus?: unknown[]
}

export type NativeDecision = 'always' | 'deny'

export interface ExtensionState {
  version: number
  extensions: Record<string, ExtensionRecord>
  /** extension id → host name → the remembered answer ("Allow once" is never stored). */
  native: Record<string, Record<string, NativeDecision>>
  /** Pin order, left to right. */
  order: string[]
}

const HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i
const strings = (v: unknown, max = 256): string[] => (Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= max))] : [])

export function defaultRecord(source: ExtensionRecord['source'] = 'store', now = Date.now()): ExtensionRecord {
  return { enabled: true, pinned: false, granted: [], source, path: null, installedAt: now }
}

function record(raw: unknown): ExtensionRecord {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const base = defaultRecord('store', 0)
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : base.enabled,
    pinned: typeof r.pinned === 'boolean' ? r.pinned : base.pinned,
    granted: strings(r.granted),
    source: r.source === 'unpacked' ? 'unpacked' : 'store',
    path: typeof r.path === 'string' && r.path.length < 4096 ? r.path : null,
    installedAt: typeof r.installedAt === 'number' && Number.isFinite(r.installedAt) ? r.installedAt : base.installedAt,
    ...(r.settings && typeof r.settings === 'object' && !Array.isArray(r.settings) ? { settings: Object.fromEntries(Object.entries(r.settings as Record<string, unknown>).filter(([k]) => k.length <= 128).slice(0, 64)) } : {}),
    ...(Array.isArray(r.contentRules) ? { contentRules: r.contentRules.slice(0, 1000) } : {}),
    ...(Array.isArray(r.menus) ? { menus: r.menus.slice(0, 1000) } : {}),
  }
}

/**
 * Turns whatever is on disk into the current shape. Version 1 kept pins and
 * disabled ids as two lists (`pinned`, `disabled`) and grants as
 * `grants: { id: string[] }`; version 2 keeps one record per extension.
 */
export function migrateState(raw: unknown): ExtensionState {
  const out: ExtensionState = { version: STATE_VERSION, extensions: {}, native: {}, order: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  if (r.version === 1 || (r.version === undefined && (Array.isArray(r.pinned) || Array.isArray(r.disabled)))) {
    const pinned = strings(r.pinned).filter((id) => EXTENSION_ID.test(id))
    const disabled = new Set(strings(r.disabled))
    const grants = r.grants && typeof r.grants === 'object' ? (r.grants as Record<string, unknown>) : {}
    const ids = new Set([...pinned, ...disabled, ...Object.keys(grants)].filter((id) => EXTENSION_ID.test(id)))
    for (const id of ids) out.extensions[id] = { ...defaultRecord('store', 0), enabled: !disabled.has(id), pinned: pinned.includes(id), granted: strings(grants[id]) }
    out.order = pinned
  } else {
    const extensions = r.extensions && typeof r.extensions === 'object' ? (r.extensions as Record<string, unknown>) : {}
    for (const [id, value] of Object.entries(extensions)) if (EXTENSION_ID.test(id)) out.extensions[id] = record(value)
    out.order = strings(r.order).filter((id) => out.extensions[id]?.pinned)
  }
  const native = r.native && typeof r.native === 'object' ? (r.native as Record<string, unknown>) : {}
  for (const [id, hosts] of Object.entries(native)) {
    if (!EXTENSION_ID.test(id) || !hosts || typeof hosts !== 'object') continue
    const kept: Record<string, NativeDecision> = {}
    for (const [host, decision] of Object.entries(hosts as Record<string, unknown>)) if (HOST_NAME.test(host) && (decision === 'always' || decision === 'deny')) kept[host] = decision
    if (Object.keys(kept).length) out.native[id] = kept
  }
  // Pins missing from the order go at its end, in install order.
  for (const [id, rec] of Object.entries(out.extensions)) if (rec.pinned && !out.order.includes(id)) out.order.push(id)
  return out
}

export class ExtensionStateStore {
  readonly #file: string
  #state: ExtensionState

  constructor(file: string) {
    this.#file = file
    this.#state = this.#load()
  }

  #load(): ExtensionState {
    if (!existsSync(this.#file)) return migrateState(null)
    try {
      return migrateState(JSON.parse(readFileSync(this.#file, 'utf8')))
    } catch (err) {
      // Keep the damaged file for a person to inspect, and start clean.
      log.warn('extensions', 'The extensions state file was unreadable; starting fresh', { error: err instanceof Error ? err.message : String(err) })
      try {
        renameSync(this.#file, `${this.#file}.broken`)
      } catch {
        // Nothing to keep.
      }
      return migrateState(null)
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      const tmp = `${this.#file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.#state, null, 2))
      renameSync(tmp, this.#file)
    } catch (err) {
      log.error('extensions', 'Could not save the extensions state', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  get(id: string): ExtensionRecord | null {
    return this.#state.extensions[id] ?? null
  }

  ids(): string[] {
    return Object.keys(this.#state.extensions)
  }

  /** Pinned ids, left to right. */
  pinOrder(): string[] {
    return this.#state.order.filter((id) => this.#state.extensions[id]?.pinned)
  }

  upsert(id: string, patch: Partial<ExtensionRecord>, source: ExtensionRecord['source'] = 'store'): ExtensionRecord {
    const next = { ...(this.#state.extensions[id] ?? defaultRecord(source)), ...patch }
    next.granted = [...new Set(next.granted)]
    this.#state.extensions[id] = next
    if (next.pinned && !this.#state.order.includes(id)) this.#state.order.push(id)
    if (!next.pinned) this.#state.order = this.#state.order.filter((x) => x !== id)
    this.#save()
    return next
  }

  remove(id: string): void {
    delete this.#state.extensions[id]
    delete this.#state.native[id]
    this.#state.order = this.#state.order.filter((x) => x !== id)
    this.#save()
  }

  nativeDecision(id: string, host: string): NativeDecision | null {
    return this.#state.native[id]?.[host] ?? null
  }

  setNativeDecision(id: string, host: string, decision: NativeDecision): void {
    this.#state.native[id] = { ...this.#state.native[id], [host]: decision }
    this.#save()
  }

  snapshot(): ExtensionState {
    return structuredClone(this.#state)
  }
}
