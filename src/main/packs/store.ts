/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Packs on disk (docs/packs.md › Layout on disk): installed packs, drafts,
// each pack's storage and log, and the index of what is installed and on.
// Installed files are kept in memory too (a pack without an app is at most
// 10 MB), so the apex-pack:// handler, the tool host and the contribution sync
// read them without touching the disk. An app's folder can hold a game's
// assets (docs/apps.md), so those files stay on disk and are read when served.
// A pack whose files no longer pass validatePack (changed on disk by hand,
// say) loads switched off, with its problems.
import { BRAND_NAME } from '@shared/branding'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  PACK_FORMAT,
  PACK_ID_PATTERN,
  PACK_LIMITS,
  PACK_MANIFEST_FILE,
  PACK_MANIFEST_NEW_VERSION,
  NO_PACK_PERMISSIONS,
  isPackAssetPath,
  isPackPath,
  manifestAppRoots,
  manifestAssetRoots,
  packAppAt,
  withinOptional,
  type PackIndexSource,
  type PackScheduledNotification,
  type PackOptionalPermissions,
  type PackLogLine,
  type PackManifest,
  type PackSignatureState,
  type PackSource,
  type PackUpdateInfo,
} from '@shared/packs'
import { writeAtomic } from '../settings'
import { readJson } from '../stores'
import { folderManifest, PackFileError, packHash, packHashOnDisk, readPackFolder, signatureSchema, writePackFolder, type PackSignature } from './files'
import { validatePack, type PackFiles, type PackSkillFile } from './manifest'
import { PackSecrets, type SecretCipher } from './secrets'
import { NO_POLICY, policyRefusal, type PackPolicy } from './policy'

export interface FirstPartyPack {
  files: PackFiles
  enabledByDefault: boolean
}

interface IndexEntry {
  id: string
  enabled: boolean
  source: PackSource
  installedAt: number
  updatedAt: number
  hash: string
  signature: PackSignatureState
  keyId: string | null
  update: PackUpdateInfo | null
  /** What the person granted later of the pack's optionalPermissions. */
  granted: PackOptionalPermissions | null
  /** What fills each of its apps' asset slots: `<pack>/<set>` by slot id; a slot not listed uses the app's own files. */
  assets: Record<string, string> | null
  /** The folder apex.files.folder may read and write, until the person takes it back. */
  folder: string | null
  /** Notifications it set for later (apex.notifications.schedule). */
  schedules: PackScheduledNotification[]
  /** Who each of its apps last cast (apex.cast.pick): companion ids by app id. */
  cast: Record<string, string[]> | null
  /** An index lists it as withdrawn (docs/apps.md › The community index): no updates, and a notice on its page. */
  withdrawn?: { index: string; reason: string | null } | null
}

interface IndexFile {
  version: 1
  packs: IndexEntry[]
  indexes: PackIndexSource[]
  lastUpdateCheck: number | null
  /** The default community indexes were added once; removing one keeps it removed. */
  seeded: boolean
}

const sourceSchema = z.object({ kind: z.enum(['file', 'link', 'index', 'draft', 'first-party', 'dev']), url: z.string().max(2048).optional() })
const entrySchema = z.object({
  id: z.string().regex(PACK_ID_PATTERN),
  enabled: z.boolean(),
  source: sourceSchema,
  installedAt: z.number(),
  updatedAt: z.number(),
  hash: z.string(),
  signature: z.enum(['signed', 'unsigned', 'first-party']),
  keyId: z.string().nullable(),
  update: z.any().nullable().default(null),
  granted: z
    .object({ sites: z.array(z.string().max(260)).max(100), network: z.array(z.string().max(260)).max(50), notifications: z.boolean(), model: z.boolean(), clipboard: z.boolean() })
    .partial()
    .nullable()
    .default(null),
  assets: z.record(z.string().max(64), z.string().max(80)).nullable().default(null),
  folder: z.string().max(4096).nullable().default(null),
  schedules: z.array(z.object({ id: z.string().max(64), at: z.number(), title: z.string().max(120), body: z.string().max(500) })).max(50).default([]),
  cast: z.record(z.string().max(64), z.array(z.string().max(64)).max(8)).nullable().default(null),
  withdrawn: z.object({ index: z.string().max(2048), reason: z.string().max(300).nullable() }).nullable().default(null),
})
const indexSchema = z.object({
  version: z.literal(1),
  packs: z.array(z.unknown()).default([]),
  indexes: z.array(z.object({ url: z.string(), name: z.string().nullable(), addedAt: z.number(), lastError: z.string().nullable() })).default([]),
  lastUpdateCheck: z.number().nullable().default(null),
  seeded: z.boolean().default(false),
})

