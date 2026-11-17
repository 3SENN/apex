/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { Session } from 'electron'
import { combineDecisions, siteKey } from '@shared/permissions'
import {
  DEFAULT_SITE_SETTINGS,
  SITE_PERMISSIONS,
  SITE_TOGGLES,
  applySitePatch,
  countOverrides,
  normalizeSiteSettings,
  type PermissionDecision,
  type SitePermission,
  type SiteSettings,
  type SiteSettingsEntry,
  type SiteSettingsPatch,
} from '@shared/sites'
import { writeAtomic } from './settings'
import { readJson } from './stores'

// The per-origin site store: permission answers, granted
// devices and per-site switches. Each profile keeps one sites.json; a private
// window's session keeps its store in memory only, so nothing it decides
// outlives the window. A private store still honours its profile's blocks (a
// site blocked there stays blocked), reading them live and never writing
// back; allows don't carry over. Per-site values never live in settings.

const FILE_VERSION = 1

/** One profile's (or private window's) site settings. Emits 'changed' with the origin after every write. */
export class SiteStore extends EventEmitter<{ changed: [origin: string] }> {
  /** Null keeps everything in memory (private windows). */
  readonly file: string | null
  readonly #sites = new Map<string, SiteSettings>()
  /** A private window's profile store, whose blocks hold here too. */
  #parent: SiteStore | null = null
  /** Inherited blocks this private window lifted for itself: origin → "perm:camera", "sound", … */
  readonly #lifted = new Map<string, Set<string>>()

  constructor(file: string | null) {
    super()
    this.file = file
    if (!file) return
    const raw = readJson(file) as { version?: number; sites?: Record<string, unknown> } | undefined
    for (const [origin, value] of Object.entries(raw?.sites ?? {})) {
      const key = siteKey(origin)
      if (!key) continue
      const settings = normalizeSiteSettings(value)
      if (countOverrides(settings) > 0) this.#sites.set(key, settings)
    }
  }

  get persistent(): boolean {
    return this.file !== null
  }

