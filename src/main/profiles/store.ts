/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_PROFILE_HUE, PROFILE_HUE_IDS, type ProfileHue } from '@shared/profile'
import { DEFAULT_PROFILE_ID, PROFILE_ID, PROFILE_NAME_MAX, checkProfileName, profilePartition, type Profile, type ProfileNameProblem } from '@shared/profiles'
import { t } from '@shared/i18n/core'
import { writeAtomic } from '../settings'
import { PROFILES_FILE } from './paths'

// profiles.json (SH-64): { id, name, hue, createdAt } per profile. The
// default profile is always there (the original data folder, persist:atelier-web); the
// file only records its name and colour once someone changes them.

const record = z
  .object({
    id: z.union([z.literal(DEFAULT_PROFILE_ID), z.string().regex(PROFILE_ID)]),
    name: z.string().trim().min(1).max(PROFILE_NAME_MAX),
    hue: z.enum(PROFILE_HUE_IDS),
    createdAt: z.number().int().min(0),
  })
  .strip()

type ProfileRecord = z.infer<typeof record>

export class ProfileError extends Error {}

export function profileNameError(problem: ProfileNameProblem): ProfileError {
  return new ProfileError(problem === 'long' ? t('profiles.error.long', { max: PROFILE_NAME_MAX }) : t(`profiles.error.${problem}`))
}

/** A new profile id: 12 lowercase hex characters, so the partition name stays short and safe. */
export function newProfileId(): string {
  return randomBytes(6).toString('hex')
}

const toProfile = (r: ProfileRecord): Profile => ({ ...r, partition: profilePartition(r.id), isDefault: r.id === DEFAULT_PROFILE_ID })

export interface ProfileStoreOptions {
  /** The default profile's colour before profiles.json records one (the A/B profileHue setting). */
  defaultHue?: ProfileHue
  now?: () => number
  newId?: () => string
}

export class ProfileStore extends EventEmitter<{ changed: [profiles: Profile[]] }> {
  readonly #path: string
  readonly #now: () => number
  readonly #newId: () => string
  #records: ProfileRecord[]

  constructor(dataDir: string, options: ProfileStoreOptions = {}) {
    super()
    this.#path = join(dataDir, PROFILES_FILE)
    this.#now = options.now ?? Date.now
    this.#newId = options.newId ?? newProfileId
    this.#records = this.#load(options.defaultHue ?? DEFAULT_PROFILE_HUE)
  }

  /** The default profile first, then the rest by creation. */
  list(): Profile[] {
    return this.#records.map(toProfile)
  }

  get(id: string): Profile | null {
    const r = this.#records.find((p) => p.id === id)
    return r ? toProfile(r) : null
  }

  require(id: string): Profile {
    const profile = this.get(id)
    if (!profile) throw new ProfileError(t('profiles.error.missing'))
    return profile
  }

  create(input: { name: string; hue: ProfileHue }): Profile {
    const name = this.#checkName(input.name)
    let id = this.#newId()
    while (this.#records.some((p) => p.id === id)) id = this.#newId()
    const created: ProfileRecord = { id, name, hue: input.hue, createdAt: this.#now() }
    this.#records = [...this.#records, created]
    this.#save()
    return toProfile(created)
  }

  rename(id: string, name: string): Profile {
    return this.#patch(id, { name: this.#checkName(name, id) })
  }

  setHue(id: string, hue: ProfileHue): Profile {
    return this.#patch(id, { hue })
  }

  /** Drops a profile's record; the guards (last, default, typed name) are the manager's. */
  remove(id: string): void {
    if (id === DEFAULT_PROFILE_ID) throw new ProfileError(t('profiles.block.default'))
    this.require(id)
    this.#records = this.#records.filter((p) => p.id !== id)
    this.#save()
  }

  #checkName(name: string, selfId?: string): string {
    const checked = checkProfileName(name, this.#records, selfId)
    if (!checked.ok) throw profileNameError(checked.problem)
    return checked.name
  }

  #patch(id: string, patch: Partial<ProfileRecord>): Profile {
    const current = this.require(id)
    const next: ProfileRecord = { id, name: patch.name ?? current.name, hue: patch.hue ?? current.hue, createdAt: current.createdAt }
    if (next.name === current.name && next.hue === current.hue) return current
    this.#records = this.#records.map((p) => (p.id === id ? next : p))
    this.#save()
    return toProfile(next)
  }

  #save(): void {
    writeAtomic(this.#path, JSON.stringify({ version: 1, items: this.#records }, null, 2))
    this.emit('changed', this.list())
  }

  /** Each valid record is kept on its own; duplicates and broken ones are dropped, and the default always exists. */
  #load(defaultHue: ProfileHue): ProfileRecord[] {
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(this.#path, 'utf8'))
    } catch {
      // Missing or unreadable: only the default profile.
    }
    const items = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items as unknown[]) : []
    const out: ProfileRecord[] = []
    for (const item of items) {
      const parsed = record.safeParse(item)
      if (!parsed.success || out.some((p) => p.id === parsed.data.id)) continue
      if (!checkProfileName(parsed.data.name, out).ok) continue
      out.push(parsed.data)
    }
    const fallback: ProfileRecord = { id: DEFAULT_PROFILE_ID, name: t('profiles.defaultName'), hue: defaultHue, createdAt: 0 }
    const def = out.find((p) => p.id === DEFAULT_PROFILE_ID) ?? fallback
    return [def, ...out.filter((p) => p.id !== DEFAULT_PROFILE_ID).sort((a, b) => a.createdAt - b.createdAt)]
  }
}
