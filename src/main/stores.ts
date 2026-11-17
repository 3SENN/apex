/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHARED_OWNER } from '@shared/chats'
import {
  DEFAULT_PROFILE,
  FACE_IDS,
  FACE_LAYERS,
  PART_IDS,
  PART_SLOTS,
  RIGS,
  TINTS,
  type CompanionLook,
  type CompanionProfile,
  type CompatibilityConfig,
  type PartSlot,
} from '@shared/companion'
import { normalizeAdjust, normalizeLook } from '@shared/companionLogic'
import type {
  Owner,
  RoutineSchedule,
} from '@shared/services'
import { HEX_COLOR, PERSONA_ID } from './companion'
import { nextRunAfter as nextScheduledRun } from './routines/schedule'
import { writeAtomic } from './settings'

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** A small persisted list of records with ids. Emits 'changed' after writes. */
export class JsonCollection<T extends { id: string }> extends EventEmitter<{ changed: [T[]] }> {
  readonly #path: string
  #items: T[]

  /** `normalize` fills fields added since an item was saved (for example owners, which default to shared). */
  constructor(path: string, isItem: (value: unknown) => value is T, normalize: (item: T) => T = (item) => item) {
    super()
    this.#path = path
    const raw = readJson(path)
    this.#items = Array.isArray(raw) ? raw.filter(isItem).map(normalize) : []
  }

  list(): T[] {
    return this.#items.slice()
  }

  get(id: string): T | undefined {
    return this.#items.find((item) => item.id === id)
  }

  upsert(item: T): T {
    const index = this.#items.findIndex((existing) => existing.id === item.id)
    if (index === -1) this.#items.push(item)
    else this.#items[index] = item
    this.#save()
    return item
  }

