/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Projects (SH-64): a name, a palette colour, a description,
// standing instructions, chats and files. A chat's project is its
// ChatSummary.projectId (the chat store stays the one source of truth); the
// project row keeps everything else in workspace.sqlite. Deleting a project
// moves it to Recently Deleted and clears projectId on its chats; restoring
// links back the chats that are still unfiled.
import { randomUUID } from 'node:crypto'
import { PROJECT_COLORS, fileRefKey, type FileRef, type Project } from '@shared/workspace'
import { migrate, type DatabaseSync } from '../db'

export const PROJECT_STEPS = [
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    files TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
]

/** What projects need from the chat store. */
export interface ChatLinks {
  list(): Array<{ id: string; projectId: string | null; private: boolean; draft: boolean }>
  setProject(ids: string[], projectId: string | null): void
}

interface Row {
  id: string
  name: string
  color: string
  description: string
  instructions: string
  files: string
  created_at: number
  updated_at: number
}

/** What a deleted project keeps in Recently Deleted. */
export interface ProjectTrashPayload {
  project: Omit<Project, 'chatIds'>
  chatIds: string[]
}

export type ProjectInput = { id?: string; name: string; color: string; description: string; instructions: string }

/** Up to 500 files per project. */
export const PROJECT_FILES_MAX = 500

export class ProjectStore {
  readonly #db: DatabaseSync
  readonly #chats: ChatLinks
  readonly #now: () => number
  readonly #onChange: (projects: Project[]) => void

  constructor(options: { db: DatabaseSync; chats: ChatLinks; now?: () => number; onChange?(projects: Project[]): void }) {
    this.#db = options.db
    this.#chats = options.chats
    this.#now = options.now ?? Date.now
    this.#onChange = options.onChange ?? (() => {})
    migrate(this.#db, 'projects', PROJECT_STEPS)
  }

  /** Most recently changed first. */
  list(): Project[] {
    const byProject = this.#chatsByProject()
    return (this.#db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, rowid DESC').all() as unknown as Row[]).map((r) => this.#toProject(r, byProject))
  }

  find(id: string): Project | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return row ? this.#toProject(row, this.#chatsByProject()) : null
  }

  get(id: string): Project {
    const project = this.find(id)
    if (!project) throw new Error('That project no longer exists.')
    return project
  }

  save(input: ProjectInput): Project {
    const name = input.name.trim()
    if (!name) throw new Error('Give the project a name.')
    const color = (PROJECT_COLORS as readonly string[]).includes(input.color) ? input.color : PROJECT_COLORS[0]
    const now = this.#now()
    if (input.id) {
      this.get(input.id)
      this.#db.prepare('UPDATE projects SET name = ?, color = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?').run(name, color, input.description, input.instructions, now, input.id)
      this.#changed()
      return this.get(input.id)
    }
    const id = randomUUID()
    this.#db.prepare('INSERT INTO projects (id, name, color, description, instructions, files, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, name, color, input.description, input.instructions, '[]', now, now)
    this.#changed()
    return this.get(id)
  }

  /** Deletes the row and unfiles its chats. Recently Deleted keeps the payload (trashPayload) first. */
  remove(id: string): void {
    const project = this.get(id)
    if (project.chatIds.length > 0) this.#chats.setProject(project.chatIds, null)
    this.#db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    this.#changed()
  }

  trashPayload(id: string): ProjectTrashPayload {
    const { chatIds, ...project } = this.get(id)
    return { project, chatIds }
  }

  /** Puts a deleted project back (a clashing name gets a number) and re-files its chats that are still unfiled. */
  restore(payload: ProjectTrashPayload): string {
    const p = payload.project
    const taken = new Set(this.list().map((x) => x.name.toLowerCase()))
    let name = p.name
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${p.name} ${n}`
    const id = this.find(p.id) ? randomUUID() : p.id
    this.#db
      .prepare('INSERT INTO projects (id, name, color, description, instructions, files, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, p.color, p.description, p.instructions, JSON.stringify(p.files), p.createdAt, this.#now())
    const unfiled = new Set(this.#chats.list().filter((c) => c.projectId === null).map((c) => c.id))
    const relink = payload.chatIds.filter((c) => unfiled.has(c))
    if (relink.length > 0) this.#chats.setProject(relink, id)
    this.#changed()
    return name
  }

  addChats(id: string, chatIds: string[]): Project {
    this.get(id)
    const known = new Map(this.#chats.list().map((c) => [c.id, c]))
    const ids = chatIds.filter((c) => known.has(c) && !known.get(c)?.private)
    if (ids.length > 0) this.#chats.setProject(ids, id)
    this.#touch(id)
    return this.get(id)
  }

  removeChats(id: string, chatIds: string[]): Project {
    const project = this.get(id)
    const ids = chatIds.filter((c) => project.chatIds.includes(c))
    if (ids.length > 0) this.#chats.setProject(ids, null)
    this.#touch(id)
    return this.get(id)
  }

  addFiles(id: string, refs: FileRef[]): Project {
    const project = this.get(id)
    const keys = new Set(project.files.map(fileRefKey))
    const files = [...project.files, ...refs.filter((r) => !keys.has(fileRefKey(r)) && keys.add(fileRefKey(r)))]
    if (files.length > PROJECT_FILES_MAX) throw new Error(`A project holds up to ${PROJECT_FILES_MAX} files.`)
    this.#db.prepare('UPDATE projects SET files = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(files), this.#now(), id)
    this.#changed()
    return this.get(id)
  }

  removeFiles(id: string, refs: FileRef[]): Project {
    const project = this.get(id)
    const drop = new Set(refs.map(fileRefKey))
    this.#db.prepare('UPDATE projects SET files = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(project.files.filter((f) => !drop.has(fileRefKey(f)))), this.#now(), id)
    this.#changed()
    return this.get(id)
  }

  /** Drops a file from every project (it was deleted for good). */
  forgetFile(ref: FileRef): void {
    const key = fileRefKey(ref)
    for (const p of this.list()) if (p.files.some((f) => fileRefKey(f) === key)) this.removeFiles(p.id, [ref])
  }

  /** Re-announces the list (a chat moved in or out). */
  refresh(): void {
    this.#changed()
  }

  #touch(id: string): void {
    this.#db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(this.#now(), id)
    this.#changed()
  }

  #chatsByProject(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const c of this.#chats.list()) {
      if (!c.projectId || c.private || c.draft) continue
      const list = map.get(c.projectId) ?? []
      list.push(c.id)
      map.set(c.projectId, list)
    }
    return map
  }

  #toProject(r: Row, byProject: Map<string, string[]>): Project {
    let files: FileRef[] = []
    try {
      const parsed = JSON.parse(r.files) as unknown
      if (Array.isArray(parsed)) files = parsed as FileRef[]
    } catch {
      // A damaged list starts empty rather than hiding the project.
    }
    return { id: r.id, name: r.name, color: r.color, description: r.description, instructions: r.instructions, chatIds: byProject.get(r.id) ?? [], files, createdAt: r.created_at, updatedAt: r.updated_at }
  }

  #changed(): void {
    this.#onChange(this.list())
  }
}