/** A pack as the runtime sees it. */
export interface LoadedPack {
  entry: IndexEntry
  manifest: PackManifest
  /** The files kept in memory: everything but what `onDisk` lists. */
  files: PackFiles
  /** An app's files read from disk when served, with their sizes (installed packs only). */
  onDisk: Map<string, number>
  skills: PackSkillFile[]
  problems: string[]
  firstParty: boolean
}

export interface DraftInfo {
  id: string
  dir: string
  updatedAt: number
  files: PackFiles | null
  manifest: PackManifest | null
  problems: string[]
}

/** The file the keys people enter for their packs are kept in, encrypted (docs/apps.md › Keys). */
export const PACK_SECRETS_FILE = 'pack-keys.bin'
/** The tokens of the sign-ins packs' apps run (encrypted like the keys). */
export const PACK_SIGNINS_FILE = 'pack-signins.bin'

/** No keychain: nothing can be kept (unit tests pass a cipher of their own). */
const NO_CIPHER: SecretCipher = {
  available: () => false,
  encrypt: () => {
    throw new Error('No keychain.')
  },
  decrypt: () => {
    throw new Error('No keychain.')
  },
}

export class PackStore extends EventEmitter<{ changed: []; log: [string] }> {
  readonly root: string
  /** The keys people entered for packs' secrets; read only in main. */
  readonly secrets: PackSecrets
  /** The sign-ins packs' apps ran, by pack and sign-in id (PackSignIns reads them); read only in main. */
  readonly signInFile: PackSecrets
  /** The organisation's policy (docs/apps.md › Apps for organisations): NO_POLICY for nearly everyone, where every rule is a no-op. */
  #policy: PackPolicy = NO_POLICY
  /** Why the policy keeps a pack from running, by id and the pack's hash; only filled while a policy applies. */
  readonly #refusals = new Map<string, { hash: string; reason: string | null }>()
  readonly #installed: string
  readonly #dev: string
  readonly #data: string
  readonly #logs: string
  readonly #now: () => number
  readonly #firstParty: Map<string, FirstPartyPack>
  #index: IndexFile = { version: 1, packs: [], indexes: [], lastUpdateCheck: null, seeded: false }
  readonly #loaded = new Map<string, LoadedPack>()

  /** Installed packs whose app files were stubbed at start-up, still to be checked against their hash. */
  readonly #toVerify = new Set<string>()
  readonly #verifyDelayMs: number

  constructor(dataDir: string, options: { firstParty?: FirstPartyPack[]; now?: () => number; defaultIndexes?: ReadonlyArray<{ url: string; name: string }>; verifyDelayMs?: number; cipher?: SecretCipher } = {}) {
    super()
    this.root = join(dataDir, 'packs')
    this.secrets = new PackSecrets(join(this.root, PACK_SECRETS_FILE), options.cipher ?? NO_CIPHER)
    this.signInFile = new PackSecrets(join(this.root, PACK_SIGNINS_FILE), options.cipher ?? NO_CIPHER)
    this.#installed = join(this.root, 'installed')
    this.#verifyDelayMs = options.verifyDelayMs ?? 5_000
    this.#dev = join(this.root, 'dev')
    this.#data = join(this.root, 'data')
    this.#logs = join(this.root, 'logs')
    this.#now = options.now ?? Date.now
    this.#firstParty = new Map()
    for (const fp of options.firstParty ?? []) {
      const check = validatePack(fp.files)
      if (!check.ok) {
        console.warn('A first-party pack is invalid:', check.problems.join('; '))
        continue
      }
      this.#firstParty.set(check.pack.manifest.id, fp)
    }
    this.#readIndex()
    this.#loadAll()
    if (!this.#index.seeded && options.defaultIndexes) {
      for (const d of options.defaultIndexes) if (!this.#index.indexes.some((i) => i.url === d.url)) this.#index.indexes.push({ url: d.url, name: d.name, addedAt: this.#now(), lastError: null })
      this.#index.seeded = true
      this.#writeIndex()
    }
  }

  // ---- the index ----

  #readIndex(): void {
    const parsed = indexSchema.safeParse(readJson(join(this.root, 'index.json')))
    if (!parsed.success) return
    const packs: IndexEntry[] = []
    for (const raw of parsed.data.packs) {
      const entry = entrySchema.safeParse(raw)
      if (entry.success) packs.push(entry.data as IndexEntry)
    }
    this.#index = { version: 1, packs, indexes: parsed.data.indexes, lastUpdateCheck: parsed.data.lastUpdateCheck, seeded: parsed.data.seeded }
  }