  remove(id: string): void {
    const before = this.#items.length
    this.#items = this.#items.filter((item) => item.id !== id)
    if (this.#items.length !== before) this.#save()
  }

  replaceAll(items: T[]): void {
    this.#items = items
    this.#save()
  }

  #save(): void {
    writeAtomic(this.#path, JSON.stringify(this.#items, null, 2))
    this.emit('changed', this.list())
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown): v is string => typeof v === 'string'

/** Items saved before owners existed belong to every companion. */
export function ownerOf(value: unknown): Owner {
  return str(value) && value.length > 0 ? value : SHARED_OWNER
}

// ---- bookmarks ----

// The store moved to bookmarks.ts with the tree; this keeps old imports working.
export { BookmarkStore } from './bookmarks'

// ---- skills ---- (folders under userData/skills; see ./skills/store)

export { SKILL_NAME, SkillStore, expandSkill } from './skills/store'

// ---- routines ---- (see ./routines/store and ./routines/schedule)

export { RoutineStore } from './routines/store'
export { validateSchedule } from './routines/schedule'

/** The original signature: the next run strictly after `from`; throws when the schedule never runs again. */
export function nextRunAfter(schedule: RoutineSchedule, from: number): number {
  const next = nextScheduledRun(schedule, from, null)
  if (next === null) throw new Error('The schedule has no valid days.')
  return next
}

// ---- connectors ----
// The store lives in connectors/store.ts (Connector v2); the original names stay importable from here.
export { ConnectorStore, connectorName, validateConnectorUrl, type ResolvedConnector } from './connectors/store'

// ---- companion ----

const includes = (list: readonly string[], value: unknown): value is string => typeof value === 'string' && list.includes(value)

export function cloneProfile(profile: CompanionProfile): CompanionProfile {
  const { look } = profile
  return { ...profile, look: { rig: look.rig, parts: { ...look.parts }, face: { ...look.face }, colors: { ...look.colors }, ...(look.adjust ? { adjust: { ...look.adjust } } : {}) } }
}

/**
 * Validates a look field by field over `base`: missing fields keep the base
 * value, unknown part ids empty their slot (the head falls back to the
 * base head), and invalid face ids and colours keep the base.
 */
export function sanitizeLook(value: unknown, base: CompanionLook = DEFAULT_PROFILE.look): CompanionLook {
  const look = isObject(value) ? value : {}
  const parts = isObject(look.parts) ? look.parts : {}
  const face = isObject(look.face) ? look.face : {}
  const colors = isObject(look.colors) ? look.colors : {}
  const out: CompanionLook = {
    rig: includes(RIGS, look.rig) ? (look.rig as CompanionLook['rig']) : base.rig,
    parts: { ...base.parts },
    face: { ...base.face },
    colors: { ...base.colors },
  }
  for (const slot of PART_SLOTS) {
    if (!Object.hasOwn(parts, slot)) continue
    const id = parts[slot]
    if (includes(PART_IDS[slot], id)) out.parts[slot] = id
    else if (slot !== 'head') out.parts[slot] = null
  }
  for (const layer of FACE_LAYERS) {
    const id = face[layer]
    if (includes(FACE_IDS[layer], id)) out.face[layer] = id
  }
  for (const tint of TINTS) {
    const color = colors[tint]
    if (str(color) && HEX_COLOR.test(color)) out.colors[tint] = color.toLowerCase()
  }
  // DS-120: adjustments are clamped; a look (or file) without them stays exactly as it was.
  const adjust = normalizeAdjust(look.adjust)
  if (adjust) out.adjust = adjust
  return out
}

/**
 * Merges the valid fields of `value` over `base`. Personas must be a known
 * preset id or 'custom'; while the preset list is unavailable, any id-shaped
 * persona is kept so a missing asset file does not reset the profile.
 */
export function sanitizeCompanion(value: unknown, base: CompanionProfile = DEFAULT_PROFILE, presetIds: readonly string[] = []): CompanionProfile {
  const out = cloneProfile(base)
  if (!isObject(value)) return out
  if (str(value.name)) {
    const name = value.name.trim().slice(0, 24).trim()
    if (name) out.name = name
  }
  if (str(value.persona) && (value.persona === 'custom' || (presetIds.length > 0 ? presetIds.includes(value.persona) : PERSONA_ID.test(value.persona)))) {
    out.persona = value.persona
  }
  if (value.look !== undefined) out.look = sanitizeLook(value.look, base.look)
  if (typeof value.dockIcon === 'boolean') out.dockIcon = value.dockIcon
  return out
}

// The first companion was a fixed character with a colour, an accessory and
// an eye style. These map it onto the modular look.
const LEGACY_COLORS: Record<string, CompanionLook['colors']> = {
  violet: { skin: '#8f74f8', hair: '#4b3aa8', accent: '#c9bbff', outfit: '#6a4bff' },
  coral: { skin: '#ff8f7a', hair: '#a8402f', accent: '#ffc2b5', outfit: '#e8604b' },
  mint: { skin: '#62d6b3', hair: '#22735e', accent: '#b7f1df', outfit: '#2fae8a' },
  sky: { skin: '#6fb9ff', hair: '#2a5f9a', accent: '#c0e0ff', outfit: '#3a86d6' },
  sunflower: { skin: '#ffcd52', hair: '#9a6d10', accent: '#ffe7a6', outfit: '#e0a21c' },
  slate: { skin: '#8d97aa', hair: '#3d4555', accent: '#d3d9e4', outfit: '#5c6679' },
}

const LEGACY_ACCESSORIES: Record<string, [PartSlot, string]> = {
  beanie: ['hat', 'hat-beanie'],
  cap: ['hat', 'hat-cap'],
  crown: ['hat', 'hat-crown'],
  flower: ['hat', 'hat-flower-crown'],
  headphones: ['earAccessory', 'headphones'],
}

const LEGACY_EYES: Record<string, string> = { round: 'eyes-round', sleepy: 'eyes-sleepy', sparkle: 'eyes-sparkle' }

export function isLegacyCompanion(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !('look' in value) && ('color' in value || 'accessory' in value || 'eyes' in value)
}

/**
 * Converts a `{ name, color, accessory, eyes }` profile. It had no
 * personality, so the persona is 'custom'. `compat` holds the generated part
 * rules: an old hat replaces default hair or ears it does not go with, as it
 * would anywhere else.
 */
export function migrateCompanion(old: Record<string, unknown>, compat: CompatibilityConfig = {}): CompanionProfile {
  const look = sanitizeLook({}, DEFAULT_PROFILE.look)
  const colors = str(old.color) ? LEGACY_COLORS[old.color] : undefined
  if (colors) look.colors = { ...colors }
  const accessory = str(old.accessory) ? LEGACY_ACCESSORIES[old.accessory] : undefined
  if (accessory) look.parts[accessory[0]] = accessory[1]
  const eyes = str(old.eyes) ? LEGACY_EYES[old.eyes] : undefined
  if (eyes) look.face.eyes = eyes
  return sanitizeCompanion({ name: old.name, persona: 'custom', look: normalizeLook(look, compat), dockIcon: false })
}
