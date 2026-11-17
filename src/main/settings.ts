/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { PANEL_WIDTH, SIDEBAR_WIDTH, type NestedSettingsGroup, type Settings, type SettingsView, type SidebarOptions, type WindowState } from '@shared/ipc'
import { DEFAULT_PROFILE_ID, defaultProfile, type Profile } from '@shared/profiles'
import { DESTINATIONS, type Destination } from '@shared/url'
import { BUILT_IN_ENGINE_IDS } from '@shared/searchEngines'
import { NO_SECOND_LOCALE } from '@shared/speech'
import { registerSecret } from './log'
import { MODELS, NESTED_GROUP_SCOPES, SETTINGS, defineSettings, topLevelKeysOfScope, type SettingDef } from '@shared/settingsRegistry'
import { PROFILE_SETTINGS_FILE, profileDataDir } from './profiles/paths'
import { NESTED_SETTINGS_DEFAULTS, NESTED_SETTINGS_PATCH_SCHEMAS, NESTED_SETTINGS_SCHEMAS, isObjectSchema, mergeNestedSettingsPatch, migrateNestedGroup, normalizeNestedSettings } from './nestedSettings'
// Newer-format protection only
import { VERSIONED_FILES, readVersioned } from './migrations/versionedFile'

// ST-06: every setting is registered once in @shared/settingsRegistry
// with its schema, default and scope; this file assembles Settings from it.
// The nested groups keep their schemas in nestedSettings.ts and register here.
export { MODELS }

/** The nested setting groups, registered like every other setting. */
export const NESTED_SETTINGS_REGISTRY = defineSettings({
  voice: { scope: NESTED_GROUP_SCOPES.voice, schema: NESTED_SETTINGS_SCHEMAS.voice, default: NESTED_SETTINGS_DEFAULTS.voice },
  transcription: { scope: NESTED_GROUP_SCOPES.transcription, schema: NESTED_SETTINGS_SCHEMAS.transcription, default: NESTED_SETTINGS_DEFAULTS.transcription },
  meetingCards: { scope: NESTED_GROUP_SCOPES.meetingCards, schema: NESTED_SETTINGS_SCHEMAS.meetingCards, default: NESTED_SETTINGS_DEFAULTS.meetingCards },
  autofill: { scope: NESTED_GROUP_SCOPES.autofill, schema: NESTED_SETTINGS_SCHEMAS.autofill, default: NESTED_SETTINGS_DEFAULTS.autofill },
})

type TopKey = Exclude<keyof Settings, 'sidebar' | NestedSettingsGroup>
type SidebarLeaf = Exclude<keyof SidebarOptions, 'destinations'>
const DEFS = SETTINGS as unknown as Record<string, SettingDef<unknown>>
const SIDEBAR = 'sidebar.'
const DESTINATION = 'sidebar.destinations.'

/** The registered keys directly under a dotted prefix ('' for the top level). */
function leavesOf(prefix: string): string[] {
  return Object.keys(DEFS).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('.'))
}
const shapeOf = (prefix: string): Record<string, z.ZodType> => Object.fromEntries(leavesOf(prefix).map((k) => [k.slice(prefix.length), DEFS[k]!.schema]))
const defaultsOf = (prefix: string): Record<string, unknown> => Object.fromEntries(leavesOf(prefix).map((k) => [k.slice(prefix.length), structuredClone(DEFS[k]!.default)]))

/** The engines Apex ships (the whole Settings › Search catalogue); settings.searchEngine may also name a custom engine. */
export const BUILT_IN_ENGINES: readonly string[] = BUILT_IN_ENGINE_IDS

const DEFAULT_SIDEBAR = { ...defaultsOf(SIDEBAR), destinations: defaultsOf(DESTINATION) } as unknown as SidebarOptions

export const DEFAULT_SETTINGS: Settings = {
  ...(defaultsOf('') as { [K in TopKey]: Settings[K] }),
  sidebar: DEFAULT_SIDEBAR,
  ...NESTED_SETTINGS_DEFAULTS,
}

const destinationsSchema = z.object(shapeOf(DESTINATION) as Record<Destination, z.ZodBoolean>)

const sidebarSchema = z.object({ ...(shapeOf(SIDEBAR) as { [K in SidebarLeaf]: z.ZodType<SidebarOptions[K]> }), destinations: destinationsSchema })

