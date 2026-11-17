/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { COMPANION_SKILL_FILE_MAX_BYTES, type Companion, type CompanionFile, type CompanionFileSkill, type CompanionImportPreview } from '@shared/companion'
import type { CompanionExportOptions, NewCompanionInput } from '@shared/services'
import { companionFile, parseCompanionFile, uniqueName, type CompanionStore } from './companions'
import type { MemoryService } from './memory'
import type { ConnectorStore, RoutineStore, SkillStore } from './stores'

// What happens around a companion beyond its own record: its skills (steps and
// supporting text files too), routines, connectors and memory folder follow it
// when it is duplicated, shared or deleted, and .apexcompanion files are
// checked and previewed before they are added. Dialogs and the Trash are
// main's job (src/main/index.ts).

const IMPORT_TTL_MS = 30 * 60_000

export interface CompanionServiceDeps {
  store: CompanionStore
  skills: SkillStore
  routines: RoutineStore
  connectors: ConnectorStore
  memory: MemoryService
  /** Moves a deleted companion's memory folder to the Trash. Without it, the folder is deleted. */
  trash?: (folder: string) => Promise<void>
}

export class CompanionService {
  readonly #deps: CompanionServiceDeps
  readonly #imports = new Map<string, { file: CompanionFile; expires: number }>()

  constructor(deps: CompanionServiceDeps) {
    this.#deps = deps
  }

  create(input: NewCompanionInput): Companion {
    return this.#deps.store.create(input)
  }

  /** Copies the companion with its own skills and memory folder. Routines are not copied, so nothing runs twice. */
  duplicate(id: string): Companion {
    const { store, memory } = this.#deps
    const copy = store.duplicate(id)
    for (const skill of this.#ownSkills(id)) this.#addSkill(copy.id, skill)
    memory.copyOwner(id, copy.id)
    return copy
  }

  /** The companion's own skills as a companion file carries them: steps, and supporting text files up to the size limit. */
  #ownSkills(id: string): CompanionFileSkill[] {
    const { skills } = this.#deps
    return skills.ownedBy(id).map((skill) => {
      const files: Array<{ path: string; text: string }> = []
      for (const file of skill.files) {
        if (!file.editable || file.size > COMPANION_SKILL_FILE_MAX_BYTES) continue
        try {
          files.push({ path: file.path, text: skills.readFile(skill.id, file.path) })
        } catch {
          // A file that can't be read stays behind; the skill still travels.
        }
      }
      return {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        ...(skill.steps.length ? { steps: skill.steps.map(({ title, instructions }) => ({ title, instructions })) } : {}),
        ...(files.length ? { files } : {}),
      }
    })
  }

  /** Adds a skill from a companion file as the companion's own, with its steps and files. */
  #addSkill(owner: string, skill: CompanionFileSkill): void {
    const { skills } = this.#deps
    const steps = (skill.steps ?? []).map((s, i) => ({ id: `step-${i + 1}`, title: s.title, instructions: s.instructions }))
    const saved = skills.save({ name: skill.name, description: skill.description, instructions: skill.instructions, steps, owner })
    for (const file of skill.files ?? []) {
      try {
        skills.writeFile(saved.id, file.path, file.text)
      } catch (err) {
        console.warn('Skipped a skill file:', err instanceof Error ? err.message : err)
      }
    }
  }

  /** Deletes the companion and what it owns. Its chats stay. Refuses the last visible companion. */
  async remove(id: string): Promise<void> {
    const { store, skills, routines, connectors, memory, trash } = this.#deps
    store.remove(id)
    skills.removeOwned(id)
    routines.removeOwned(id)
    connectors.removeOwned(id)
    const folder = memory.ownerFolder(id)
    if (folder && trash) {
      try {
        await trash(folder)
        return
      } catch {
        // Fall through and delete it.
      }
    }
    memory.removeOwner(id)
  }

  /** The .apexcompanion JSON for a companion, with the parts the exporter chose. */
  exportText(id: string, options: CompanionExportOptions = {}): string {
    const { store, routines, memory } = this.#deps
    const companion = store.get(id)
    const file = companionFile(companion, {
      ...(options.note ? { note: options.note } : {}),
      ...(options.includeSkills ? { skills: this.#ownSkills(id) } : {}),
      ...(options.includeRoutines ? { routines: routines.ownedBy(id).map(({ name, prompt, schedule }) => ({ name, prompt, schedule })) } : {}),
      ...(options.includeMemory ? { memory: memory.list(id).map((f) => ({ path: f.path, text: memory.read(f.path, id) })) } : {}),
    })
    return JSON.stringify(file, null, 2)
  }

  /** Checks a file's text and keeps it for confirmImport. Throws a readable error for bad files. */
  preview(text: string, now = Date.now()): CompanionImportPreview {
    const file = parseCompanionFile(text)
    for (const [token, entry] of this.#imports) if (entry.expires < now) this.#imports.delete(token)
    const token = randomUUID()
    this.#imports.set(token, { file, expires: now + IMPORT_TTL_MS })
    return {
      token,
      version: file.version,
      name: uniqueName(file.name, this.#deps.store.list().map((c) => c.name)),
      originalName: file.name,
      persona: file.persona,
      look: file.look,
      note: file.note ?? null,
      instructions: file.instructions,
      model: file.model,
      effort: file.effort,
      skills: (file.skills ?? []).map(({ name, description }) => ({ name, description })),
      routines: (file.routines ?? []).map(({ name, schedule }) => ({ name, schedule })),
      memoryFiles: file.memory?.length ?? 0,
    }
  }

  /** Adds a previewed file as a new companion; it never overwrites one. Imported routines start paused. */
  confirm(token: string, now = Date.now()): Companion {
    const entry = this.#imports.get(token)
    if (!entry || entry.expires < now) throw new Error('This import has expired. Open the file again.')
    this.#imports.delete(token)
    const { file } = entry
    const { store, routines, memory } = this.#deps
    const companion = store.create({
      name: file.name,
      persona: file.persona,
      look: file.look,
      instructions: file.instructions,
      model: file.model,
      effort: file.effort,
      activate: true,
    })
    for (const skill of file.skills ?? []) {
      try {
        this.#addSkill(companion.id, skill)
      } catch (err) {
        console.warn('Skipped an imported skill:', err instanceof Error ? err.message : err)
      }
    }
    for (const routine of file.routines ?? []) routines.save({ ...routine, enabled: false, owner: companion.id }, now)
    for (const note of file.memory ?? []) {
      try {
        memory.write(note.path, note.text, companion.id)
      } catch (err) {
        console.warn('Skipped an imported memory file:', err instanceof Error ? err.message : err)
      }
    }
    return companion
  }
}