  /** Makes this (memory-only) store honour a profile store's blocks. Its changes show here as they happen. */
  inheritFrom(parent: SiteStore): void {
    if (this.persistent || this.#parent || parent === this) return
    this.#parent = parent
    // Held weakly: a closed private window's store doesn't stay alive through its profile's listener.
    const ref = new WeakRef(this)
    const relay = (origin: string): void => {
      const child = ref.deref()
      if (child) child.emit('changed', origin)
      else parent.off('changed', relay)
    }
    parent.on('changed', relay)
  }

  get(origin: string): SiteSettings {
    const key = siteKey(origin)
    const own = structuredClone((key && this.#sites.get(key)) || DEFAULT_SITE_SETTINGS)
    if (!key || !this.#parent) return own
    const lifted = this.#lifted.get(key)
    for (const field of inheritedBlocks(this.#parent.get(key))) {
      if (lifted?.has(field)) continue
      if (field.startsWith('perm:')) {
        const perm = field.slice(5) as SitePermission
        if (own.permissions[perm] === undefined) own.permissions[perm] = 'block'
      } else {
        const toggle = field as (typeof SITE_TOGGLES)[number]
        if (own[toggle] === 'default') own[toggle] = 'block'
      }
    }
    return own
  }

  set(origin: string, patch: SiteSettingsPatch): SiteSettings {
    const key = siteKey(origin)
    if (!key) return structuredClone(DEFAULT_SITE_SETTINGS)
    if (this.#parent) this.#lift(key, patch)
    // The patch applies to this store's own answers; inherited blocks stay where they come from.
    const next = applySitePatch(structuredClone(this.#sites.get(key) ?? DEFAULT_SITE_SETTINGS), patch)
    // A site back at every default leaves the file.
    if (countOverrides(next) === 0) this.#sites.delete(key)
    else this.#sites.set(key, next)
    this.#save()
    this.emit('changed', key)
    return this.get(key)
  }

  forget(origin: string): void {
    const key = siteKey(origin)
    if (!key) return
    let changed = this.#sites.delete(key)
    // Reset in a private window lifts the profile's blocks too, for this window only.
    const inherited = this.#parent ? inheritedBlocks(this.#parent.get(key)) : []
    if (inherited.some((f) => !this.#lifted.get(key)?.has(f))) {
      this.#lifted.set(key, new Set([...(this.#lifted.get(key) ?? []), ...inherited]))
      changed = true
    }
    if (!changed) return
    this.#save()
    this.emit('changed', key)
  }

  /** A patch that sets an inherited block back to ask or default lifts it here; an explicit answer of its own takes over. */
  #lift(key: string, patch: SiteSettingsPatch): void {
    const blocked = new Set(inheritedBlocks(this.#parent!.get(key)))
    const lifted = this.#lifted.get(key) ?? new Set<string>()
    const note = (field: string, reset: boolean): void => {
      if (!blocked.has(field)) return
      if (reset) lifted.add(field)
      else lifted.delete(field)
    }
    for (const [perm, decision] of Object.entries(patch.permissions ?? {})) note(`perm:${perm}`, !decision || decision === 'ask')
    for (const toggle of SITE_TOGGLES) if (patch[toggle] !== undefined) note(toggle, patch[toggle] === 'default')
    if (lifted.size > 0) this.#lifted.set(key, lifted)
    else this.#lifted.delete(key)
  }

  /** The stored answer for one permission; unset ones ask. */
  permission(origin: string, perm: SitePermission): PermissionDecision {
    return this.get(origin).permissions[perm] ?? 'ask'
  }

  /** One answer for several permissions at once (camera and microphone in one request). */
  decision(origin: string, perms: readonly SitePermission[]): PermissionDecision {
    const stored = this.get(origin).permissions
    return combineDecisions(perms.map((p) => stored[p] ?? 'ask'))
  }

  list(): SiteSettingsEntry[] {
    const origins = new Set(this.#sites.keys())
    for (const entry of this.#parent?.list() ?? []) origins.add(entry.origin)
    return [...origins]
      .map((origin) => {
        const settings = this.get(origin)
        return { origin, settings, overrides: countOverrides(settings) }
      })
      .filter((e) => e.overrides > 0)
      .sort((a, b) => a.origin.localeCompare(b.origin))
  }

  #save(): void {
    if (!this.file) return
    const sites = Object.fromEntries(this.#sites)
    writeAtomic(this.file, JSON.stringify({ version: FILE_VERSION, sites }, null, 2))
  }
}

/** A profile store's blocks, as "perm:<permission>" and toggle names. */
function inheritedBlocks(parent: SiteSettings): string[] {
  const out: string[] = []
  for (const perm of SITE_PERMISSIONS) if (parent.permissions[perm] === 'block') out.push(`perm:${perm}`)
  for (const toggle of SITE_TOGGLES) if (parent[toggle] === 'block') out.push(toggle)
  return out
}

const certificateExceptions = new Set<string>()
const stores = new WeakMap<Session, SiteStore>()
/** One store per sites.json, so a profile's session and its private windows share it. */
const byFile = new Map<string, SiteStore>()
let defaultStore: SiteStore | null = null

export const sites = {
  /** Whether the tab's page was reached by proceeding past a certificate error. */
  hasCertificateException(tabId: string): boolean {
    return certificateExceptions.has(tabId)
  },
  /** Marks and clears tabs as they proceed past an interstitial or navigate away. */
  setCertificateException(tabId: string, on: boolean): void {
    if (on) certificateExceptions.add(tabId)
    else certificateExceptions.delete(tabId)
  },

  /**
   * Binds a session to its store: the default profile's sites.json, or memory
   * for a private window. Other profiles pass their own folder (constructor and
   * path arguments only).
   */
  attach(session: Session, opts: { private: boolean; dataDir: string }): SiteStore {
    const existing = stores.get(session)
    if (existing) return existing
    const store = opts.private ? new SiteStore(null) : sites.storeForDir(opts.dataDir)
    stores.set(session, store)
    if (!opts.private && !defaultStore) defaultStore = store
    return store
  },

  /** A profile's store by its data folder, whether or not its session is open yet (its private windows inherit from it). */
  storeForDir(dataDir: string): SiteStore {
    const file = join(dataDir, 'sites.json')
    let store = byFile.get(file)
    if (!store) byFile.set(file, (store = new SiteStore(file)))
    return store
  },

  /** The store a session uses (the default profile's when the session was never attached). */
  storeFor(session: Session | null | undefined): SiteStore | null {
    return (session && stores.get(session)) || defaultStore
  },

  /** The default profile's store, which the Settings pages show. */
  defaultStore(): SiteStore | null {
    return defaultStore
  },

  /** A site's settings in a session (the webRequest mux reads ad-block, cookie, content and popup switches here). */
  settingsFor(session: Session | null | undefined, origin: string): SiteSettings {
    return sites.storeFor(session)?.get(origin) ?? structuredClone(DEFAULT_SITE_SETTINGS)
  },
}
