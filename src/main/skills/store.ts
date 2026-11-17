/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Skills as folders (SK-03): userData/skills/<owner>/<name>/SKILL.md plus
// up to 50 supporting files. Ids, dates and last use live in
// skills/.index.json, so a skill keeps its id through renames and older ids
// survive the move from skills.json (kept as skills.json.bak). Built-in
// skills come from the app bundle and are read-only. The folder is the
// truth: a skill folder dropped in by hand appears on the next rescan.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { SHARED_OWNER } from '@shared/chats'
import type { Owner } from '@shared/services'
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_FILES_MAX,
  SKILL_MAIN_FILE,
  SKILL_NAME_PATTERN,
  isTextSkillFile,
  type Skill,
  type SkillFile,
  type SkillSaveInput,
  type SkillStep,
} from '@shared/skills'
import type { FileRef, FileVersion } from '@shared/workspace'
import { writeAtomic } from '../settings'
import { BUILTIN_SOURCES, type BuiltinSource } from './builtin'
import { parseSkillDocument, serializeSkillDocument, skillBlock, type SkillDocument } from './format'

export const SKILL_NAME = SKILL_NAME_PATTERN

const INDEX_FILE = '.index.json'

interface IndexEntry {
  owner: Owner
  name: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

interface IndexFile {
  version: 1
  items: Record<string, IndexEntry>
  /** Last use of built-in skills, by id. */
  used: Record<string, number>
}

/** The parts of a skill that live in SKILL.md, plus its folder. */
interface Loaded {
  id: string
  dir: string
  doc: SkillDocument
}

export type SnapshotFn = (ref: FileRef, text: string | Buffer, label: FileVersion['label']) => void

export interface SkillStoreOptions {
  builtins?: readonly BuiltinSource[]
  now?: () => number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
  return line.length > 500 ? `${line.slice(0, 499)}…` : line
}

/** Owner folders are companion ids or 'shared'; nothing else is a folder name. */
const OWNER_DIR = /^[A-Za-z0-9-]{1,64}$/

function builtinVersionOf(doc: SkillDocument, fallback: string | undefined): string {
  if (fallback) return fallback
  const line = doc.extra.find((l) => /^version\s*:/i.test(l))
  return line ? line.replace(/^version\s*:\s*/i, '').replace(/^["']|["']$/g, '').trim() || '1' : '1'
}

/**
 * Expands a leading /skill-name in a message into the skill's instructions
 * and numbered steps. Returns the text unchanged when it does not start
 * with a known skill.
 */
export function expandSkill<T extends { name: string; instructions: string; steps?: readonly SkillStep[] }>(text: string, lookup: (name: string) => T | undefined): { skill: T | null; text: string } {
  const match = /^\/([a-z0-9][a-z0-9-]{0,39})(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match?.[1]) return { skill: null, text }
  const skill = lookup(match[1])
  if (!skill) return { skill: null, text }
  const rest = match[2]?.trim()
  const body = skillBlock(skill)
  return { skill, text: rest ? `${body}\n\n${rest}` : `${body}\n\nApply this skill now.` }
}

export class SkillStore extends EventEmitter<{ changed: [Skill[]] }> {
  readonly #root: string
  readonly #dataDir: string
  readonly #now: () => number
  readonly #builtins: Skill[]
  /** Skills from installed packs (docs/packs.md), read-only like the built-ins. */
  #packSkills: Skill[] = []
  #packFile: (id: string, path: string) => Buffer | null = () => null
  /** The built-in skills pack is off. */
  #builtinsHidden = false
  #index: IndexFile = { version: 1, items: {}, used: {} }
  #loaded: Loaded[] = []
  #snapshot: SnapshotFn = () => undefined

  constructor(dataDir: string, options: SkillStoreOptions = {}) {
    super()
    this.#dataDir = dataDir
    this.#root = join(dataDir, 'skills')
    this.#now = options.now ?? Date.now
    this.#builtins = (options.builtins ?? BUILTIN_SOURCES).flatMap((b) => {
      try {
        const doc = parseSkillDocument(b.text)
        return [{ id: b.id, name: doc.name, description: doc.description, instructions: doc.instructions, steps: doc.steps, owner: SHARED_OWNER, source: 'builtin' as const, builtinVersion: builtinVersionOf(doc, b.version), createdAt: 0, updatedAt: 0, lastUsedAt: null, files: [] }]
      } catch (err) {
        console.warn(`Built-in skill ${b.id} is unreadable:`, err instanceof Error ? err.message : err)
        return []
      }
    })
    this.#readIndex()
    this.migrateLegacy()
    this.#scan()
  }

  /** The versions hook (the workspace's versions.snapshot), set by the feature; a no-op until then. */
  bind(hooks: { snapshot?: SnapshotFn }): void {
    if (hooks.snapshot) this.#snapshot = hooks.snapshot
  }

  /**
   * Moves the old skills.json rows into folders, keeping their ids and dates.
   * Idempotent: rows already in the index are skipped, and the old file
   * becomes skills.json.bak.
   */
  migrateLegacy(): number {
    const legacy = join(this.#dataDir, 'skills.json')
    if (!existsSync(legacy)) return 0
    let rows: unknown
    try {
      rows = JSON.parse(readFileSync(legacy, 'utf8'))
    } catch {
      rows = []
    }
    let moved = 0
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isObject(row) || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.instructions !== 'string') continue
      if (this.#index.items[row.id]) continue
      const owner = typeof row.owner === 'string' && OWNER_DIR.test(row.owner) ? row.owner : SHARED_OWNER
      const name = this.#freeName(owner, SKILL_NAME_PATTERN.test(row.name) ? row.name : 'skill')
      const description = typeof row.description === 'string' && row.description.trim() ? row.description.trim().slice(0, 500) : (row.instructions.trim().split('\n')[0] ?? name).slice(0, 500) || name
      const dir = join(this.#root, owner, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, SKILL_MAIN_FILE), serializeSkillDocument({ name, description, instructions: row.instructions, steps: [] }), 'utf8')
      const updatedAt = num(row.updatedAt) ?? this.#now()
      this.#index.items[row.id] = { owner, name, createdAt: updatedAt, updatedAt, lastUsedAt: num(row.lastUsedAt) }
      moved++
    }
    this.#writeIndex()
    const backup = join(this.#dataDir, 'skills.json.bak')
    rmSync(backup, { force: true })
    renameSync(legacy, backup)
    return moved
  }

  /** Re-reads the folders (after a reveal-and-edit in Finder, say). */
  rescan(): Skill[] {
    this.#scan()
    return this.list()
  }

  /** Your skills (shared and companions'), as the original skills.list returned them. */
  list(): Skill[] {
    return this.#loaded.map((l) => this.#skill(l))
  }

  /** Your skills, then the built-ins: what the Skills page and the composer show. */
  all(): Skill[] {
    return [...this.list(), ...this.#readOnly().map((b) => ({ ...b, lastUsedAt: this.#index.used[b.id] ?? null }))]
  }

  get(id: string): Skill | undefined {
    const loaded = this.#loaded.find((l) => l.id === id)
    if (loaded) return this.#skill(loaded)
    const builtin = this.#readOnly().find((b) => b.id === id)
    return builtin ? { ...builtin, lastUsedAt: this.#index.used[builtin.id] ?? null } : undefined
  }

  /** Throws when the skill is gone. */
  require(id: string): Skill {
    const skill = this.get(id)
    if (!skill) throw new Error('This skill no longer exists.')
    return skill
  }

  byName(name: string): Skill | undefined {
    return this.all().find((s) => s.name === name)
  }

  /** What /name means in a chat with this companion: its own skill, then a shared one, then a pack's, then a built-in. */
  resolve(name: string, companionId: string): Skill | undefined {
    const matches = this.all().filter((s) => s.name === name)
    return (
      matches.find((s) => s.source === 'user' && s.owner === companionId) ??
      matches.find((s) => s.source === 'user' && s.owner === SHARED_OWNER) ??
      matches.find((s) => s.source === 'pack') ??
      matches.find((s) => s.source === 'builtin')
    )
  }

  /** The read-only skills: the built-ins (unless their pack is off) and every enabled pack's. */
  #readOnly(): Skill[] {
    return [...(this.#builtinsHidden ? [] : this.#builtins), ...this.#packSkills]
  }

  #isReadOnly(id: string): boolean {
    return this.#builtins.some((b) => b.id === id) || this.#packSkills.some((b) => b.id === id)
  }

  /** Replaces the skills enabled packs provide (the packs runtime calls this when packs change). */
  setPackSkills(skills: Skill[], readFile: (id: string, path: string) => Buffer | null = () => null): void {
    this.#packSkills = skills.map((s) => ({ ...s, source: 'pack' as const }))
    this.#packFile = readFile
    this.#changed()
  }

  /** The /names of the skills that come with Atelier. */
  builtinNames(): string[] {
    return this.#builtins.map((b) => b.name)
  }

  /** How many skills come with Atelier, shown or not (the built-in skills pack's count). */
  builtinCount(): number {
    return this.#builtins.length
  }

  /** Hides or shows the built-in skills (the atelier-builtin-skills pack's switch). */
  setBuiltinsHidden(hidden: boolean): void {
    if (this.#builtinsHidden === hidden) return
    this.#builtinsHidden = hidden
    this.#changed()
  }

  markUsed(id: string, at = this.#now()): void {
    const entry = this.#index.items[id]
    if (entry) entry.lastUsedAt = at
    else if (this.#isReadOnly(id)) this.#index.used[id] = at
    else return
    this.#writeIndex()
    this.#changed()
  }

  ownedBy(owner: Owner): Skill[] {
    return this.list().filter((s) => s.source === 'user' && s.owner === owner)
  }

  /** A deleted companion's own skills go with it. */
  removeOwned(owner: Owner): void {
    const own = this.#loaded.filter((l) => this.#index.items[l.id]?.owner === owner)
    if (own.length === 0) return
    for (const l of own) this.#drop(l)
    this.#writeIndex()
    this.#changed()
  }

  /** Creates or updates a user skill. Names are unique per owner; built-ins are read-only. */
  save(input: SkillSaveInput): Skill {
    if (input.id && this.#isReadOnly(input.id)) throw new Error(readOnlyMessage(this.get(input.id)))
    const existing = input.id ? this.#loaded.find((l) => l.id === input.id) : undefined
    if (input.id && !existing) throw new Error('This skill no longer exists.')
    const entry = existing ? this.#index.items[existing.id] : undefined
    const owner = input.owner ?? entry?.owner ?? SHARED_OWNER
    if (!OWNER_DIR.test(owner)) throw new Error('That companion no longer exists.')
    const name = input.name.trim().replace(/^\//, '').toLowerCase()
    if (!SKILL_NAME_PATTERN.test(name)) throw new Error('Skill names use lowercase letters, digits and dashes (for example “weekly-report”).')
    if (this.#loaded.some((l) => l.id !== existing?.id && l.doc.name === name && this.#index.items[l.id]?.owner === owner)) throw new Error(`A skill named /${name} already exists.`)
    if (input.description.trim().length > 500) throw new Error('Keep the description to 500 characters.')
    // Simpler callers (the card's share toggle, companion files) send no steps: an edit keeps the ones it has.
    const steps = (input.steps ?? existing?.doc.steps ?? []).map((s, i) => ({ id: s.id || `step-${i + 1}`, title: s.title.trim(), instructions: s.instructions.trim() })).filter((s) => s.title || s.instructions)
    if (!input.instructions.trim() && steps.length === 0) throw new Error('A skill needs instructions.')
    // SKILL.md needs a description; simpler callers (companion files, the card) may send none, so the first line stands in.
    const description = input.description.trim() || firstLine(input.instructions || steps[0]?.instructions || name)
    const doc: SkillDocument = { name, description, instructions: input.instructions.trim(), steps, extra: existing?.doc.extra ?? [] }
    const now = this.#now()
    const id = existing?.id ?? randomUUID()
    let dir = join(this.#root, owner, name)
    if (existing && resolve(existing.dir) !== resolve(dir)) {
      // A rename or a new owner moves the folder, files and all.
      if (existsSync(dir)) throw new Error(`A folder for /${name} is already there.`)
      mkdirSync(join(this.#root, owner), { recursive: true })
      renameSync(existing.dir, dir)
    } else if (existing) {
      dir = existing.dir
    }
    mkdirSync(dir, { recursive: true })
    const main = join(dir, SKILL_MAIN_FILE)
    if (existing && existsSync(main)) this.#snapshotSafe({ kind: 'skill', skillId: id, path: SKILL_MAIN_FILE }, readFileSync(main), 'saved')
    writeAtomic(main, serializeSkillDocument(doc))
    this.#index.items[id] = { owner, name, createdAt: entry?.createdAt ?? now, updatedAt: now, lastUsedAt: entry?.lastUsedAt ?? null }
    this.#writeIndex()
    this.#scan()
    this.#changed()
    return this.require(id)
  }

  /** A copy you can edit: a built-in keeps its /name (yours then wins), a user skill gets "-copy". */
  duplicate(id: string, owner?: Owner): Skill {
    const source = this.require(id)
    const target = owner ?? source.owner
    const base = source.source !== 'user' && !this.#loaded.some((l) => l.doc.name === source.name && this.#index.items[l.id]?.owner === target) ? source.name : `${source.name.slice(0, 35)}-copy`
    const name = this.#freeName(target, base)
    const copy = this.save({ name, description: source.description, instructions: source.instructions, steps: source.steps.map((s) => ({ ...s })), owner: target })
    // Supporting files come along.
    const from = this.folderOf(id)
    const to = this.folderOf(copy.id)
    if (from && to) {
      for (const f of this.files(id)) {
        mkdirSync(join(to, f.path, '..'), { recursive: true })
        writeFileSync(join(to, f.path), readFileSync(join(from, f.path)))
      }
      this.#scan()
      this.#changed()
    }
    return this.require(copy.id)
  }

  /** Forgets the skill and deletes its folder. The service routes deletes through Recently Deleted first. */
  remove(id: string): void {
    if (this.#isReadOnly(id)) throw new Error(this.get(id)?.source === 'pack' ? 'Skills from a pack go when you remove or turn off the pack.' : 'Built-in skills can’t be deleted.')
    const loaded = this.#loaded.find((l) => l.id === id)
    if (!loaded) return
    this.#drop(loaded)
    this.#writeIndex()
    this.#changed()
  }

  /** The folder of a user skill; null for built-ins. */
  folderOf(id: string): string | null {
    return this.#loaded.find((l) => l.id === id)?.dir ?? null
  }

  /** The SKILL.md text, for export. */
  markdown(id: string): string {
    const skill = this.require(id)
    const loaded = this.#loaded.find((l) => l.id === id)
    return serializeSkillDocument({ name: skill.name, description: skill.description, instructions: skill.instructions, steps: skill.steps, extra: loaded?.doc.extra.filter((l) => !/^version\s*:/i.test(l)) ?? [] })
  }

  /** What a chat sees for /name. */
  block(id: string): string {
    return skillBlock(this.require(id))
  }

  // ---- supporting files ----

  files(id: string): SkillFile[] {
    const fromPack = this.#packSkills.find((s) => s.id === id)
    if (fromPack) return fromPack.files
    const dir = this.folderOf(id)
    if (!dir) return []
    const out: SkillFile[] = []
    const walk = (folder: string, depth: number): void => {
      if (depth > 4 || out.length >= SKILL_FILES_MAX * 2) return
      let entries: string[]
      try {
        entries = readdirSync(folder).sort()
      } catch {
        return
      }
      for (const name of entries) {
        if (name.startsWith('.')) continue
        const full = join(folder, name)
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        if (st.isDirectory()) walk(full, depth + 1)
        else if (st.isFile()) {
          const path = relative(dir, full).split(sep).join('/')
          if (path === SKILL_MAIN_FILE) continue
          out.push({ path, size: st.size, modifiedAt: st.mtimeMs, editable: isTextSkillFile(path) && st.size <= SKILL_FILE_MAX_BYTES })
        }
      }
    }
    walk(dir, 0)
    return out
  }

  readFile(id: string, path: string): string {
    if (this.#packSkills.some((s) => s.id === id)) {
      if (!isTextSkillFile(path)) throw new Error('This file type can’t be shown as text.')
      const data = this.#packFile(id, path)
      if (!data) throw new Error('That file isn’t in this skill.')
      return data.toString('utf8')
    }
    const full = this.#confine(id, path)
    if (!isTextSkillFile(path)) throw new Error('This file type can’t be shown as text.')
    const st = statSync(full)
    if (st.size > SKILL_FILE_MAX_BYTES) throw new Error('This file is larger than 5 MB.')
    return readFileSync(full, 'utf8')
  }

  writeFile(id: string, path: string, text: string): SkillFile {
    this.#writable(id)
    if (!isTextSkillFile(path)) throw new Error('Only text files can be edited here.')
    if (Buffer.byteLength(text) > SKILL_FILE_MAX_BYTES) throw new Error('Files in a skill can be up to 5 MB.')
    const full = this.#confine(id, path, true)
    if (existsSync(full)) this.#snapshotSafe({ kind: 'skill', skillId: id, path }, readFileSync(full), 'saved')
    else if (this.files(id).length >= SKILL_FILES_MAX) throw new Error(`A skill can hold up to ${SKILL_FILES_MAX} files.`)
    mkdirSync(join(full, '..'), { recursive: true })
    writeAtomic(full, text)
    return this.#touch(id, path)
  }

  /** Adds a dropped file; a name already taken gets a number. */
  addFile(id: string, name: string, base64: string): SkillFile {
    this.#writable(id)
    const data = Buffer.from(base64, 'base64')
    if (data.byteLength > SKILL_FILE_MAX_BYTES) throw new Error('Files in a skill can be up to 5 MB.')
    if (this.files(id).length >= SKILL_FILES_MAX) throw new Error(`A skill can hold up to ${SKILL_FILES_MAX} files.`)
    const clean = basename(name).replace(/[\\/:*?"<>|\0]/g, '-').replace(/^\.+/, '').trim().slice(0, 120)
    if (!clean) throw new Error('That file has no usable name.')
    if (clean === SKILL_MAIN_FILE) throw new Error('A skill already has its SKILL.md. Edit it in the fields above.')
    const dir = this.folderOf(id)!
    const dot = clean.lastIndexOf('.')
    const stem = dot > 0 ? clean.slice(0, dot) : clean
    const ext = dot > 0 ? clean.slice(dot) : ''
    let path = clean
    for (let n = 2; existsSync(join(dir, path)); n++) path = `${stem} ${n}${ext}`
    writeFileSync(join(dir, path), data)
    return this.#touch(id, path)
  }

  removeFile(id: string, path: string): void {
    this.#writable(id)
    if (path === SKILL_MAIN_FILE) throw new Error('SKILL.md can’t be removed; delete the skill instead.')
    const full = this.#confine(id, path)
    if (isTextSkillFile(path)) this.#snapshotSafe({ kind: 'skill', skillId: id, path }, readFileSync(full), 'deleted')
    rmSync(full, { force: true })
    this.#touch(id, null)
  }

  /** Puts a deleted skill's folder back (Recently Deleted's restore); a taken name gets a number. */
  restoreFolder(payload: { id: string; owner: Owner; name: string; createdAt: number; lastUsedAt: number | null }, folder: string): Skill {
    const owner = OWNER_DIR.test(payload.owner) ? payload.owner : SHARED_OWNER
    const name = this.#freeName(owner, payload.name)
    const dir = join(this.#root, owner, name)
    mkdirSync(join(this.#root, owner), { recursive: true })
    renameSync(folder, dir)
    if (name !== payload.name) {
      // The folder name is the /name; keep SKILL.md in step.
      try {
        const doc = parseSkillDocument(readFileSync(join(dir, SKILL_MAIN_FILE), 'utf8'))
        writeAtomic(join(dir, SKILL_MAIN_FILE), serializeSkillDocument({ ...doc, name }))
      } catch {
        // An unreadable SKILL.md is restored as it was.
      }
    }
    const id = this.#index.items[payload.id] ? randomUUID() : payload.id
    this.#index.items[id] = { owner, name, createdAt: payload.createdAt, updatedAt: this.#now(), lastUsedAt: payload.lastUsedAt }
    this.#writeIndex()
    this.#scan()
    this.#changed()
    return this.require(id)
  }

  /** The index entry, for the trash payload. */
  entry(id: string): (IndexEntry & { id: string }) | null {
    const e = this.#index.items[id]
    return e ? { ...e, id } : null
  }

  /** Forgets a skill whose folder already moved away (into Recently Deleted). */
  forget(id: string): void {
    const loaded = this.#loaded.find((l) => l.id === id)
    if (loaded && existsSync(loaded.dir)) rmSync(loaded.dir, { recursive: true, force: true })
    delete this.#index.items[id]
    this.#writeIndex()
    this.#scan()
    this.#changed()
  }

  // ---- internals ----

  #skill(l: Loaded): Skill {
    const entry = this.#index.items[l.id]!
    return {
      id: l.id,
      name: l.doc.name,
      description: l.doc.description,
      instructions: l.doc.instructions,
      steps: l.doc.steps,
      owner: entry.owner,
      source: 'user',
      builtinVersion: null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastUsedAt: entry.lastUsedAt,
      files: this.files(l.id),
    }
  }

  #writable(id: string): void {
    if (this.#isReadOnly(id)) throw new Error(readOnlyMessage(this.get(id)))
    if (!this.folderOf(id)) throw new Error('This skill no longer exists.')
  }

  /** A path inside the skill's folder, never outside it (no .., no links out). */
  #confine(id: string, path: string, allowMissing = false): string {
    const dir = this.folderOf(id)
    if (!dir) throw new Error(this.#isReadOnly(id) ? 'Built-in skills have no supporting files.' : 'This skill no longer exists.')
    if (!path || path.includes('\0') || path.split(/[\\/]/).some((p) => p === '..' || p.startsWith('.'))) throw new Error('That file isn’t in this skill.')
    const full = resolve(dir, path)
    if (!full.startsWith(resolve(dir) + sep)) throw new Error('That file isn’t in this skill.')
    if (!allowMissing && !existsSync(full)) throw new Error('That file is no longer in this skill.')
    return full
  }

  #touch(id: string, path: string | null): SkillFile {
    const entry = this.#index.items[id]
    if (entry) entry.updatedAt = this.#now()
    this.#writeIndex()
    this.#changed()
    const file = path ? this.files(id).find((f) => f.path === path) : undefined
    return file ?? { path: path ?? '', size: 0, modifiedAt: this.#now(), editable: false }
  }

  #snapshotSafe(ref: FileRef, text: string | Buffer, label: FileVersion['label']): void {
    try {
      this.#snapshot(ref, text, label)
    } catch (err) {
      // Losing a version is better than losing the edit; the versions store may not be ready.
      console.warn('Skill version not kept:', err instanceof Error ? err.message : err)
    }
  }

  #freeName(owner: Owner, base: string): string {
    const taken = (n: string): boolean => existsSync(join(this.#root, owner, n)) || this.#loaded.some((l) => l.doc.name === n && this.#index.items[l.id]?.owner === owner)
    if (!taken(base)) return base
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base.slice(0, 36)}-${n}`
      if (!taken(candidate)) return candidate
    }
    return `${base.slice(0, 31)}-${randomUUID().slice(0, 8)}`
  }

  #drop(l: Loaded): void {
    rmSync(l.dir, { recursive: true, force: true })
    delete this.#index.items[l.id]
    this.#loaded = this.#loaded.filter((x) => x.id !== l.id)
  }

  #readIndex(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.#root, INDEX_FILE), 'utf8'))
      if (isObject(raw) && isObject(raw.items)) {
        const items: Record<string, IndexEntry> = {}
        for (const [id, e] of Object.entries(raw.items)) {
          if (!isObject(e) || typeof e.owner !== 'string' || typeof e.name !== 'string') continue
          items[id] = { owner: e.owner, name: e.name, createdAt: num(e.createdAt) ?? 0, updatedAt: num(e.updatedAt) ?? 0, lastUsedAt: num(e.lastUsedAt) }
        }
        const used = isObject(raw.used) ? Object.fromEntries(Object.entries(raw.used).filter((x): x is [string, number] => typeof x[1] === 'number')) : {}
        this.#index = { version: 1, items, used }
      }
    } catch {
      // No index yet: the first scan builds one.
    }
  }

  #writeIndex(): void {
    writeAtomic(join(this.#root, INDEX_FILE), JSON.stringify(this.#index, null, 2))
  }

  #scan(): void {
    const found: Loaded[] = []
    const claimed = new Set<string>()
    let dirty = false
    const owners = existsSync(this.#root) ? readdirSync(this.#root).filter((o) => OWNER_DIR.test(o)).sort() : []
    for (const owner of owners) {
      let names: string[]
      try {
        names = readdirSync(join(this.#root, owner)).sort()
      } catch {
        continue
      }
      for (const folder of names) {
        const dir = join(this.#root, owner, folder)
        const main = join(dir, SKILL_MAIN_FILE)
        if (folder.startsWith('.') || !existsSync(main)) continue
        let doc: SkillDocument
        try {
          doc = parseSkillDocument(readFileSync(main, 'utf8'), { fileName: folder, deriveDescription: true })
        } catch (err) {
          // Shown so it can be fixed, rather than vanishing.
          const name = SKILL_NAME_PATTERN.test(folder) ? folder : 'unreadable-skill'
          doc = { name, description: `SKILL.md can’t be read: ${err instanceof Error ? err.message : 'unknown error'}`, instructions: readFileSync(main, 'utf8'), steps: [], extra: [] }
        }
        let id = Object.entries(this.#index.items).find(([eid, e]) => !claimed.has(eid) && e.owner === owner && e.name === folder)?.[0]
        if (!id) {
          id = randomUUID()
          const at = statSync(main).mtimeMs
          this.#index.items[id] = { owner, name: folder, createdAt: at, updatedAt: at, lastUsedAt: null }
          dirty = true
        }
        claimed.add(id)
        found.push({ id, dir, doc })
      }
    }
    for (const id of Object.keys(this.#index.items)) {
      if (!claimed.has(id)) {
        delete this.#index.items[id]
        dirty = true
      }
    }
    this.#loaded = found
    if (dirty) this.#writeIndex()
  }

  #changed(): void {
    this.emit('changed', this.all())
  }
}

function readOnlyMessage(skill: Skill | undefined): string {
  return skill?.source === 'pack' ? 'Skills from a pack are read-only. Duplicate it to make your own copy.' : 'Built-in skills are read-only. Duplicate it to make your own copy.'
}
