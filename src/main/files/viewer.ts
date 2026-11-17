/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { VIEWER_BYTES_MAX, VIEWER_TEXT_MAX, type ViewerDoc, type ViewerDocState, type ViewerTarget } from '@shared/files'
import { extensionOf, isArtifactable, isTextPreviewable, mediaTypeOf, parseFrontmatter, previewableOf } from '@shared/fileKinds'
import type { MeetingResolver } from '@shared/meetings'
import { readDelimited, readXlsx } from '@shared/sheetReader'
import { cleanFileName } from '../companionFiles'
import type { AttachmentStore, ChatFilesReader } from '../intake/types'
import { PathRefused, confine, isGranted } from './confine'
import type { LibraryStore } from './library'
import { TokenRegistry } from './tokens'
import type { ViewerDeletion } from './types'
import { mainT } from '../i18n/mainT'

// The viewer service (OV-32). It opens anything Atelier holds, through one
// token per open document: Library files, companion files, memory, skills,
// meeting transcripts, chat files, attachments, and local files the person
// picked this session. Every path is confined to Atelier's own folders (real
// paths, so symlinks can't escape); nothing else on disk opens.

const OWNER_ID = /^[A-Za-z0-9-]{1,64}$/
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/
/** XLSX previews read at most this much of the workbook file. */
const XLSX_MAX_BYTES = 30_000_000

export interface ViewerDeps {
  dataDir: string
  library: LibraryStore
  attachments?: () => AttachmentStore
  chatFiles?: () => ChatFilesReader
  meetings?: () => MeetingResolver
  /** Moves a file to the Trash; without it, deletes. */
  trash?: (path: string) => Promise<void>
  reveal?: (path: string) => void
  saveDialog?: (defaultName: string) => Promise<string | null>
  openDialog?: () => Promise<string | null>
  now?: () => number
}

/** What a target resolved to: a real file, or text Atelier keeps elsewhere (a skill record, a transcript). */
export interface ViewerSource {
  target: ViewerTarget
  name: string
  path: string | null
  text: string | null
  mediaType: string
  writable: boolean
  renamable: boolean
  deletable: boolean
  revealable: boolean
  libraryId: string | null
  state: ViewerDocState
  error?: string
}

function source(target: ViewerTarget, name: string, rest: Partial<ViewerSource>): ViewerSource {
  return { target, name, path: null, text: null, mediaType: mediaTypeOf(name), writable: false, renamable: false, deletable: false, revealable: false, libraryId: null, state: 'ready', ...rest }
}

function readOnly(target: ViewerTarget, name: string, path: string | null, rest: Partial<ViewerSource> = {}): ViewerSource {
  return source(target, name, { path, revealable: path !== null, state: path === null || existsSync(path) ? 'ready' : 'missing', ...rest })
}

function ownFile(target: ViewerTarget, path: string, rest: Partial<ViewerSource> = {}): ViewerSource {
  return source(target, basename(path), { path, writable: true, renamable: true, deletable: true, revealable: true, state: existsSync(path) ? 'ready' : 'missing', ...rest })
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Not available yet: .*$/, mainT('files.error.unavailable'))
}

export class Viewer {
  readonly #deps: ViewerDeps
  readonly #tokens: TokenRegistry<ViewerSource>
  readonly #granted = new Set<string>()
  readonly #deleteListeners = new Set<(deleted: ViewerDeletion) => void>()

  constructor(deps: ViewerDeps) {
    this.#deps = deps
    this.#tokens = new TokenRegistry({ now: deps.now })
  }

  // ── targets ──

