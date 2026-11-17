/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { z } from 'zod'
import {
  COMPANION_FILE_FORMAT,
  COMPANION_FILE_VERSION,
  COMPANION_INSTRUCTIONS_MAX,
  COMPANION_NAME_MAX,
  COMPANION_SKILL_FILE_MAX_BYTES,
  DEFAULT_PROFILE,
  type Companion,
  type CompanionEffort,
  type CompanionFile,
  type CompanionPreset,
  type CompanionProfile,
  type CompatibilityConfig,
} from '@shared/companion'
import { isEngine, type EngineId } from '@shared/engine'
import { SKILL_DESCRIPTION_MAX, SKILL_FILES_MAX, SKILL_INSTRUCTIONS_MAX, SKILL_MAIN_FILE, isTextSkillFile } from '@shared/skills'
import { lookSchema } from './companion'
import { MODELS, writeAtomic } from './settings'
import { SKILL_NAME, cloneProfile, isLegacyCompanion, migrateCompanion, readJson, sanitizeCompanion, validateSchedule } from './stores'
// Newer-format protection only
import { VERSIONED_FILES, readVersioned } from './migrations/versionedFile'
import { routineScheduleSchema } from './routines/scheduleSchema'

// The user's companions: a list with an active one, stored in
// companions.json. The single profile from before (companion.json) becomes
// the first companion with the fixed id below, so chats migrated to it keep
// pointing at the same companion.

export const FIRST_COMPANION_ID = 'companion-1'
/** Companion ids double as folder names for their memory. */
export const COMPANION_ID = /^[A-Za-z0-9-]{1,64}$/
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** What reset returns to: the name, persona and look the companion was created with. */
interface StoredCompanion extends Companion {
  base: CompanionProfile
}

export interface CompanionsState {
  items: Companion[]
  activeId: string
}

export interface CompanionStoreOptions {
  presets?: () => readonly CompanionPreset[]
  /** Read only to migrate a very old profile. */
  compatibility?: () => CompatibilityConfig
}