  #writeIndex(): void {
    writeAtomic(join(this.root, 'index.json'), JSON.stringify(this.#index, null, 2))
  }

  #entry(id: string): IndexEntry | undefined {
    return this.#index.packs.find((e) => e.id === id)
  }

  #loadAll(): void {
    this.#loaded.clear()
    for (const [id, fp] of this.#firstParty) {
      let entry = this.#entry(id)
      if (!entry) {
        entry = { id, enabled: fp.enabledByDefault, source: { kind: 'first-party' }, installedAt: 0, updatedAt: 0, hash: packHash(fp.files), signature: 'first-party', keyId: null, update: null, granted: null, assets: null, folder: null, schedules: [], cast: null }
        this.#index.packs.push(entry)
      }
      this.#load(entry, fp.files, true)
    }
    for (const entry of this.#index.packs) {
      if (this.#firstParty.has(entry.id)) continue
      let files: PackFiles
      const dir = this.#dirOf(entry)
      // An installed app's own files aren't read at start-up: their sizes are enough to load it, and verifyNow checks their hash afterwards.
      const raw = entry.source.kind === 'dev' ? null : folderManifest(dir)
      const roots = [...manifestAppRoots(raw), ...manifestAssetRoots(raw)]
      const icons = new Set(roots.length > 0 ? appIcons(raw) : [])
      const sizes = new Map<string, number>()
      try {
        files = readPackFolder(dir, undefined, roots.length > 0 ? { stub: (p) => !icons.has(p) && roots.some((r) => p.startsWith(`${r}/`)), sizes } : {})
      } catch (err) {
        console.warn(`Pack ${entry.id} could not be read:`, err instanceof Error ? err.message : err)
        continue
      }
      this.#load(entry, files, false, sizes.size > 0 ? sizes : undefined)
    }
    // Entries whose folder is gone are dropped.
    this.#index.packs = this.#index.packs.filter((e) => this.#loaded.has(e.id))
    if (this.#toVerify.size > 0) setTimeout(() => void this.verifyNow(), this.#verifyDelayMs).unref?.()
  }

  /**
   * Checks the packs whose app files were only stubbed at start-up: a pack
   * whose files changed on disk since it was installed loads switched off, as
   * one without an app does at once.
   */
  async verifyNow(): Promise<void> {
    for (const id of [...this.#toVerify]) {
      this.#toVerify.delete(id)
      const pack = this.#loaded.get(id)
      if (!pack || pack.firstParty || pack.entry.source.kind === 'dev') continue
      const hash = await packHashOnDisk(this.#dirOf(pack.entry), pack.files, pack.onDisk.keys())
      if (hash === pack.entry.hash || this.#loaded.get(id) !== pack) continue
      pack.problems = ['The pack’s files changed on disk after it was installed.']
      this.emit('changed')
    }
  }

  #load(entry: IndexEntry, files: PackFiles, firstParty: boolean, stubbed?: Map<string, number>): void {
    const check = validatePack(files)
    if (check.ok) {
      // A linked folder changes on purpose: its hash follows it. Stubbed files are checked by verifyNow.
      if (stubbed) this.#toVerify.add(entry.id)
      const changed = !stubbed && !firstParty && entry.source.kind !== 'dev' && packHash(files) !== entry.hash
      const problems = changed ? ['The pack’s files changed on disk after it was installed.'] : []
      const kept = new Map(files)
      const onDisk = new Map<string, number>()
      // An app's and an asset set's files stay on disk; an app's icon stays in memory, since the sidebar draws it as a data URL.
      const apps = check.pack.manifest.contributes.apps ?? []
      const sets = check.pack.manifest.contributes.assets ?? []
      if (!firstParty && (apps.length > 0 || sets.length > 0)) {
        for (const [p, data] of files) {
          const app = packAppAt(apps, p)
          const inSet = sets.some((s) => p.startsWith(`${s.root}/`))
          if ((!app && !inSet) || (app && p === app.icon)) continue
          onDisk.set(p, stubbed?.get(p) ?? data.length)
          kept.delete(p)
        }
      }
      this.#loaded.set(entry.id, { entry, manifest: check.pack.manifest, files: kept, onDisk, skills: check.pack.skills, problems, firstParty })
      return
    }
    // Keep it listed (so it can be removed), switched off, with what's wrong.
    const manifest = check.manifest ?? fallbackManifest(entry.id)
    this.#loaded.set(entry.id, { entry: { ...entry, enabled: false }, manifest, files, onDisk: new Map(), skills: [], problems: check.problems, firstParty })
  }

  // ---- installed packs ----

  all(): LoadedPack[] {
    return [...this.#loaded.values()].sort((a, b) => (a.firstParty === b.firstParty ? a.manifest.name.localeCompare(b.manifest.name) : a.firstParty ? 1 : -1))
  }

  /** Packs that are on and loaded without problems: what the runtime applies. */
  active(): LoadedPack[] {
    return this.all().filter((p) => p.entry.enabled && p.problems.length === 0 && !this.policyRefusal(p.manifest.id))
  }

  get(id: string): LoadedPack | undefined {
    return this.#loaded.get(id)
  }

  require(id: string): LoadedPack {
    const pack = this.#loaded.get(id)
    if (!pack) throw new PackFileError('This pack isn’t installed.')
    return pack
  }

  isActive(id: string): boolean {
    const p = this.#loaded.get(id)
    return Boolean(p && p.entry.enabled && p.problems.length === 0 && !this.policyRefusal(id))
  }

  get policy(): PackPolicy {
    return this.#policy
  }

  setPolicy(policy: PackPolicy): void {
    this.#policy = policy
    this.#refusals.clear()
    this.emit('changed')
  }

  /** Whether the policy installs this pack (from one of its force-install addresses): it stays on and can't be removed. */
  isForced(id: string): boolean {
    if (!this.#policy.managed) return false
    const url = this.#entry(id)?.source.url
    return Boolean(url && this.#policy.forceInstall.some((f) => f.url === url))
  }

  /** Why the organisation keeps an installed pack from running, or null (always null without a policy, at no cost). */
  policyRefusal(id: string): string | null {
    if (!this.#policy.managed) return null
    const p = this.#loaded.get(id)
    if (!p || p.firstParty) return null
    const cached = this.#refusals.get(id)
    if (cached && cached.hash === p.entry.hash) return cached.reason
    const reason = policyRefusal(this.#policy, p.manifest, p.entry.keyId, p.entry.source, this.isForced(id), 'run')
    this.#refusals.set(id, { hash: p.entry.hash, reason })
    return reason
  }

  /** One of an installed pack's files held in memory, or null. */
  file(id: string, path: string): Buffer | null {
    if (!isPackPath(path)) return null
    return this.#loaded.get(id)?.files.get(path) ?? null
  }

  /** Where one of an installed pack's on-disk app files is, or null. */
  diskPath(id: string, path: string): string | null {
    if ((!isPackPath(path) && !isPackAssetPath(path)) || !this.#loaded.get(id)?.onDisk.has(path)) return null
    return join(this.#dirOf(this.#entry(id)), ...path.split('/'))
  }

  /** Every file of an installed pack, read again from disk when some aren't in memory (export, remix). */
  allFiles(id: string): PackFiles {
    const pack = this.require(id)
    if (pack.onDisk.size === 0) return pack.files
    return readPackFolder(this.#dirOf(pack.entry))
  }

  /** Every file's path and size, in memory or on disk. */
  fileSizes(id: string): Array<{ path: string; size: number }> {
    const pack = this.require(id)
    return [...[...pack.files].map(([path, data]) => ({ path, size: data.length })), ...[...pack.onDisk].map(([path, size]) => ({ path, size }))]
  }

  /** Installs or replaces a pack whose files passed validatePack. */
  install(files: PackFiles, info: { source: PackSource; signature: PackSignatureState; keyId: string | null; enable: boolean; signatureFile?: PackSignature | null }): LoadedPack {
    const check = validatePack(files)
    if (!check.ok) throw new PackFileError(check.problems.join('\n'))
    const id = check.pack.manifest.id
    if (this.#firstParty.has(id)) throw new PackFileError(`This id belongs to a pack that comes with ${BRAND_NAME}.`)
    const linked = info.source.kind === 'dev'
    if (linked && (!info.source.url || !isAbsolute(info.source.url))) throw new PackFileError('A linked folder needs its full path.')
    // A linked folder stays where it is; everything else is copied in.
    if (!linked) {
      mkdirSync(this.#installed, { recursive: true })
      writePackFolder(join(this.#installed, id), files)
    }
    const now = this.#now()
    const before = this.#entry(id)
    // What was granted later carries over while the new version still lists it as optional.
    const kept = before?.granted ? keepGranted(before.granted, check.pack.manifest.optionalPermissions) : null
    const entry: IndexEntry = { id, enabled: info.enable, source: info.source, installedAt: before?.installedAt ?? now, updatedAt: now, hash: packHash(files), signature: info.signature, keyId: info.keyId, update: null, granted: kept, assets: before?.assets ?? null, folder: before?.folder ?? null, schedules: before?.schedules ?? [], cast: before?.cast ?? null }
    this.#index.packs = [...this.#index.packs.filter((e) => e.id !== id), entry]
    if (info.signatureFile) writeAtomic(this.#signaturePath(id), JSON.stringify(info.signatureFile, null, 2))
    else rmSync(this.#signaturePath(id), { force: true })
    this.#writeIndex()
    this.#load(entry, files, false)
    this.emit('changed')
    return this.require(id)
  }

  #signaturePath(id: string): string {
    if (!PACK_ID_PATTERN.test(id)) throw new PackFileError('Not a pack.')
    return join(this.root, 'signatures', `${id}.json`)
  }

  /** The author's signature an installed pack came with, kept so an export passes it on unchanged. */
  signature(id: string): PackSignature | null {
    const parsed = signatureSchema.safeParse(readJson(this.#signaturePath(id)))
    return parsed.success ? parsed.data : null
  }

  setEnabled(id: string, enabled: boolean): LoadedPack {
    const pack = this.require(id)
    if (enabled && pack.problems.length > 0) throw new PackFileError('This pack has problems, so it can’t be turned on. Reinstall it or remove it.')
    const entry = this.#entry(id)
    if (entry) entry.enabled = enabled
    pack.entry.enabled = enabled
    this.#writeIndex()
    this.emit('changed')
    return pack
  }

  /** Where an entry's files are: its linked folder, or its copy under installed/. */
  #dirOf(entry: IndexEntry | undefined): string {
    if (!entry) throw new PackFileError('This pack isn’t installed.')
    return entry.source.kind === 'dev' && entry.source.url ? entry.source.url : join(this.#installed, entry.id)
  }

  /** Reads a linked folder again (developer mode); its problems, if any, switch it off until they're fixed. */
  reloadLinked(id: string): LoadedPack {
    const entry = this.#entry(id)
    if (!entry || entry.source.kind !== 'dev') throw new PackFileError('This pack isn’t loaded from a folder.')
    let files: PackFiles
    try {
      files = readPackFolder(this.#dirOf(entry))
    } catch (err) {
      throw new PackFileError(err instanceof Error ? err.message : String(err))
    }
    entry.hash = packHash(files)
    entry.updatedAt = this.#now()
    this.#writeIndex()
    this.#load(entry, files, false)
    this.emit('changed')
    return this.require(id)
  }

  readonly #draftChats = new Map<string, string>()

  /** Remembers the chat a companion builds a draft in, so Continue goes back to it. */
  noteDraftChat(id: string, chatId: string): void {
    if (!this.#draftChats.has(id)) this.#draftChats.set(id, chatId)
  }

  /** The chat a draft was built in (this session), or null. */
  draftChat(id: string): string | null {
    return this.#draftChats.get(id) ?? null
  }

  /** A pack's linked folder (developer mode), or null for any other pack. */
  devFolder(id: string): string | null {
    const entry = this.#entry(id)
    return entry?.source.kind === 'dev' && entry.source.url ? entry.source.url : null
  }

  /** The linked folders of packs that are on (developer mode). */
  linkedFolders(): Array<{ id: string; dir: string }> {
    return this.#index.packs.filter((e) => e.source.kind === 'dev' && e.source.url && e.enabled).map((e) => ({ id: e.id, dir: e.source.url as string }))
  }

  /** Who one of a pack's apps cast last. */
  setCast(id: string, appId: string, companions: string[]): void {
    const entry = this.#entry(id)
    const pack = this.#loaded.get(id)
    if (!entry || !pack) return
    entry.cast = { ...(entry.cast ?? {}), [appId]: companions }
    pack.entry.cast = entry.cast
    this.#writeIndex()
  }

  /** The notifications a pack set for later. */
  setSchedules(id: string, schedules: PackScheduledNotification[]): void {
    const entry = this.#entry(id)
    const pack = this.#loaded.get(id)
    if (!entry || !pack) return
    entry.schedules = schedules
    pack.entry.schedules = schedules
    this.#writeIndex()
  }

  /** Where a pack keeps the person's own files (apex.files.own): never part of the pack, removed with it. */
  ownDir(id: string): string {
    if (!PACK_ID_PATTERN.test(id)) throw new PackFileError('Not a pack.')
    return join(this.root, 'own', id)
  }

  /** The folder a pack may read and write, or null to take it back. */
  setFolder(id: string, folder: string | null): void {
    const entry = this.#entry(id)
    const pack = this.#loaded.get(id)
    if (!entry || !pack) return
    entry.folder = folder
    pack.entry.folder = folder
    this.#writeIndex()
    this.emit('changed')
  }

  /** Picks what fills one of a pack's asset slots: `<pack>/<set>`, or null for the app's own files. */
  setAssetChoice(id: string, slot: string, choice: string | null): void {
    const entry = this.#entry(id)
    const pack = this.#loaded.get(id)
    if (!entry || !pack) return
    const next = { ...(entry.assets ?? {}) }
    if (choice) next[slot] = choice
    else delete next[slot]
    entry.assets = Object.keys(next).length > 0 ? next : null
    pack.entry.assets = entry.assets
    this.#writeIndex()
    this.emit('changed')
  }

  /** What the person granted later of a pack's optionalPermissions (null takes it all back). */
  setGranted(id: string, granted: PackOptionalPermissions | null): void {
    const entry = this.#entry(id)
    const pack = this.#loaded.get(id)
    if (!entry || !pack) return
    entry.granted = granted
    pack.entry.granted = granted
    this.#writeIndex()
    this.emit('changed')
  }

  /** Records (or clears) that an index withdrew a pack. */
  setWithdrawn(id: string, withdrawn: { index: string; reason: string | null } | null): void {
    const entry = this.#entry(id)
    const pack = this.#loaded.get(id)
    if (!entry || !pack) return
    if (JSON.stringify(entry.withdrawn ?? null) === JSON.stringify(withdrawn)) return
    entry.withdrawn = withdrawn
    pack.entry.withdrawn = withdrawn
    this.#writeIndex()
    this.emit('changed')
  }

  setUpdate(id: string, update: PackUpdateInfo | null): void {
    const entry = this.#entry(id)
    const pack = this.#loaded.get(id)
    if (!entry || !pack) return
    entry.update = update
    pack.entry.update = update
    this.#writeIndex()
    this.emit('changed')
  }

  lastUpdateCheck(): number | null {
    return this.#index.lastUpdateCheck
  }

  noteUpdateCheck(at = this.#now()): void {
    this.#index.lastUpdateCheck = at
    this.#writeIndex()
  }

  remove(id: string): void {
    if (this.#firstParty.has(id)) throw new PackFileError(`Packs that come with ${BRAND_NAME} can be turned off, not removed.`)
    const pack = this.require(id)
    // A linked folder is the developer's own: unlinking never deletes it.
    if (pack.entry.source.kind !== 'dev') rmSync(join(this.#installed, id), { recursive: true, force: true })
    rmSync(this.#dataPath(id), { force: true })
    rmSync(this.ownDir(id), { recursive: true, force: true })
    rmSync(this.#logPath(id), { force: true })
    rmSync(this.#signaturePath(id), { force: true })
    this.secrets.forget(id)
    this.signInFile.forget(id)
    this.#index.packs = this.#index.packs.filter((e) => e.id !== id)
    this.#loaded.delete(id)
    this.#writeIndex()
    this.emit('changed')
  }

  // ---- community indexes ----

  /** The indexes Browse reads: the organisation's, when its policy names them, else the ones the person added. */
  indexes(): PackIndexSource[] {
    const saved = this.#index.indexes.map((i) => ({ ...i }))
    if (!this.#policy.indexes) return saved
    return this.#policy.indexes.map((url) => saved.find((i) => i.url === url) ?? { url, name: null, addedAt: 0, lastError: null })
  }

  saveIndex(source: PackIndexSource): void {
    this.#index.indexes = [...this.#index.indexes.filter((i) => i.url !== source.url), source]
    this.#writeIndex()
    this.emit('changed')
  }

  removeIndex(url: string): void {
    this.#index.indexes = this.#index.indexes.filter((i) => i.url !== url)
    this.#writeIndex()
    this.emit('changed')
  }

  // ---- drafts ----

  draftDir(id: string): string {
    if (!PACK_ID_PATTERN.test(id)) throw new PackFileError('Pack ids use 2 to 32 lowercase letters, digits and dashes.')
    return join(this.#dev, id)
  }

  hasDraft(id: string): boolean {
    return PACK_ID_PATTERN.test(id) && existsSync(join(this.#dev, id, PACK_MANIFEST_FILE))
  }

  draftIds(): string[] {
    if (!existsSync(this.#dev)) return []
    return readdirSync(this.#dev).filter((id) => this.hasDraft(id))
  }

  draft(id: string): DraftInfo {
    const dir = this.draftDir(id)
    let files: PackFiles | null = null
    let problems: string[] = []
    let manifest: PackManifest | null = null
    try {
      files = readPackFolder(dir)
      const check = validatePack(files)
      manifest = check.ok ? check.pack.manifest : check.manifest
      problems = check.ok ? [] : check.problems
      if (manifest && manifest.id !== id) problems = [...problems, `apex-pack.json: id is "${manifest.id}" but the draft's folder is "${id}". Use "${id}".`]
    } catch (err) {
      problems = [err instanceof Error ? err.message : String(err)]
    }
    let updatedAt = 0
    try {
      updatedAt = statSync(join(dir, PACK_MANIFEST_FILE)).mtimeMs
      for (const p of files?.keys() ?? []) updatedAt = Math.max(updatedAt, statSync(join(dir, ...p.split('/'))).mtimeMs)
    } catch {
      // A file went away mid-read.
    }
    return { id, dir, updatedAt: Math.round(updatedAt), files, manifest, problems }
  }

  drafts(): DraftInfo[] {
    return this.draftIds()
      .map((id) => this.draft(id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Writes a whole draft (Share as pack, Remix), replacing one with the same id. */
  writeDraft(id: string, files: PackFiles): void {
    if (!this.hasDraft(id) && this.draftIds().length >= PACK_LIMITS.drafts) throw new PackFileError(`You can keep up to ${PACK_LIMITS.drafts} drafts. Delete one first.`)
    mkdirSync(this.#dev, { recursive: true })
    writePackFolder(this.draftDir(id), files)
    this.emit('changed')
  }

  /** Creates a draft with a minimal manifest; fails if the id is taken by a draft. */
  createDraft(input: { id: string; name: string; description: string; builtBy?: string }): void {
    if (this.hasDraft(input.id)) throw new PackFileError(`A draft called ${input.id} already exists. Use it, or pick another id.`)
    const manifest: PackManifest = {
      format: PACK_FORMAT,
      manifestVersion: PACK_MANIFEST_NEW_VERSION,
      id: input.id,
      name: input.name,
      version: '1.0.0',
      description: input.description,
      ...(input.builtBy ? { builtBy: input.builtBy } : {}),
      contributes: {},
      permissions: { ...NO_PACK_PERMISSIONS },
    }
    this.writeDraft(input.id, new Map([[PACK_MANIFEST_FILE, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]]))
  }

  readDraftFile(id: string, path: string): string {
    if (!isPackPath(path)) throw new PackFileError(`${path} is not a file path inside the pack.`)
    const full = join(this.draftDir(id), ...path.split('/'))
    if (!this.hasDraft(id)) throw new PackFileError(`There is no draft called ${id}.`)
    if (!existsSync(full)) throw new PackFileError(`${path} is not in the draft.`)
    return readFileSync(full, 'utf8')
  }

  writeDraftFile(id: string, path: string, content: string): void {
    if (!isPackPath(path)) throw new PackFileError(`${path} is not a file path inside the pack (letters, digits, dot, dash and underscore; not under __apex/).`)
    if (!this.hasDraft(id)) throw new PackFileError(`There is no draft called ${id}. Call create_pack first.`)
    const size = Buffer.byteLength(content)
    if (size > PACK_LIMITS.fileBytes) throw new PackFileError(`A file is at most ${PACK_LIMITS.fileBytes / 1024 / 1024} MB.`)
    const full = join(this.draftDir(id), ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
    this.emit('changed')
  }

  deleteDraftFile(id: string, path: string): void {
    if (!isPackPath(path) || path === PACK_MANIFEST_FILE) throw new PackFileError(`${path} can't be deleted.`)
    rmSync(join(this.draftDir(id), ...path.split('/')), { force: true })
    this.emit('changed')
  }

  removeDraft(id: string): void {
    rmSync(this.draftDir(id), { recursive: true, force: true })
    this.emit('changed')
  }

  // ---- apex.storage ----

  #dataPath(id: string): string {
    if (!PACK_ID_PATTERN.test(id)) throw new PackFileError('Not a pack.')
    return join(this.#data, `${id}.json`)
  }

  storage(id: string): Record<string, unknown> {
    const raw = readJson(this.#dataPath(id))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  }

  writeStorage(id: string, data: Record<string, unknown>): void {
    const text = JSON.stringify(data)
    if (Buffer.byteLength(text) > PACK_LIMITS.storageBytes) throw new PackFileError('This pack’s storage is full (1 MB).')
    writeAtomic(this.#dataPath(id), text)
  }

  // ---- logs ----

  #logPath(id: string): string {
    if (!PACK_ID_PATTERN.test(id)) throw new PackFileError('Not a pack.')
    return join(this.#logs, `${id}.log`)
  }

  log(id: string, line: Omit<PackLogLine, 'at'> & { at?: number }): void {
    if (!PACK_ID_PATTERN.test(id)) return
    const full: PackLogLine = { at: line.at ?? this.#now(), level: line.level, source: line.source.slice(0, 80), message: line.message.slice(0, 2_000) }
    try {
      mkdirSync(this.#logs, { recursive: true })
      const path = this.#logPath(id)
      appendFileSync(path, `${JSON.stringify(full)}\n`, { mode: 0o600 })
      // Trim now and then, not on every line; an audit log (far longer) only once it has grown well past what it keeps.
      const audit = this.#policy.audit
      if (statSync(path).size > (audit ? 4_000_000 : 400_000) || (!audit && Math.random() < 0.05)) {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
        const keep = audit ? PACK_LIMITS.auditLogLines : PACK_LIMITS.logLines
        if (lines.length > keep) writeFileSync(path, `${lines.slice(-keep).join('\n')}\n`, { mode: 0o600 })
      }
    } catch {
      // A log line that can't be written is dropped.
    }
    this.emit('log', id)
  }

  logLines(id: string): PackLogLine[] {
    try {
      return readFileSync(this.#logPath(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-(this.#policy.audit ? PACK_LIMITS.auditLogLines : PACK_LIMITS.logLines))
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as PackLogLine]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  clearLog(id: string): void {
    rmSync(this.#logPath(id), { force: true })
    this.emit('log', id)
  }
}

function fallbackManifest(id: string): PackManifest {
  return { format: PACK_FORMAT, manifestVersion: PACK_MANIFEST_NEW_VERSION, id, name: id, version: '0.0.0', description: '', contributes: {}, permissions: { ...NO_PACK_PERMISSIONS } }
}

/** The part of what was granted that a new version still lists as optional; null when nothing is left. */
function keepGranted(granted: PackOptionalPermissions, optional: PackOptionalPermissions | undefined): PackOptionalPermissions | null {
  const out: PackOptionalPermissions = {}
  const sites = (granted.sites ?? []).filter((h) => withinOptional(optional, { sites: [h] }))
  const network = (granted.network ?? []).filter((h) => withinOptional(optional, { network: [h] }))
  if (sites.length) out.sites = sites
  if (network.length) out.network = network
  for (const k of ['notifications', 'model', 'clipboard'] as const) if (granted[k] && withinOptional(optional, { [k]: true })) out[k] = true
  return Object.keys(out).length > 0 ? out : null
}

/** The icons an unchecked manifest's apps name; they stay in memory, since the sidebar draws them. */
function appIcons(raw: unknown): string[] {
  const apps = (raw as { contributes?: { apps?: unknown } } | null)?.contributes?.apps
  if (!Array.isArray(apps)) return []
  return apps.flatMap((a) => (a && typeof a === 'object' && typeof (a as { icon?: unknown }).icon === 'string' ? [(a as { icon: string }).icon] : []))
}