const settingsSchema = z.object({
  ...(shapeOf('') as { [K in TopKey]: z.ZodType<Settings[K]> }),
  sidebar: sidebarSchema,
  ...NESTED_SETTINGS_SCHEMAS,
})

/** Settings keys by scope: app keys live in settings.json, profile keys in each profile's profile-settings.json. */
export const APP_KEYS = topLevelKeysOfScope('app') as (keyof Settings)[]
export const PROFILE_KEYS = topLevelKeysOfScope('profile') as (keyof Settings)[]

/** The registered destinations, for the completeness test. */
export const REGISTERED_DESTINATIONS = leavesOf(DESTINATION).map((k) => k.slice(DESTINATION.length))

/** What the chrome may send: any subset, with the sidebar options merged field by field. */
export const settingsPatchSchema = settingsSchema
  .omit({ sidebar: true })
  .partial()
  .extend({ sidebar: sidebarSchema.omit({ destinations: true }).partial().extend({ destinations: destinationsSchema.partial().optional() }).strict().optional() })
  // The nested groups take any subset of their fields, merged one level deep.
  .extend(NESTED_SETTINGS_PATCH_SCHEMAS)
  .strict()

type SettingsPatch = z.infer<typeof settingsPatchSchema>

export function applySettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
  const { sidebar, ...rest } = patch
  // Nested groups merge one level deep, then the cross-field rules apply.
  const next: Settings = normalizeNestedSettings({ ...settings, ...rest, ...mergeNestedSettingsPatch(settings, rest) })
  // NT-01: picking an engine anywhere (setup, the new tab, Settings › Search) means the choice was made.
  if (rest.searchEngine !== undefined && rest.searchEngineChosen === undefined) next.searchEngineChosen = true
  if (sidebar) {
    const { destinations, ...sidebarRest } = sidebar
    next.sidebar = { ...settings.sidebar, ...sidebarRest, destinations: { ...settings.sidebar.destinations, ...destinations } }
  }
  return next
}

const clamp = (value: number, min: number, max: number): number => Math.round(Math.min(max, Math.max(min, value)))

/**
 * Turns whatever is on disk into valid settings. Each valid field is kept and
 * each invalid one falls back to its default on its own, so one bad value
 * never resets everything. Older files are migrated: the showBookmarksBar
 * boolean became the bookmarksBar mode, and out-of-range widths are clamped.
 */
export function migrateSettings(raw: unknown): Settings {
  const merged: Settings = structuredClone(DEFAULT_SETTINGS)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return merged
  const source = raw as Record<string, unknown>
  for (const [key, field] of Object.entries(settingsSchema.shape)) {
    if (key === 'sidebar' || !Object.hasOwn(source, key)) continue
    // A nested group falls back field by field, like the sidebar below.
    if (isObjectSchema(field as z.ZodType)) {
      Object.assign(merged, { [key]: migrateNestedGroup(merged[key as keyof Settings] as object, field as z.ZodObject<z.ZodRawShape>, source[key]) })
      continue
    }
    const parsed = (field as z.ZodType).safeParse(source[key])
    if (parsed.success) Object.assign(merged, { [key]: parsed.data })
  }
  const sidebar = source.sidebar
  if (sidebar && typeof sidebar === 'object' && !Array.isArray(sidebar)) {
    const fields = sidebar as Record<string, unknown>
    for (const [key, field] of Object.entries(sidebarSchema.shape)) {
      if (key === 'destinations' || !Object.hasOwn(fields, key)) continue
      const parsed = (field as z.ZodType).safeParse(fields[key])
      if (parsed.success) Object.assign(merged.sidebar, { [key]: parsed.data })
    }
    const destinations = fields.destinations
    if (destinations && typeof destinations === 'object') {
      for (const d of DESTINATIONS) {
        const value = (destinations as Record<string, unknown>)[d]
        if (typeof value === 'boolean') merged.sidebar.destinations[d] = value
      }
    }
  }
  // An engine id that is neither built in
  // nor one of the custom engines (a removed engine, a typo) falls back.
  if (!BUILT_IN_ENGINES.includes(merged.searchEngine) && !merged.customSearchEngines.some((e) => e.id === merged.searchEngine)) {
    merged.searchEngine = DEFAULT_SETTINGS.searchEngine
  }
  // NT-01: a profile saved before the flag that already moved off the default engine has chosen one.
  if (!Object.hasOwn(source, 'searchEngineChosen') && merged.searchEngine !== DEFAULT_SETTINGS.searchEngine) merged.searchEngineChosen = true
  // 1.3.2: meetings listen in one language by default. A file from before Record audio only existed
  // moves Automatic (1.3.1's default) to One language only once; a language you picked stays, and so
  // does Keep audio recordings (its old default and a deliberate off look the same).
  const transcription = source.transcription
  if (transcription && typeof transcription === 'object' && !Object.hasOwn(transcription, 'recordOnly')) {
    if (merged.transcription.secondaryLocale === null) merged.transcription.secondaryLocale = NO_SECOND_LOCALE
  }
  if (!Object.hasOwn(source, 'bookmarksBar') && typeof source.showBookmarksBar === 'boolean') {
    merged.bookmarksBar = source.showBookmarksBar ? 'always' : 'never'
  }
  if (typeof source.sidebarWidth === 'number' && Number.isFinite(source.sidebarWidth)) {
    merged.sidebarWidth = clamp(source.sidebarWidth, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)
  }
  if (typeof source.panelWidth === 'number' && Number.isFinite(source.panelWidth)) {
    merged.panelWidth = clamp(source.panelWidth, PANEL_WIDTH.min, PANEL_WIDTH.max)
  }
  return normalizeNestedSettings(merged)
}