export interface NewCompanion {
  presetId?: string
  name?: string
  persona?: string
  look?: unknown
  activate?: boolean
  instructions?: string
  model?: string | null
  effort?: CompanionEffort | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'

export function modelOrNull(value: unknown): string | null {
  return MODELS.find((m) => m === value) ?? null
}

/** A saved engine override, or null (follow the global setting). */
export function engineOrNull(value: unknown): EngineId | null {
  return isEngine(value) ? value : null
}

export function effortOrNull(value: unknown): CompanionEffort | null {
  return EFFORTS.find((e) => e === value) ?? null
}

export function cleanInstructions(value: unknown): string {
  return str(value) ? value.replace(/\r\n?/g, '\n').trim().slice(0, COMPANION_INSTRUCTIONS_MAX) : ''
}

/** `name`, or the same name with " 2", " 3"… when another companion has it (case-insensitive). */
export function uniqueName(name: string, taken: readonly string[], max = COMPANION_NAME_MAX): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  const trimmed = name.trim().slice(0, max).trim() || 'Companion'
  if (!used.has(trimmed.toLowerCase())) return trimmed
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const candidate = `${trimmed.slice(0, max - suffix.length).trimEnd()}${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

function toPublic(stored: StoredCompanion): Companion {
  const { base: _base, ...companion } = stored
  return { ...companion, look: cloneProfile(companion).look }
}

/** Validates one saved companion; null drops it. */
export function sanitizeStoredCompanion(value: unknown, presetIds: readonly string[], now = Date.now()): StoredCompanion | null {
  if (!isObject(value) || !str(value.id) || !COMPANION_ID.test(value.id)) return null
  const profile = sanitizeCompanion(value, DEFAULT_PROFILE, presetIds)
  const base = isObject(value.base) ? sanitizeCompanion(value.base, DEFAULT_PROFILE, presetIds) : cloneProfile(profile)
  return {
    ...profile,
    id: value.id,
    hidden: value.hidden === true,
    instructions: cleanInstructions(value.instructions),
    model: modelOrNull(value.model),
    effort: effortOrNull(value.effort),
    engine: engineOrNull(value.engine),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    base: { name: base.name, persona: base.persona, look: base.look, dockIcon: false },
  }
}

export class CompanionStore extends EventEmitter<{ changed: [CompanionsState] }> {
  readonly #path: string
  readonly #presets: () => readonly CompanionPreset[]
  #items: StoredCompanion[] = []
  #activeId = FIRST_COMPANION_ID

  constructor(dataDir: string, options: CompanionStoreOptions = {}) {
    super()
    this.#path = join(dataDir, 'companions.json')
    this.#presets = options.presets ?? (() => [])
    // A companions.json from a newer Atelier is copied aside before anything here can rewrite it.
    const raw = readVersioned(this.#path, VERSIONED_FILES.companions, (value) => value).value
    const ids = this.#presetIds()
    if (isObject(raw) && Array.isArray(raw.companions)) {
      const seen = new Set<string>()
      for (const item of raw.companions) {
        const companion = sanitizeStoredCompanion(item, ids)
        if (companion && !seen.has(companion.id)) {
          seen.add(companion.id)
          this.#items.push(companion)
        }
      }
      if (str(raw.activeId)) this.#activeId = raw.activeId
    }
    if (this.#items.length === 0) {
      this.#items = [this.#migrate(dataDir, options.compatibility ?? (() => ({})))]
      this.#activeId = FIRST_COMPANION_ID
      this.#write()
    }
    this.#repair()
  }

  list(): Companion[] {
    return this.#items.map(toPublic)
  }

  state(): CompanionsState {
    return { items: this.list(), activeId: this.#activeId }
  }

  find(id: string): Companion | undefined {
    const found = this.#items.find((c) => c.id === id)
    return found ? toPublic(found) : undefined
  }

  /** A companion by id; the active one without an id. */
  get(id: string = this.#activeId): Companion {
    return toPublic(this.#stored(id))
  }

  activeId(): string {
    return this.#activeId
  }

  active(): Companion {
    return this.get(this.#activeId)
  }

  setActive(id: string): Companion {
    const target = this.#stored(id)
    if (target.hidden) throw new Error('Show this companion again before choosing it.')
    if (this.#activeId !== id) {
      this.#activeId = id
      this.#commit()
    }
    return toPublic(target)
  }

  /** Applies the valid fields of `patch`: name, persona, look, dockIcon, instructions, model and effort. */
  update(id: string, patch: unknown): Companion {
    const current = this.#stored(id)
    const profile = sanitizeCompanion(patch, current, this.#presetIds())
    const next: StoredCompanion = { ...current, name: profile.name, persona: profile.persona, look: profile.look, dockIcon: profile.dockIcon }
    if (isObject(patch)) {
      if ('instructions' in patch) next.instructions = cleanInstructions(patch.instructions)
      if ('model' in patch) next.model = modelOrNull(patch.model)
      if ('effort' in patch) next.effort = effortOrNull(patch.effort)
      if ('engine' in patch) next.engine = engineOrNull(patch.engine)
    }
    this.#replace(next)
    return toPublic(next)
  }

  /** Adds a companion from a preset, or from the given look (shuffled by the chrome). Names get a suffix on a clash. */
  create(input: NewCompanion, now = Date.now()): Companion {
    const preset = input.presetId ? this.#presets().find((p) => p.id === input.presetId) : undefined
    if (input.presetId && !preset) throw new Error('That preset is not available.')
    const ids = this.#presetIds()
    let persona = input.persona ?? preset?.id ?? 'custom'
    // A persona this Atelier doesn't ship (an imported file) has no personality text.
    if (ids.length > 0 && persona !== 'custom' && !ids.includes(persona)) persona = 'custom'
    const profile = sanitizeCompanion(
      { name: input.name ?? preset?.name ?? 'New companion', persona, look: input.look ?? preset?.look, dockIcon: false },
      { ...DEFAULT_PROFILE, persona: 'custom' },
      ids,
    )
    const companion: StoredCompanion = {
      ...profile,
      name: uniqueName(profile.name, this.#items.map((c) => c.name)),
      id: randomUUID(),
      hidden: false,
      instructions: cleanInstructions(input.instructions),
      model: modelOrNull(input.model),
      effort: effortOrNull(input.effort),
      engine: null,
      createdAt: now,
      base: { ...cloneProfile(profile), dockIcon: false },
    }
    this.#items.push(companion)
    if (input.activate !== false) this.#activeId = companion.id
    this.#commit()
    return toPublic(companion)
  }

  /** A visible copy with a suffixed name; it does not become active. */
  duplicate(id: string, now = Date.now()): Companion {
    const source = this.#stored(id)
    const copy: StoredCompanion = {
      ...structuredClone(source),
      id: randomUUID(),
      name: uniqueName(source.name, this.#items.map((c) => c.name)),
      hidden: false,
      dockIcon: false,
      createdAt: now,
    }
    this.#items.push(copy)
    this.#commit()
    return toPublic(copy)
  }

  setHidden(id: string, hidden: boolean): void {
    const target = this.#stored(id)
    if (target.hidden === hidden) return
    if (hidden && this.#visible().length <= 1) throw new Error('Keep at least one companion visible.')
    this.#replace({ ...target, hidden }, false)
    if (hidden && this.#activeId === id) this.#activeId = this.#visible()[0]?.id ?? this.#activeId
    this.#commit()
  }

  reset(id: string): Companion {
    const current = this.#stored(id)
    const next: StoredCompanion = {
      ...current,
      name: current.base.name,
      persona: current.base.persona,
      look: cloneProfile(current.base).look,
      instructions: '',
      model: null,
      effort: null,
      engine: null,
    }
    this.#replace(next)
    return toPublic(next)
  }

  /** Refuses the last visible companion. Removing the active one makes the next visible one active. */
  remove(id: string): void {
    const target = this.#stored(id)
    if (!target.hidden && this.#visible().length <= 1) {
      throw new Error(`${BRAND_NAME} needs at least one companion. Add another one before deleting this one.`)
    }
    this.#items = this.#items.filter((c) => c.id !== id)
    if (this.#activeId === id) this.#activeId = this.#visible()[0]?.id ?? this.#items[0]?.id ?? FIRST_COMPANION_ID
    this.#commit()
  }

  #migrate(dataDir: string, compatibility: () => CompatibilityConfig): StoredCompanion {
    const legacy = readJson(join(dataDir, 'companion.json'))
    const ids = this.#presetIds()
    const profile = isLegacyCompanion(legacy) ? migrateCompanion(legacy, compatibility()) : sanitizeCompanion(legacy, DEFAULT_PROFILE, ids)
    return {
      ...profile,
      id: FIRST_COMPANION_ID,
      hidden: false,
      instructions: '',
      model: null,
      effort: null,
      engine: null,
      createdAt: Date.now(),
      base: { ...cloneProfile(profile), dockIcon: false },
    }
  }

  /** Keeps the invariants: at least one visible companion, and an active one that exists and is visible. */
  #repair(): void {
    let dirty = false
    if (this.#visible().length === 0 && this.#items[0]) {
      this.#items[0] = { ...this.#items[0], hidden: false }
      dirty = true
    }
    const active = this.#items.find((c) => c.id === this.#activeId)
    if (!active || active.hidden) {
      this.#activeId = this.#visible()[0]?.id ?? FIRST_COMPANION_ID
      dirty = true
    }
    if (dirty) this.#write()
  }

  #presetIds(): string[] {
    return this.#presets().map((p) => p.id)
  }

  #visible(): StoredCompanion[] {
    return this.#items.filter((c) => !c.hidden)
  }

  #stored(id: string): StoredCompanion {
    const found = this.#items.find((c) => c.id === id)
    if (!found) throw new Error('That companion no longer exists.')
    return found
  }

  #replace(next: StoredCompanion, commit = true): void {
    this.#items = this.#items.map((c) => (c.id === next.id ? next : c))
    if (commit) this.#commit()
  }

  #commit(): void {
    this.#write()
    this.emit('changed', this.state())
  }

  #write(): void {
    writeAtomic(this.#path, JSON.stringify({ version: VERSIONED_FILES.companions, activeId: this.#activeId, companions: this.#items }, null, 2))
  }
}

// ---- .ateliercompanion files ----

export const scheduleSchema = z.union([
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('daily'), time: z.string().max(5), days: z.array(z.number().int().min(0).max(6)).max(7) }),
    z.object({ kind: z.literal('interval'), hours: z.number().min(1).max(168) }),
  ]),
  // Newer exported files carry full routine schedules (minutes, cron, once).
  routineScheduleSchema,
])

/** Memory paths a file may carry: inside /memories, never the shared folder, no traversal. */
const importedMemoryPath = z
  .string()
  .max(512)
  .regex(/^\/memories\/[^\0]+$/)
  .refine((p) => !p.split('/').includes('..') && p !== '/memories/shared' && !p.startsWith('/memories/shared/'))

// A skill's supporting file: a relative path to a text file inside its folder, never SKILL.md itself.
const skillFilePath = z
  .string()
  .max(300)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((part) => part === '' || part === '.' || part === '..') && p !== SKILL_MAIN_FILE && isTextSkillFile(p))

const companionSkillSchema = z
  .object({
    name: z.string().regex(SKILL_NAME),
    description: z.string().max(SKILL_DESCRIPTION_MAX),
    instructions: z.string().max(SKILL_INSTRUCTIONS_MAX),
    steps: z.array(z.object({ title: z.string().max(200), instructions: z.string().max(20_000) })).max(50).optional(),
    files: z.array(z.object({ path: skillFilePath, text: z.string().max(COMPANION_SKILL_FILE_MAX_BYTES) })).max(SKILL_FILES_MAX).optional(),
  })
  // A workflow may be all steps; a skill with neither has nothing to do.
  .refine((s) => s.instructions.trim() !== '' || (s.steps ?? []).some((step) => step.title.trim() || step.instructions.trim()))

const companionFileSchema = z.object({
  format: z.literal(COMPANION_FILE_FORMAT),
  version: z.number().int().min(1).max(COMPANION_FILE_VERSION),
  exportedAt: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(200),
  persona: z.string().max(64),
  look: lookSchema,
  instructions: z.string().max(COMPANION_INSTRUCTIONS_MAX * 2).default(''),
  // A model or effort this Atelier doesn't know falls back to the global default.
  model: z.string().max(100).nullable().optional(),
  effort: z.string().max(16).nullable().optional(),
  note: z.string().max(500).optional(),
  skills: z.array(companionSkillSchema).max(200).optional(),
  routines: z.array(z.object({ name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(10_000), schedule: scheduleSchema })).max(50).optional(),
  memory: z.array(z.object({ path: importedMemoryPath, text: z.string().max(256 * 1024) })).max(500).optional(),
})

export const COMPANION_FILE_MAX_BYTES = 8 * 1024 * 1024

/** Parses and validates a .ateliercompanion file's text, with errors written for the person importing it. */
export function parseCompanionFile(text: string): CompanionFile {
  if (Buffer.byteLength(text) > COMPANION_FILE_MAX_BYTES) throw new Error('This companion file is too large to import.')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`This file isn't a companion file for ${BRAND_NAME}.`)
  }
  if (!isObject(raw) || raw.format !== COMPANION_FILE_FORMAT) throw new Error(`This file isn't a companion file for ${BRAND_NAME}.`)
  if (typeof raw.version === 'number' && raw.version > COMPANION_FILE_VERSION) {
    throw new Error(`This companion was exported from a newer version of ${BRAND_NAME}. Update ${BRAND_NAME}, then import it again.`)
  }
  const parsed = companionFileSchema.safeParse(raw)
  if (!parsed.success) throw new Error("This companion file is damaged or incomplete, so it can't be imported.")
  const file = parsed.data
  for (const routine of file.routines ?? []) {
    try {
      validateSchedule(routine.schedule)
    } catch {
      throw new Error("This companion file is damaged or incomplete, so it can't be imported.")
    }
  }
  return {
    ...file,
    exportedAt: file.exportedAt ?? '',
    name: file.name.slice(0, COMPANION_NAME_MAX).trim(),
    instructions: cleanInstructions(file.instructions),
    model: modelOrNull(file.model),
    effort: effortOrNull(file.effort),
  }
}

export interface CompanionFileExtras {
  note?: string
  skills?: CompanionFile['skills']
  routines?: CompanionFile['routines']
  memory?: CompanionFile['memory']
}

export function companionFile(companion: Companion, extras: CompanionFileExtras = {}, now = new Date()): CompanionFile {
  const note = extras.note?.trim()
  return {
    format: COMPANION_FILE_FORMAT,
    version: COMPANION_FILE_VERSION,
    exportedAt: now.toISOString(),
    name: companion.name,
    persona: companion.persona,
    look: cloneProfile(companion).look,
    instructions: companion.instructions,
    model: companion.model,
    effort: companion.effort,
    ...(note ? { note: note.slice(0, 500) } : {}),
    ...(extras.skills ? { skills: extras.skills } : {}),
    ...(extras.routines ? { routines: extras.routines } : {}),
    ...(extras.memory ? { memory: extras.memory } : {}),
  }
}
