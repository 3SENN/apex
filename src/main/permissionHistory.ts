/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { dirname, join } from 'node:path'
import { afterAnswer, afterDismissal, isEmbargoed, siteKey, type PromptHistory } from '@shared/permissions'
import { SITE_PERMISSIONS, type SitePermission } from '@shared/sites'
import { writeAtomic } from './settings'
import { readJson } from './stores'

// What sites' past prompts left behind (Chrome's permission embargo): how
// often a question was put away unanswered, the week-long block after the
// third time, and whether it was refused once (notification requests then
// ask quietly). It sits next to the profile's sites.json; a private window's
// history stays in memory. A site's settings changing in site info clears it.

const FILE_VERSION = 1
const KNOWN = new Set<string>(SITE_PERMISSIONS)

export class PermissionHistory {
  readonly file: string | null
  readonly #origins = new Map<string, Partial<Record<SitePermission, PromptHistory>>>()

  constructor(file: string | null, now = Date.now()) {
    this.file = file
    if (!file) return
    const raw = readJson(file) as { origins?: Record<string, Record<string, unknown>> } | undefined
    for (const [origin, perms] of Object.entries(raw?.origins ?? {})) {
      const key = siteKey(origin)
      if (!key || !perms || typeof perms !== 'object') continue
      const kept: Partial<Record<SitePermission, PromptHistory>> = {}
      for (const [perm, value] of Object.entries(perms)) {
        const h = normalize(value)
        // A lapsed embargo with nothing else to remember isn't worth keeping.
        if (KNOWN.has(perm) && h && (h.dismissals > 0 || h.refused || isEmbargoed(h, now))) kept[perm as SitePermission] = h
      }
      if (Object.keys(kept).length > 0) this.#origins.set(key, kept)
    }
  }

  get(origin: string, perm: SitePermission): PromptHistory | undefined {
    return this.#origins.get(origin)?.[perm]
  }

  embargoed(origin: string, perm: SitePermission, now = Date.now()): boolean {
    return isEmbargoed(this.get(origin, perm), now)
  }

  /** The prompt was put away; true when that put any of `perms` under embargo. */
  dismissed(origin: string, perms: readonly SitePermission[], now = Date.now()): boolean {
    let embargoed = false
    for (const p of perms) {
      const next = afterDismissal(this.get(origin, p), now)
      if (isEmbargoed(next, now)) embargoed = true
      this.#put(origin, p, next)
    }
    this.#save()
    return embargoed
  }

  answered(origin: string, perms: readonly SitePermission[], allowed: boolean): void {
    for (const p of perms) this.#put(origin, p, afterAnswer(this.get(origin, p), allowed))
    this.#save()
  }

  /** The site's settings changed (site info, Reset): its history goes, so it may ask again. */
  forget(origin: string): boolean {
    if (!this.#origins.delete(origin)) return false
    this.#save()
    return true
  }

  #put(origin: string, perm: SitePermission, h: PromptHistory): void {
    const perms = this.#origins.get(origin) ?? {}
    if (h.dismissals === 0 && !h.refused && h.embargoUntil === undefined) delete perms[perm]
    else perms[perm] = h
    if (Object.keys(perms).length === 0) this.#origins.delete(origin)
    else this.#origins.set(origin, perms)
  }

  #save(): void {
    if (!this.file) return
    writeAtomic(this.file, JSON.stringify({ version: FILE_VERSION, origins: Object.fromEntries(this.#origins) }, null, 2))
  }
}

function normalize(value: unknown): PromptHistory | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const dismissals = typeof v.dismissals === 'number' && Number.isFinite(v.dismissals) ? Math.max(0, Math.floor(v.dismissals)) : 0
  const out: PromptHistory = { dismissals }
  if (typeof v.embargoUntil === 'number' && Number.isFinite(v.embargoUntil)) out.embargoUntil = v.embargoUntil
  if (v.refused === true) out.refused = true
  return out
}

/** The history file beside a profile's sites.json, or none for a store kept in memory. */
export function historyFileFor(sitesFile: string | null): string | null {
  return sitesFile ? join(dirname(sitesFile), 'permission-history.json') : null
}
