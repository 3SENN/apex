/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Agent-built apps on disk: userData/apps/<id>/app.json and
// one HTML file per version under versions/<v>.html. A build adds a draft;
// Save makes it current; Restore copies an older version forward as a new
// one, so history only grows (up to APP_VERSIONS_MAX). App versions keep
// their own history (they don't go through the Workspace version snapshots).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { APP_VERSIONS_MAX, validateAppHtml, type AppSummary, type AppVersion } from '@shared/apps'
import { writeAtomic } from '../settings'

interface StoredApp extends AppSummary {
  createdAt: number
  versions: AppVersion[]
}

const APP_ID = /^[0-9a-f-]{36}$/
const VERSION_ID = /^[A-Za-z0-9-]{1,64}$/

export class AppStore {
  readonly #dir: string

  constructor(dataDir: string) {
    this.#dir = join(dataDir, 'apps')
  }

  dirOf(id: string): string {
    if (!APP_ID.test(id)) throw new Error('This app no longer exists.')
    return join(this.#dir, id)
  }

  #versionPath(id: string, versionId: string): string {
    if (!VERSION_ID.test(versionId)) throw new Error('That version no longer exists.')
    return join(this.dirOf(id), 'versions', `${versionId}.html`)
  }

  #read(id: string): StoredApp {
    try {
      return JSON.parse(readFileSync(join(this.dirOf(id), 'app.json'), 'utf8')) as StoredApp
    } catch {
      throw new Error('This app no longer exists.')
    }
  }

  #write(app: StoredApp): void {
    writeAtomic(join(this.dirOf(app.id), 'app.json'), JSON.stringify(app, null, 2))
  }

  has(id: string): boolean {
    return APP_ID.test(id) && existsSync(join(this.#dir, id, 'app.json'))
  }

  list(owner?: string): AppSummary[] {
    if (!existsSync(this.#dir)) return []
    const out: AppSummary[] = []
    for (const id of readdirSync(this.#dir)) {
      if (!this.has(id)) continue
      try {
        const app = summary(this.#read(id))
        if (!owner || app.owner === owner) out.push(app)
      } catch {
        // A half-written folder is skipped, not fatal.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): AppSummary & { versions: AppVersion[] } {
    const app = this.#read(id)
    return { ...summary(app), versions: [...app.versions].sort((a, b) => b.at - a.at) }
  }

  /** A new app with its first draft (build_app without an id). */
  create(input: { name: string; description: string; owner: string; createdBy: string; html: string }): { app: AppSummary; versionId: string } {
    const id = randomUUID()
    const now = Date.now()
    const app: StoredApp = { id, name: input.name, description: input.description, owner: input.owner, createdBy: input.createdBy, currentVersionId: null, draftVersionId: null, updatedAt: now, createdAt: now, versions: [] }
    mkdirSync(join(this.dirOf(id), 'versions'), { recursive: true })
    this.#write(app)
    const versionId = this.addDraft(id, input.html, { name: input.name, description: input.description })
    return { app: summary(this.#read(id)), versionId }
  }

  /** A new draft version; the previous unsaved draft stays in the history. */
  addDraft(id: string, html: string, meta?: { name?: string; description?: string }): string {
    const check = validateAppHtml(html)
    if (!check.ok) throw new Error(check.reason)
    const app = this.#read(id)
    const versionId = randomUUID()
    writeAtomic(this.#versionPath(id, versionId), html)
    const now = Date.now()
    app.versions.push({ id: versionId, at: now, size: Buffer.byteLength(html), label: 'draft' })
    app.draftVersionId = versionId
    if (meta?.name) app.name = meta.name
    if (meta?.description !== undefined) app.description = meta.description
    app.updatedAt = now
    this.#prune(app)
    this.#write(app)
    return versionId
  }

  /** Creates an empty app, or renames and re-describes one. */
  save(input: { id?: string; name: string; description: string; owner?: string }, createdBy: string): AppSummary {
    if (!input.id) {
      const id = randomUUID()
      const now = Date.now()
      mkdirSync(join(this.dirOf(id), 'versions'), { recursive: true })
      const app: StoredApp = { id, name: input.name, description: input.description, owner: input.owner ?? 'shared', createdBy, currentVersionId: null, draftVersionId: null, updatedAt: now, createdAt: now, versions: [] }
      this.#write(app)
      return summary(app)
    }
    const app = this.#read(input.id)
    app.name = input.name
    app.description = input.description
    if (input.owner) app.owner = input.owner
    app.updatedAt = Date.now()
    this.#write(app)
    return summary(app)
  }

  /** Save from the preview card: this version becomes the one that runs. */
  saveDraft(id: string, versionId: string): AppSummary {
    const app = this.#read(id)
    const version = app.versions.find((v) => v.id === versionId)
    if (!version) throw new Error('That version no longer exists.')
    if (version.label === 'draft') version.label = 'saved'
    app.currentVersionId = versionId
    if (app.draftVersionId === versionId) app.draftVersionId = null
    app.updatedAt = Date.now()
    this.#write(app)
    return summary(app)
  }

  /** Copies an older version forward as a new current one. */
  restoreVersion(id: string, versionId: string): AppSummary {
    const app = this.#read(id)
    if (!app.versions.some((v) => v.id === versionId)) throw new Error('That version no longer exists.')
    const html = this.html(id, versionId)
    const copy = randomUUID()
    writeAtomic(this.#versionPath(id, copy), html)
    const now = Date.now()
    app.versions.push({ id: copy, at: now, size: Buffer.byteLength(html), label: 'restored' })
    app.currentVersionId = copy
    app.updatedAt = now
    this.#prune(app)
    this.#write(app)
    return summary(app)
  }

  /** One version's HTML; without a version, the current one (or the draft, before the first save). */
  html(id: string, versionId?: string | null): string {
    const app = this.#read(id)
    const chosen = versionId ?? app.currentVersionId ?? app.draftVersionId
    if (!chosen || !app.versions.some((v) => v.id === chosen)) throw new Error('This app has no saved version yet.')
    return readFileSync(this.#versionPath(id, chosen), 'utf8')
  }

  /** Removes the folder for good (Recently Deleted moved it first, or restore failed). */
  purge(id: string): void {
    rmSync(this.dirOf(id), { recursive: true, force: true })
  }

  /** Total size on disk, for storage views. */
  bytes(id: string): number {
    const dir = join(this.dirOf(id), 'versions')
    if (!existsSync(dir)) return 0
    return readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0)
  }

  #prune(app: StoredApp): void {
    while (app.versions.length > APP_VERSIONS_MAX) {
      const oldest = [...app.versions].sort((a, b) => a.at - b.at).find((v) => v.id !== app.currentVersionId && v.id !== app.draftVersionId)
      if (!oldest) return
      app.versions = app.versions.filter((v) => v.id !== oldest.id)
      rmSync(this.#versionPath(app.id, oldest.id), { force: true })
    }
  }
}

function summary(app: StoredApp): AppSummary {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    owner: app.owner,
    currentVersionId: app.currentVersionId,
    draftVersionId: app.draftVersionId,
    updatedAt: app.updatedAt,
    createdBy: app.createdBy,
  }
}
