/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Preset extras on `companions` (CO-17): the detail
// sheet's data, and reviewing a preset that changed in an update. When a
// companion is first seen with its preset, the preset's version and fields
// are kept as its base (userData/preset-bases.json); a newer preset version
// then offers a review of each field it changed, marking the ones you edited
// yourself, and only the fields you pick are ever applied.
import { BRAND_NAME } from '@shared/branding'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Companion, CompanionLook, CompanionPreset } from '@shared/companion'
import { PRESET_DIFF_FIELDS, PRESET_UPDATE_ACKNOWLEDGE, type CompanionsSetupMethods, type PresetDetail, type PresetDiffField, type PresetDiffRow } from '@shared/onboarding'
import type { RoutineDraft } from '@shared/routines'
import type { SkillDraft } from '@shared/skills'
import { log } from '../log'
import { writeAtomic } from '../settings'

export const PRESET_BASES_FILE = 'preset-bases.json'
const DEFAULT_VERSION = '1'

export interface PresetExtras {
  summary?: string
  starterSkills?: SkillDraft[]
  starterRoutines?: RoutineDraft[]
  version?: string
}

const scheduleSchema = z.union([
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/), days: z.array(z.number().int().min(0).max(6)).max(7) }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1), between: z.object({ start: z.number(), end: z.number() }).optional(), days: z.array(z.number().int().min(0).max(6)).optional() }),
  z.object({ kind: z.literal('once'), at: z.number() }),
  z.object({ kind: z.literal('cron'), expr: z.string().max(100) }),
])
const extrasSchema = z.object({
  id: z.string().max(64),
  summary: z.string().max(1000).optional(),
  starterSkills: z.array(z.object({ name: z.string().max(64), description: z.string().max(500), instructions: z.string().max(10_000) })).max(10).optional(),
  starterRoutines: z.array(z.object({ name: z.string().max(80), prompt: z.string().max(4000), schedule: scheduleSchema })).max(10).optional(),
  version: z.string().max(32).optional(),
})

/** The extras each preset carries in presets.json (the base preset parser keeps only the core fields). */
export function parsePresetExtras(raw: unknown): Record<string, PresetExtras> {
  const out: Record<string, PresetExtras> = {}
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    const parsed = extrasSchema.safeParse(item)
    if (!parsed.success) continue
    const { id, ...extras } = parsed.data
    out[id] = extras as PresetExtras
  }
  return out
}

type FieldValues = Record<PresetDiffField, string>

const sortedEntries = (o: Record<string, string | null>): Array<[string, string]> =>
  Object.entries(o)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0)
    .sort(([a], [b]) => a.localeCompare(b))

/** Each reviewable field as words, for the review and for comparing. */
export function presetFieldValues(name: string, look: CompanionLook): FieldValues {
  return {
    name,
    colors: sortedEntries(look.colors as Record<string, string>).map(([k, v]) => `${k} ${v.toLowerCase()}`).join(', '),
    parts: [`rig ${look.rig}`, ...sortedEntries(look.parts as Record<string, string | null>).map(([, v]) => v)].join(', '),
    face: `${look.face.eyes}, ${look.face.brows}, ${look.face.mouth}`,
  }
}

interface Base extends FieldValues {
  presetId: string
  version: string
}

const baseSchema = z.object({ presetId: z.string(), version: z.string(), name: z.string(), colors: z.string(), parts: z.string(), face: z.string() })
const basesSchema = z.object({ version: z.literal(1), bases: z.record(z.string(), baseSchema) })

export interface PresetExtrasDeps {
  dataDir: string
  companions: { find(id: string): Companion | undefined; update(id: string, patch: unknown): Companion }
  presets(): readonly CompanionPreset[]
  /** The raw presets.json, for the extras; read lazily. */
  presetsRaw(): unknown
}

