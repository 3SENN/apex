/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Skills as folders (SK-01 to SK-06), built-in skills and Workflows merged
// into Skills. A skill lives in userData/skills/<owner>/<name>/ with SKILL.md
// and its supporting files; the old skills.json is migrated once (kept as
// skills.json.bak). Library › Workflows is not a separate page; a workflow
// is a skill with ordered steps.
import type { Owner } from './services'

export interface SkillStep {
  id: string
  title: string
  instructions: string
}

export interface SkillFile {
  /** Relative to the skill's folder, '/'-separated. */
  path: string
  size: number
  modifiedAt: number
  /** Built-in skills and SKILL.md's generated parts are read-only. */
  editable: boolean
}

export interface Skill {
  id: string
  /** Invoked as /name. Lowercase letters, digits and dashes; unique per owner. */
  name: string
  description: string
  instructions: string
  steps: SkillStep[]
  owner: Owner
  /** 'pack': read-only, from an installed pack (docs/packs.md). */
  source: 'user' | 'builtin' | 'pack'
  builtinVersion: string | null
  /** The pack a 'pack' skill comes from. */
  pack?: { id: string; name: string }
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  files: SkillFile[]
}

export interface SkillDraft {
  name: string
  description: string
  instructions: string
  steps?: SkillStep[]
  owner?: Owner
  /** The id of the companion's own skill this draft changes (draft_skill on a name it already has); saving updates that skill. */
  updates?: string
}

export interface SkillFilter {
  query?: string
  source?: 'yours' | 'companions' | 'builtin' | 'packs'
  owner?: Owner
  updatedSince?: number
  sort?: 'recent-use' | 'recent-update' | 'name'
}

export const SKILL_FILE_MAX_BYTES = 5 * 1024 * 1024

/** A skill's /name: lowercase letters, digits and dashes, up to 40. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
export const SKILL_DESCRIPTION_MAX = 500
export const SKILL_INSTRUCTIONS_MAX = 50_000
/** Supporting files per skill (SKILL.md not counted). */
export const SKILL_FILES_MAX = 50
/** The main file of every skill folder. */
export const SKILL_MAIN_FILE = 'SKILL.md'

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'py', 'sh', 'rb', 'sql', 'toml', 'ini', 'svg'])

/** Supporting files of these types open in the editor; the rest are view-only. */
export function isTextSkillFile(path: string): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext !== undefined && TEXT_EXTENSIONS.has(ext)
}

/** What `skills.save` takes: a draft, plus the id when it updates one. */
export type SkillSaveInput = SkillDraft & { id?: string }

/** The segment a skill sits in on the Skills page. */
export function skillSegment(skill: Pick<Skill, 'source' | 'owner'>, sharedOwner = 'shared'): 'yours' | 'companions' | 'builtin' | 'packs' {
  if (skill.source === 'builtin') return 'builtin'
  if (skill.source === 'pack') return 'packs'
  return skill.owner === sharedOwner ? 'yours' : 'companions'
}
/** The Skills page's search, filters and sort (SK-01), used by `skills.list(filter)` and the page alike. */
export function filterSkills(skills: readonly Skill[], filter: SkillFilter = {}, sharedOwner = 'shared'): Skill[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const out = skills.filter((s) => {
    if (filter.source && skillSegment(s, sharedOwner) !== filter.source) return false
    if (filter.owner && s.owner !== filter.owner) return false
    if (filter.updatedSince !== undefined && s.source === 'user' && s.updatedAt < filter.updatedSince) return false
    if (filter.updatedSince !== undefined && s.source !== 'user') return false
    const text = `${s.name} ${s.description} ${s.instructions}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
  const byName = (a: Skill, b: Skill): number => a.name.localeCompare(b.name)
  switch (filter.sort) {
    case 'recent-use':
      return out.sort((a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1) || byName(a, b))
    case 'recent-update':
      return out.sort((a, b) => b.updatedAt - a.updatedAt || byName(a, b))
    case 'name':
      return out.sort(byName)
    default:
      return out
  }
}

/**
 * Methods added to the `skills` namespace. The original methods (list,
 * save, remove, exportFile, importFile) keep their names, widened to
 * `list(filter?: SkillFilter)` and `save(SkillDraft & { id? })` by the
 * folder store.
 */
export interface SkillsMethods {
  get(id: string): Skill
  duplicate(id: string, owner?: Owner): Skill
  files(id: string): SkillFile[]
  readFile(id: string, path: string): string
  writeFile(id: string, path: string, text: string): SkillFile
  addFile(id: string, name: string, base64: string): SkillFile
  removeFile(id: string, path: string): void
  reveal(id: string): void
  /** Save as skill (SK-06): drafts a skill from a chat with the quick model. */
  draftFromChat(chatId: string): Promise<SkillDraft>
  /** Starts a chat that runs the skill; returns the chat id. */
  run(id: string, companionId?: string): string
}

/** AppEvent additions for skill folders. */
export type SkillsEvent = { type: 'skill-files'; skillId: string }