const pick = (settings: Settings, keys: readonly (keyof Settings)[]): Partial<Settings> => Object.fromEntries(keys.map((k) => [k, settings[k]])) as Partial<Settings>
const differs = (a: Settings, b: Settings, keys: readonly (keyof Settings)[]): boolean => keys.some((k) => !isDeepStrictEqual(a[k], b[k]))

export interface SettingsStoreOptions {
  /** A profile's data folder; the data folder itself for the default profile. */
  profileDir?(id: string): string
}

/**
 * The settings, split by scope (ST-06): app keys in the data folder's
 * settings.json, profile keys in each profile's profile-settings.json. A
 * window reads its profile's view (getFor, viewFor) and every patch goes
 * through updateFor, which routes each key to its scope's file. get,
 * update and view act for the default profile, so code that
 * predates profiles keeps working. 'changed' follows the default profile;
 * 'profileChanged' fires for each loaded profile an update reaches (every
 * one for an app key, just that one for a profile key).
 */
export class SettingsStore extends EventEmitter<{ changed: [next: Settings, previous: Settings]; profileChanged: [profileId: string, next: Settings, previous: Settings] }> {
  readonly #settingsPath: string
  readonly #keyPath: string
  readonly #profileDir: (id: string) => string
  /** Only the app keys are meaningful here. */
  #app: Settings
  /** Each loaded profile's settings; only the profile keys are meaningful. */
  readonly #profiles = new Map<string, Settings>()
  #resolveProfile: ((id: string) => Profile | null) | null = null

  constructor(dataDir: string, options: SettingsStoreOptions = {}) {
    super()
    // Every window listens for its profile's changes.
    this.setMaxListeners(0)
    this.#settingsPath = join(dataDir, 'settings.json')
    this.#keyPath = join(dataDir, 'anthropic-key.bin')
    this.#profileDir = options.profileDir ?? ((id) => profileDataDir(dataDir, id))
    this.#app = this.#load()
  }

  get(): Settings {
    return this.getFor(DEFAULT_PROFILE_ID)
  }