  #memoryRoot(owner: string): string {
    if (owner === 'shared') return join(this.#deps.dataDir, 'memory', 'memories')
    if (!OWNER_ID.test(owner)) throw new PathRefused()
    return join(this.#deps.dataDir, 'memory', 'companions', owner, 'memories')
  }

  async resolve(target: ViewerTarget): Promise<ViewerSource> {
    const { dataDir, library } = this.#deps
    switch (target.kind) {
      case 'library': {
        const file = library.get(target.id)
        if (!file) return source(target, 'File', { state: 'missing' })
        const path = library.pathOf(target.id)
        const state: ViewerDocState = !existsSync(path) ? 'missing' : file.state === 'writing' ? 'writing' : file.state === 'failed' ? 'error' : 'ready'
        return source(target, file.name, { path, mediaType: file.mediaType, writable: true, renamable: true, deletable: true, revealable: true, libraryId: file.id, state, error: state === 'error' ? (library.errorOf(file.id) ?? mainT('files.error.failed')) : undefined })
      }
      case 'companion-file': {
        if (!OWNER_ID.test(target.companionId)) throw new PathRefused()
        return ownFile(target, confine(join(dataDir, 'companion-files', target.companionId), target.path))
      }
      case 'memory': {
        const rel = target.path.replace(/^\/?memories(\/|$)/, '')
        return ownFile(target, confine(this.#memoryRoot(target.owner), rel))
      }
      case 'skill': {
        if (!RECORD_ID.test(target.skillId)) throw new PathRefused()
        // Skill folders hold SKILL.md; a skill without one is a record in skills.json. Skills are edited in their own editor.
        const folderFile = confine(join(dataDir, 'skills'), `${target.skillId}/SKILL.md`)
        if (existsSync(folderFile)) return readOnly(target, 'SKILL.md', folderFile, { mediaType: 'text/markdown' })
        const skill = readSkillRecord(join(dataDir, 'skills.json'), target.skillId)
        if (!skill) return source(target, 'Skill', { state: 'missing' })
        const text = `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\s+/g, ' ')}\n---\n\n${skill.instructions}\n`
        return source(target, `${skill.name}.md`, { text, mediaType: 'text/markdown' })
      }
      case 'meeting': {
        if (!RECORD_ID.test(target.meetingId)) throw new PathRefused()
        try {
          const meeting = await this.#deps.meetings?.().forPrompt(target.meetingId)
          if (!meeting) return source(target, 'Meeting', { state: 'missing' })
          return source(target, meeting.title || 'Meeting', { text: meeting.text, mediaType: 'text/plain', state: meeting.ready ? 'ready' : 'writing' })
        } catch (err) {
          return source(target, 'Meeting', { state: 'missing', error: errorMessage(err) })
        }
      }
      case 'chat-file':
        return this.#chatFile(target)
      case 'attachment':
        return this.#attachment(target)
      case 'local': {
        const real = isGranted(this.#granted, target.path)
        if (!real) throw new PathRefused(mainT('files.error.localRefused'))
        // The person's own file: viewable, editable and revealable, but renamed or deleted only in Finder.
        return source(target, basename(real), { path: real, writable: true, revealable: true, state: existsSync(real) ? 'ready' : 'missing' })
      }
    }
  }

  #chatFile(target: Extract<ViewerTarget, { kind: 'chat-file' }>): ViewerSource {
    const name = target.path.split('/').pop() || 'File'
    // Generated files are Library files; the rest comes from the chat's virtual folders.
    if (target.path.startsWith('generated/')) {
      const file = this.#deps.library.listByChat(target.chatId).find((f) => f.name === name)
      if (file) return { ...source(target, file.name, {}), ...this.#libraryParts(file.id), target }
    }
    try {
      const reader = this.#deps.chatFiles?.()
      if (!reader) return source(target, name, { state: 'error', error: mainT('files.error.chatFilesUnavailable') })
      const physical = reader.physicalPath(target.chatId, target.path)
      if (physical) {
        confine(join(this.#deps.dataDir), relative(this.#deps.dataDir, physical).split(sep).join('/'))
        return readOnly(target, name, physical)
      }
      const read = reader.read(target.chatId, target.path)
      if (read.text === undefined) return source(target, name, { state: 'error', error: mainT('files.error.cantShow') })
      return source(target, name, { text: read.text, mediaType: mediaTypeOf(name) === 'application/octet-stream' ? 'text/plain' : mediaTypeOf(name) })
    } catch (err) {
      if (err instanceof PathRefused) throw err
      return source(target, name, { state: 'missing', error: errorMessage(err) })
    }
  }

  #libraryParts(id: string): Partial<ViewerSource> {
    const file = this.#deps.library.get(id)
    if (!file) return { state: 'missing' }
    const path = this.#deps.library.pathOf(id)
    return { name: file.name, path, mediaType: file.mediaType, writable: true, renamable: true, deletable: true, revealable: true, libraryId: id, state: file.state === 'writing' ? 'writing' : file.state === 'failed' ? 'error' : 'ready' }
  }

  #attachment(target: Extract<ViewerTarget, { kind: 'attachment' }>): ViewerSource {
    const root = join(this.#deps.dataDir, 'attachments')
    const within = (path: string): string => confine(root, relative(root, path).split(sep).join('/'))
    try {
      const store = this.#deps.attachments?.()
      if (!store) return source(target, 'Attachment', { state: 'error', error: mainT('files.error.attachmentsUnavailable') })
      const file = typeof store.file === 'function' ? store.file(target.chatId, target.attachmentId) : null
      if (file) {
        const path = file.originalPath ?? file.preparedPath
        if (path) return readOnly(target, file.ref.name, within(path), { mediaType: file.ref.mediaType || mediaTypeOf(file.ref.name) })
      }
      const [prepared] = store.resolve(target.chatId, [target.attachmentId])
      if (!prepared) return source(target, 'Attachment', { state: 'missing' })
      const p = prepared.payload
      if (p.type === 'text') return source(target, prepared.ref.name || p.title, { text: p.text, mediaType: prepared.ref.mediaType || 'text/plain' })
      if (p.type === 'skill') return source(target, prepared.ref.name, { state: 'error', error: mainT('files.error.skillAttachment') })
      return readOnly(target, prepared.ref.name, within(p.path), { mediaType: p.type === 'pdf' ? 'application/pdf' : p.mediaType })
    } catch (err) {
      if (err instanceof PathRefused) throw err
      return source(target, 'Attachment', { state: 'missing', error: errorMessage(err) })
    }
  }

  // ── documents ──

  #doc(token: string, src: ViewerSource): ViewerDoc {
    let size = 0
    let modifiedAt: number | null = null
    let state = src.state
    if (src.path && state !== 'missing') {
      try {
        const stat = statSync(src.path)
        size = stat.size
        modifiedAt = Math.round(stat.mtimeMs)
      } catch {
        state = 'missing'
      }
    } else if (src.text !== null) size = Buffer.byteLength(src.text)
    const previewable = previewableOf(src.name, src.mediaType, size)
    const live = state === 'ready' || state === 'writing'
    const doc: ViewerDoc = {
      token,
      name: src.name,
      mediaType: src.mediaType,
      previewable,
      size,
      editable: false,
      state,
      ...(src.error && state !== 'ready' ? { error: src.error } : {}),
      source: src.target.kind,
      revealable: src.revealable && src.path !== null && state !== 'missing',
      renamable: src.renamable && state !== 'writing',
      deletable: src.deletable && state !== 'writing',
      exportable: live && (src.path !== null || src.text !== null),
      artifactable: state === 'ready' && isArtifactable(previewable),
      libraryId: src.libraryId,
      modifiedAt,
    }
    if (!live) return doc
    if (src.path || src.text !== null) {
      if (previewable === 'image' || previewable === 'svg' || previewable === 'pdf' || previewable === 'audio' || previewable === 'video' || previewable === 'binary' || previewable === 'unknown') {
        doc.url = `atelier-file://${token}/${encodeURIComponent(src.name)}`
      }
    }
    try {
      if (isTextPreviewable(previewable, src.name)) {
        const { text, truncated } = this.#readText(src)
        doc.text = text
        if (truncated) doc.truncated = true
        if (previewable === 'markdown') {
          const front = parseFrontmatter(text).data
          if (Object.keys(front).length > 0) doc.frontmatter = front
        }
        doc.editable = src.writable && !truncated && state === 'ready'
        if (previewable === 'sheet') doc.sheet = readDelimited(text, extensionOf(src.name) === 'tsv' || src.mediaType === 'text/tab-separated-values' ? '\t' : undefined)
      } else if (previewable === 'sheet' && src.path) {
        if (size > XLSX_MAX_BYTES) throw new Error(mainT('files.error.workbookTooLarge'))
        doc.sheet = readXlsx(readFileSync(src.path))
      } else if (previewable === 'empty') {
        doc.text = ''
        doc.editable = src.writable && state === 'ready' && (src.mediaType.startsWith('text/') || isTextPreviewable(previewableOf(src.name, src.mediaType, 1), src.name))
      }
    } catch (err) {
      doc.state = 'error'
      doc.error = errorMessage(err)
      doc.editable = false
    }
    return doc
  }

  #readText(src: ViewerSource): { text: string; truncated: boolean } {
    const raw = src.text ?? readFileSync(src.path as string, 'utf8')
    return raw.length > VIEWER_TEXT_MAX ? { text: raw.slice(0, VIEWER_TEXT_MAX), truncated: true } : { text: raw, truncated: false }
  }

  #source(token: string): ViewerSource {
    const src = this.#tokens.get(token)
    if (!src) throw new Error(mainT('files.error.expired'))
    return src
  }

  /** Re-reads the source behind a token (a report finishing, a file renamed elsewhere). */
  async #refresh(token: string): Promise<ViewerSource> {
    const fresh = await this.resolve(this.#source(token).target)
    this.#tokens.set(token, fresh)
    return fresh
  }

  // ── service ──

  async open(target: ViewerTarget, owner: string | null = null): Promise<ViewerDoc> {
    const src = await this.resolve(target)
    const token = this.#tokens.issue(src, owner)
    return this.#doc(token, src)
  }

  save(token: string, text: string): ViewerDoc {
    const src = this.#source(token)
    if (!src.writable || !src.path) throw new Error(mainT('files.error.notEditable'))
    if (!existsSync(src.path)) throw new Error(mainT('files.error.goneOnSave'))
    if (src.libraryId) this.#deps.library.write(src.libraryId, text)
    else writeFileSync(src.path, text)
    return this.#doc(token, src)
  }

  rename(token: string, name: string): ViewerDoc {
    const src = this.#source(token)
    if (!src.renamable || !src.path) throw new Error(mainT('files.error.notRenamable'))
    const next = cleanFileName(name)
    if (next === src.name) return this.#doc(token, src)
    let updated: ViewerSource
    if (src.libraryId) {
      const file = this.#deps.library.rename(src.libraryId, next)
      updated = { ...src, name: file.name, path: this.#deps.library.pathOf(file.id), mediaType: file.mediaType }
    } else {
      const to = join(dirname(src.path), next)
      if (existsSync(to) && to.toLowerCase() !== src.path.toLowerCase()) throw new Error(mainT('files.error.nameTaken', { name: next }))
      renameSync(src.path, to)
      const target = renamedTarget(src.target, next)
      updated = { ...src, target, name: next, path: to, mediaType: mediaTypeOf(next) }
    }
    this.#tokens.set(token, updated)
    return this.#doc(token, updated)
  }

  async remove(token: string): Promise<void> {
    const src = this.#source(token)
    if (!src.deletable || !src.path) throw new Error(mainT('files.error.notDeletable'))
    let trashedPath: string | null = null
    if (src.libraryId) {
      trashedPath = (await this.#deps.library.remove(src.libraryId)).trashedPath
    } else if (existsSync(src.path)) {
      if (this.#deps.trash) {
        await this.#deps.trash(src.path)
        trashedPath = src.path
      } else rmSync(src.path, { force: true })
    }
    const path = src.path
    for (const t of this.#tokens.findAll((s) => s.path === path)) this.#tokens.release(t)
    this.notifyDeleted({ name: src.name, mediaType: src.mediaType, trashedPath, target: src.target })
  }

  notifyDeleted(deleted: ViewerDeletion): void {
    for (const fn of this.#deleteListeners) {
      try {
        fn(deleted)
      } catch {
        // A listener's failure never undoes the delete.
      }
    }
  }

  revealPath(token: string): string {
    const src = this.#source(token)
    if (!src.revealable || !src.path || !existsSync(src.path)) throw new Error(mainT('files.error.notRevealable'))
    this.#deps.reveal?.(src.path)
    return src.path
  }

  async export(token: string): Promise<string | null> {
    const src = this.#source(token)
    if (!src.path && src.text === null) throw new Error(mainT('files.error.nothingToExport'))
    const dest = await this.#deps.saveDialog?.(src.name)
    if (!dest) return null
    if (src.path) copyFileSync(src.path, dest)
    else writeFileSync(dest, src.text ?? '')
    return dest
  }

  async pickLocal(): Promise<ViewerTarget | null> {
    const path = await this.#deps.openDialog?.()
    return path ? this.grantLocal(path) : null
  }

  /** Grants one local file for this session; returns its target, or null when it isn't a readable file. */
  grantLocal(path: string): ViewerTarget | null {
    try {
      const real = isGranted(new Set([path]), path) ?? path
      if (!statSync(real).isFile()) return null
      this.#granted.add(real)
      return { kind: 'local', path: real }
    } catch {
      return null
    }
  }

  bytes(token: string): Uint8Array {
    const src = this.#source(token)
    if (src.text !== null && !src.path) return new Uint8Array(Buffer.from(src.text))
    if (!src.path) throw new Error(mainT('files.error.noContent'))
    if (statSync(src.path).size > VIEWER_BYTES_MAX) throw new Error(mainT('files.error.tooLarge'))
    return new Uint8Array(readFileSync(src.path))
  }

  /** What atelier-file://<token>/ serves: a real file, or text kept elsewhere. */
  served(token: string): { path: string | null; text: string | null; mediaType: string; name: string } | null {
    const src = this.#tokens.get(token)
    if (!src || (!src.path && src.text === null)) return null
    return { path: src.path, text: src.text, mediaType: src.mediaType, name: src.name }
  }

  /** The Library id to open as an artifact: the file itself, or a copy made now for files from elsewhere. */
  artifactIdFor(token: string): string {
    const src = this.#source(token)
    const previewable = previewableOf(src.name, src.mediaType, 1)
    if (!isArtifactable(previewable)) throw new Error(mainT('files.error.notArtifact'))
    if (src.libraryId) return src.libraryId
    const content = src.text ?? (src.path ? readFileSync(src.path, 'utf8') : '')
    return this.#deps.library.saveArtifact({ chatId: null, companionId: '', name: src.name, mediaType: src.mediaType, content }).file.id
  }

  async reload(token: string): Promise<ViewerDoc> {
    return this.#doc(token, await this.#refresh(token))
  }

  release(token: string): void {
    this.#tokens.release(token)
  }

  releaseOwner(owner: string): void {
    this.#tokens.releaseOwner(owner)
  }

  onDelete(fn: (deleted: ViewerDeletion) => void): () => void {
    this.#deleteListeners.add(fn)
    return () => this.#deleteListeners.delete(fn)
  }

  dispose(): void {
    this.#deleteListeners.clear()
  }
}

/** The target that names a file after it was renamed in place. */
function renamedTarget(target: ViewerTarget, name: string): ViewerTarget {
  const swap = (p: string): string => {
    const parts = p.split('/')
    parts[parts.length - 1] = name
    return parts.join('/')
  }
  if (target.kind === 'companion-file' || target.kind === 'memory') return { ...target, path: swap(target.path) }
  return target
}

/** A skill record from the older skills.json, read-only. */
function readSkillRecord(file: string, id: string): { name: string; description: string; instructions: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const list = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : []
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue
      const s = raw as Record<string, unknown>
      if (s.id === id && typeof s.name === 'string' && typeof s.instructions === 'string') return { name: s.name, description: typeof s.description === 'string' ? s.description : '', instructions: s.instructions }
    }
  } catch {
    // No skills file yet, or one Atelier can't read: the skill shows as missing.
  }
  return null
}