export function createPresetMethods(deps: PresetExtrasDeps): CompanionsSetupMethods {
  const path = join(deps.dataDir, PRESET_BASES_FILE)
  let bases: Record<string, Base> = {}
  try {
    const parsed = basesSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) bases = parsed.data.bases
  } catch {
    // No file yet.
  }
  let extras: Record<string, PresetExtras> | null = null
  const extrasFor = (id: string): PresetExtras => {
    if (!extras) {
      try {
        extras = parsePresetExtras(deps.presetsRaw())
      } catch {
        extras = {}
      }
    }
    return extras[id] ?? {}
  }
  const preset = (id: string): CompanionPreset | undefined => deps.presets().find((p) => p.id === id)
  const versionOf = (p: CompanionPreset): string => p.version ?? extrasFor(p.id).version ?? DEFAULT_VERSION
  const write = (): void => {
    try {
      writeAtomic(path, `${JSON.stringify({ version: 1, bases }, null, 2)}\n`)
    } catch (err) {
      log.warn('companions', 'Could not save preset bases', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  const baseFrom = (p: CompanionPreset): Base => ({ presetId: p.id, version: versionOf(p), ...presetFieldValues(p.name, p.look) })
  const companion = (id: string): Companion => {
    const c = deps.companions.find(id)
    if (!c) throw new Error('That companion doesn’t exist.')
    return c
  }

  return {
    presetDetail(presetId) {
      const p = preset(presetId)
      if (!p) throw new Error('That preset is not available.')
      const x = extrasFor(p.id)
      const detail: PresetDetail = {
        presetId: p.id,
        name: p.name,
        tagline: p.tagline || null,
        summary: p.summary ?? x.summary ?? p.personality ?? null,
        starterSkills: p.starterSkills ?? x.starterSkills ?? [],
        starterRoutines: p.starterRoutines ?? x.starterRoutines ?? [],
        version: versionOf(p),
      }
      return detail
    },

    presetDiff(companionId) {
      const c = companion(companionId)
      const p = preset(c.persona)
      if (!p) return null
      const base = bases[companionId]
      if (!base || base.presetId !== p.id) {
        // First seen with this preset: what it is now becomes the base.
        bases[companionId] = baseFrom(p)
        write()
        return null
      }
      if (base.version === versionOf(p)) return null
      const next = presetFieldValues(p.name, p.look)
      const yours = presetFieldValues(c.name, c.look)
      const rows: PresetDiffRow[] = []
      for (const field of PRESET_DIFF_FIELDS) {
        if (next[field] === base[field] || next[field] === yours[field]) continue
        rows.push({ field, yours: yours[field], preset: next[field], edited: yours[field] !== base[field] })
      }
      if (rows.length === 0) {
        // Nothing you'd notice changed; the update is taken as seen.
        bases[companionId] = baseFrom(p)
        write()
        return null
      }
      return rows
    },

    applyPresetUpdate(companionId, fields) {
      const c = companion(companionId)
      const p = preset(c.persona)
      if (!p) throw new Error(`This companion isn’t based on a preset ${BRAND_NAME} has.`)
      const take = new Set(fields.filter((f): f is PresetDiffField => (PRESET_DIFF_FIELDS as readonly string[]).includes(f)))
      if (take.size === 0 && !fields.includes(PRESET_UPDATE_ACKNOWLEDGE)) throw new Error('Choose what to take from the update.')
      let updated = c
      if (take.size > 0) {
        const look: CompanionLook = { ...c.look }
        if (take.has('colors')) look.colors = { ...p.look.colors }
        if (take.has('parts')) {
          look.rig = p.look.rig
          look.parts = { ...p.look.parts }
        }
        if (take.has('face')) look.face = { ...p.look.face }
        const patch: { name?: string; look?: CompanionLook } = {}
        if (take.has('name')) patch.name = p.name
        if (take.has('colors') || take.has('parts') || take.has('face')) patch.look = look
        updated = deps.companions.update(companionId, patch)
      }
      bases[companionId] = baseFrom(p)
      write()
      return updated
    },
  }
}