  /** One profile's settings: the app keys plus that profile's keys. */
  getFor(profileId: string): Settings {
    return structuredClone(this.#merged(profileId))
  }

  update(patch: unknown): Settings {
    return this.updateFor(DEFAULT_PROFILE_ID, patch)
  }

  /** Applies a patch for one profile's window: app keys reach every profile, profile keys only this one. */
  updateFor(profileId: string, patch: unknown): Settings {
    const parsed = settingsPatchSchema.parse(patch)
    const before = new Map([...this.#profileIds(profileId)].map((id) => [id, this.#merged(id)]))
    const previous = before.get(profileId)!
    const next = applySettingsPatch(previous, parsed)
    const appChanged = differs(next, previous, APP_KEYS)
    const profileChanged = differs(next, previous, PROFILE_KEYS)
    if (appChanged) this.#app = { ...this.#app, ...pick(next, APP_KEYS) }
    if (profileChanged) {
      this.#profiles.set(profileId, { ...this.#profile(profileId), ...pick(next, PROFILE_KEYS) })
      this.#write(this.#profilePath(profileId), pick(next, PROFILE_KEYS))
    }
    if (appChanged || (profileChanged && profileId === DEFAULT_PROFILE_ID)) this.#writeApp()
    // The patched profile always hears back (callers expect an event per update); the rest only for app keys.
    for (const [id, prev] of before) {
      if (id !== profileId && !appChanged) continue
      const now = this.getFor(id)
      this.emit('profileChanged', id, now, structuredClone(prev))
      if (id === DEFAULT_PROFILE_ID) this.emit('changed', now, structuredClone(prev))
    }
    return this.getFor(profileId)
  }

  /** Sets up a new profile's file: the defaults, with any starting values (the chosen hue). */
  createProfile(profileId: string, initial: Partial<Settings> = {}): Settings {
    const settings = migrateSettings({ ...pick(DEFAULT_SETTINGS, PROFILE_KEYS), ...initial })
    this.#profiles.set(profileId, settings)
    this.#write(this.#profilePath(profileId), pick(settings, PROFILE_KEYS))
    return this.getFor(profileId)
  }

  /** Drops a deleted profile from memory and disk. */
  forgetProfile(profileId: string): void {
    if (profileId === DEFAULT_PROFILE_ID) return
    this.#profiles.delete(profileId)
    rmSync(this.#profilePath(profileId), { force: true })
  }

  /** Where SettingsView.profile comes from (the ProfileManager). */
  setProfileResolver(resolve: ((id: string) => Profile | null) | null): void {
    this.#resolveProfile = resolve
  }

  /** The saved key wins over ANTHROPIC_API_KEY so the user can override it. */
  apiKey(): string | null {
    // Never in a log line
    const key = this.#readApiKey()
    if (key) registerSecret(key)
    return key
  }

  #readApiKey(): string | null {
    if (existsSync(this.#keyPath) && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(readFileSync(this.#keyPath))
      } catch {
        return null
      }
    }
    return process.env.ANTHROPIC_API_KEY?.trim() || null
  }

  setApiKey(key: string | null): void {
    if (key === null || key.trim() === '') {
      rmSync(this.#keyPath, { force: true })
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure storage is unavailable on this system, so the key cannot be saved. Set ANTHROPIC_API_KEY instead.')
      }
      writeAtomic(this.#keyPath, safeStorage.encryptString(key.trim()))
      // A new key is redacted from the moment it is saved.
      registerSecret(key.trim())
    }
    // The key status is part of every profile's settings view (the key itself stays app-wide).
    for (const id of this.#profileIds()) {
      this.emit('profileChanged', id, this.getFor(id), this.getFor(id))
      if (id === DEFAULT_PROFILE_ID) this.emit('changed', this.get(), this.get())
    }
  }

  view(): SettingsView {
    return this.viewFor(DEFAULT_PROFILE_ID)
  }

  /** A window's view: the app settings, its profile's settings and the profile itself. */
  viewFor(profileId: string): SettingsView {
    const saved = existsSync(this.#keyPath)
    const env = Boolean(process.env.ANTHROPIC_API_KEY?.trim())
    const settings = this.getFor(profileId)
    const profile = this.#resolveProfile?.(profileId) ?? (profileId === DEFAULT_PROFILE_ID ? defaultProfile(settings.profileHue) : null)
    return {
      ...settings,
      hasApiKey: saved || env,
      apiKeySource: saved ? 'saved' : env ? 'environment' : 'none',
      ...(profile ? { profile } : {}),
    }
  }

  #merged(profileId: string): Settings {
    return normalizeNestedSettings({ ...this.#profile(profileId), ...pick(this.#app, APP_KEYS) } as Settings)
  }

  #profile(profileId: string): Settings {
    let settings = this.#profiles.get(profileId)
    if (!settings) {
      settings = this.#read(this.#profilePath(profileId))
      this.#profiles.set(profileId, settings)
    }
    return settings
  }

  /** The default profile, every loaded one, and the one being patched. */
  #profileIds(extra?: string): Set<string> {
    return new Set([DEFAULT_PROFILE_ID, ...this.#profiles.keys(), ...(extra ? [extra] : [])])
  }

  #profilePath(profileId: string): string {
    return join(this.#profileDir(profileId), PROFILE_SETTINGS_FILE)
  }

  #read(path: string): Settings {
    try {
      // A file from a newer Apex is copied aside before the field-by-field fallback reads it.
      return readVersioned(path, VERSIONED_FILES.settings, migrateSettings).value ?? structuredClone(DEFAULT_SETTINGS)
    } catch {
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  /**
   * settings.json: the app keys, plus a copy of the default profile's keys
   * so an older Apex that predates profiles still finds its theme and search
   * engine. This build reads those from the profile file.
   */
  #writeApp(): void {
    this.#write(this.#settingsPath, { ...pick(this.#profile(DEFAULT_PROFILE_ID), PROFILE_KEYS), ...pick(this.#app, APP_KEYS) })
  }

  #write(path: string, values: Partial<Settings>): void {
    mkdirSync(dirname(path), { recursive: true })
    // The format marker lets an older Apex spot a newer file and keep a copy.
    writeAtomic(path, JSON.stringify({ ...values, formatVersion: VERSIONED_FILES.settings }, null, 2))
  }

  /**
   * Reads settings.json and, on the first launch with profiles (no default
   * profile file yet), moves its profile keys into the default profile's
   * file, which is where they are read from from then on. Values were already checked field by field, so an invalid one has
   * fallen back to its default in either scope. The API key stays in its
   * encrypted file.
   */
  #load(): Settings {
    const existed = existsSync(this.#settingsPath)
    let legacy = structuredClone(DEFAULT_SETTINGS)
    let newer = false
    try {
      const read = readVersioned(this.#settingsPath, VERSIONED_FILES.settings, migrateSettings)
      legacy = read.value ?? legacy
      newer = read.newer
    } catch {
      // Unreadable: the defaults.
    }
    const profilePath = this.#profilePath(DEFAULT_PROFILE_ID)
    if (existsSync(profilePath)) return legacy
    this.#profiles.set(DEFAULT_PROFILE_ID, legacy)
    this.#app = legacy
    if (existed) {
      try {
        this.#write(profilePath, pick(legacy, PROFILE_KEYS))
        // A newer Apex's file stays as it is (its copy is aside); ours is rewritten in this build's format.
        if (!newer) this.#writeApp()
      } catch {
        // A read-only data folder: the moved values still apply in memory.
      }
    }
    return legacy
  }
}

/** What main remembers per window, keyed by a stable window key ('main' for the first window). */
export type SavedWindowState = Pick<WindowState, 'sidebarOpen' | 'name'>

const DEFAULT_WINDOW_STATE: SavedWindowState = { sidebarOpen: true, name: null }
const savedWindowSchema = z.object({ sidebarOpen: z.boolean(), name: z.string().trim().min(1).max(80).nullable() })

/** Per-window state (sidebar open, custom name) in window-state.json. Invalid entries fall back to the defaults. */
export class WindowStateStore {
  readonly #path: string
  readonly #windows: Map<string, SavedWindowState>

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'window-state.json')
    this.#windows = new Map()
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      const windows = raw && typeof raw === 'object' ? (raw as { windows?: unknown }).windows : null
      if (windows && typeof windows === 'object') {
        for (const [key, value] of Object.entries(windows)) {
          const parsed = savedWindowSchema.safeParse(value)
          if (parsed.success) this.#windows.set(key, parsed.data)
        }
      }
    } catch {
      // No file yet, or unreadable: every window starts from the defaults.
    }
  }

  get(key: string): SavedWindowState {
    return { ...(this.#windows.get(key) ?? DEFAULT_WINDOW_STATE) }
  }

  update(key: string, patch: Partial<SavedWindowState>): SavedWindowState {
    const next = savedWindowSchema.parse({ ...this.get(key), ...patch })
    this.#windows.set(key, next)
    writeAtomic(this.#path, JSON.stringify({ windows: Object.fromEntries(this.#windows) }, null, 2))
    return { ...next }
  }
}

export function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, data, { mode: 0o600 })
  renameSync(temp, path)
}
