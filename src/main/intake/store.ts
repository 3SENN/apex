/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ATTACHMENT_LIMITS, type AttachmentKind, type AttachmentRef, type AttachmentSource } from '@shared/attachments'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { writeAtomic } from '../settings'
import { IntakeError, fileRefusal, prepareFile, prepareText, type Prepared, type PrepareDeps } from './prepare'
import { sniff } from './detect'
import { CHAT_ATTACH_MAX_CHARS, PAGE_FETCH_MAX_BYTES, capText, cleanName, excerpt, selectionText } from './text'
import type { AttachmentStore, PreparedAttachment } from './types'

// The attachment store (CH-22 to CH-25). Each attachment is a folder
// under userData/attachments/<chatId>/<id>/ holding the original, what was
// prepared from it, thumb.webp and meta.json (all 0600). add() answers with a
// 'preparing' ref at once; the work runs off the main thread (the hidden
// renderer, the pdf worker) and every state change is emitted, so the
// composer's chips follow along. A draft's key is its chat id.

/** Where a source's content comes from, in main. Absent pieces fail with a plain reason. */
export interface SourceDeps {
  tab(tabId: string): { url: string; title: string; favicon: string | null; internal: boolean } | null
  /** The page's text through the page bridge; PDF tabs answer with their bytes instead. */
  readTab(tabId: string): Promise<{ text: string } | { pdf: Uint8Array }>
  /** A dragged image or link, fetched through that tab's session. */
  fetchFromTab(tabId: string, url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }>
  chatTitle(chatId: string): string | null
  chatMarkdown(chatId: string): { title: string; text: string } | null
  skill(skillId: string): { name: string; instructions: string } | null
  meeting(meetingId: string): Promise<{ title: string; text: string; ready: boolean } | null>
  record(connectorId: string, uri: string): Promise<{ title: string; text: string }>
}

export interface StoreDeps {
  /** userData/attachments */
  dir: string
  prepare: PrepareDeps
  sources: SourceDeps
  emit(chatId: string, items: AttachmentRef[]): void
  /** A tab became (or stopped being) an attachment: the pages-in-chat registry follows (CH-34). */
  onTab?(chatId: string, tab: { tabId: string; url: string; title: string; favicon: string | null }, attached: boolean): void
  now?: () => number
  /** How long a meeting waits between readiness checks when no change arrives (MV-14). */
  meetingPollMs?: number
}

/** The source as saved: bulky content lives in the folder, not in meta.json. */
type SavedSource =
  | { type: 'file'; name: string }
  | { type: 'paste' }
  | { type: 'inline'; label?: string }
  | { type: 'selection'; url: string; title: string }
  | Exclude<AttachmentSource, { type: 'file' } | { type: 'paste' } | { type: 'inline' } | { type: 'selection' }>

interface Meta {
  v: 1
  ref: AttachmentRef
  createdAt: number
  source: SavedSource
  /** The user message that sent it; null while it is a draft chip. */
  messageId: string | null
  /** prepared.jpg or prepared.png, with what the request carries. */
  prepared: { file: string; mediaType: string } | null
  hasText: boolean
  hasOriginal: boolean
  /** The title and address a text payload carries. */
  title: string
  sourceUrl: string | null
  /** ST-54: the image files were removed to free up space. */
  pruned?: boolean
}

interface Entry {
  meta: Meta
  /** Bumped by retry and remove, so a stale preparation never lands. */
  job: number
}

interface RemoteEntry {
  id: string
  fingerprint: string
  fileId: string
}

const ORIGINAL = 'original'
const TEXT = 'prepared.txt'
const THUMB = 'thumb.webp'
const META = 'meta.json'
const REMOTE = 'remote.json'
const CHAT_ID = /^[0-9a-f-]{36}$/
const ID = /^[0-9a-f-]{36}$/
/** Images and PDFs prepared at once; text sources don't wait for a slot. */
const CONCURRENCY = 3
/** Text kinds that readText and the chat files browser treat as text. */
const TEXT_KINDS: ReadonlySet<AttachmentKind> = new Set(['text', 'paste', 'selection', 'tab', 'chat', 'meeting', 'connector-record', 'skill'])
const EDITABLE: ReadonlySet<AttachmentKind> = new Set(['paste', 'text'])

class Cancelled extends Error {}

const reasonOf = (err: unknown): string => (err instanceof IntakeError ? err.message : mainT('intake.reason.prepareFailed'))

function writePrivate(path: string, data: string | Uint8Array): void {
  writeFileSync(path, data, { mode: 0o600 })
}

/** The file name of a URL, for a dragged page image. */
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
    return cleanName(last || u.hostname)
  } catch {
    return cleanName('')
  }
}

const looksLikePdfType = (contentType: string): boolean => /^application\/pdf\b/i.test(contentType)
const isReadableType = (contentType: string): boolean =>
  /^(image\/|text\/|application\/(pdf|json|xml|xhtml\+xml|ld\+json)\b)/i.test(contentType) || contentType === ''

export class Attachments implements AttachmentStore {
  readonly #deps: StoreDeps
  readonly #chats = new Map<string, Map<string, Entry>>()
  readonly #waiters = new Set<() => void>()
  readonly #settle = new Set<() => void>()
  #running = 0
  readonly #queue: (() => void)[] = []
  #disposed = false
  /** Bytes handed over by addPicked for the add() call it makes. */
  #pending: { bytes: Uint8Array; size: number } | null = null

  constructor(deps: StoreDeps) {
    this.#deps = deps
  }

  // ---- service methods ----

  add(chatId: string, source: AttachmentSource): AttachmentRef {
    const entries = this.#entries(chatId)
    const drafts = [...entries.values()].filter((e) => e.meta.messageId === null)
    if (drafts.length >= ATTACHMENT_LIMITS.perMessage) throw new Error(mainT('intake.error.tooMany', { count: ATTACHMENT_LIMITS.perMessage }))
    const id = randomUUID()
    const { meta, original } = this.#start(chatId, id, source)
    const folder = this.#folder(chatId, id)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    if (original !== null && meta.ref.state === 'preparing') {
      writePrivate(join(folder, ORIGINAL), original)
      meta.hasOriginal = true
    }
    const entry: Entry = { meta, job: 0 }
    entries.set(id, entry)
    this.#save(chatId, entry)
    this.#changed(chatId)
    // Refused up front (wrong kind, too big): nothing to prepare.
    if (meta.ref.state === 'preparing') void this.#prepare(chatId, entry)
    return { ...meta.ref }
  }

  /**
   * A file picked from disk: its bytes go straight in, never through base64.
   * A file too big to read passes only its head and real size, and is refused.
   */
  addPicked(chatId: string, name: string, bytes: Uint8Array, size = bytes.length): AttachmentRef {
    this.#pending = { bytes, size }
    try {
      return this.add(chatId, { type: 'file', name, base64: '' })
    } finally {
      this.#pending = null
    }
  }

  retry(chatId: string, id: string): AttachmentRef {
    const entry = this.#get(chatId, id)
    if (entry.meta.messageId !== null) throw new Error(mainT('intake.error.alreadySent'))
    entry.job++
    entry.meta.ref = { ...entry.meta.ref, state: 'preparing', error: null }
    entry.meta.pruned = undefined
    this.#save(chatId, entry)
    this.#changed(chatId)
    void this.#prepare(chatId, entry)
    return { ...entry.meta.ref }
  }

  remove(chatId: string, id: string): void {
    const entries = this.#entries(chatId)
    const entry = entries.get(id)
    if (!entry) return
    if (entry.meta.messageId !== null) throw new Error(mainT('intake.error.alreadySent'))
    entry.job++
    entries.delete(id)
    rmSync(this.#folder(chatId, id), { recursive: true, force: true })
    this.#tabChanged(chatId, entry, false)
    this.#changed(chatId)
  }

  list(chatId: string): AttachmentRef[] {
    return [...this.#entries(chatId).values()]
      .filter((e) => e.meta.messageId === null)
      .sort((a, b) => a.meta.createdAt - b.meta.createdAt)
      .map((e) => ({ ...e.meta.ref }))
  }

  updateText(chatId: string, id: string, text: string): AttachmentRef {
    const entry = this.#get(chatId, id)
    if (entry.meta.messageId !== null) throw new Error(mainT('intake.error.alreadySent'))
    if (!EDITABLE.has(entry.meta.ref.kind) || entry.meta.ref.state !== 'ready') throw new Error(mainT('intake.error.notText'))
    const prepared = prepareText(entry.meta.ref.kind, text, entry.meta.ref.mediaType)
    const folder = this.#folder(chatId, id)
    writePrivate(join(folder, ORIGINAL), prepared.text ?? '')
    entry.job++
    this.#finish(chatId, entry, prepared)
    return { ...entry.meta.ref }
  }

  readText(chatId: string, id: string): string {
    const entry = this.#get(chatId, id)
    if (!TEXT_KINDS.has(entry.meta.ref.kind) && entry.meta.ref.kind !== 'pdf') throw new Error(mainT('intake.error.notText'))
    return this.#text(chatId, id) ?? ''
  }

  // ---- main-only API ----

  resolve(chatId: string, ids: readonly string[]): PreparedAttachment[] {
    const entries = ids.map((id) => this.#get(chatId, id))
    if (entries.some((e) => e.meta.ref.state !== 'ready')) throw new Error(mainT('intake.error.notReady'))
    return entries.map((e) => ({ ref: { ...e.meta.ref }, payload: this.#payload(chatId, e) }))
  }

  bindToMessage(chatId: string, ids: readonly string[], userMessageId: string): void {
    let changed = false
    for (const id of ids) {
      const entry = this.#entries(chatId).get(id)
      if (!entry || entry.meta.messageId === userMessageId) continue
      entry.meta.messageId = userMessageId
      this.#save(chatId, entry)
      changed = true
    }
    if (changed) this.#changed(chatId)
  }

  copyForChat(fromChatId: string, toChatId: string, ids?: readonly string[]): { copied: number; failed: number } {
    const from = this.#entries(fromChatId)
    const picked = ids ? ids.map((id) => from.get(id) ?? id) : [...from.values()].filter((e) => e.meta.messageId !== null || e.meta.ref.state === 'ready')
    let copied = 0
    let failed = 0
    for (const item of picked) {
      if (typeof item === 'string' || item.meta.ref.state !== 'ready') {
        failed++
        continue
      }
      try {
        cpSync(this.#folder(fromChatId, item.meta.ref.id), this.#folder(toChatId, item.meta.ref.id), { recursive: true, force: true })
        // Uploads belong to the chat that made them; the copy uploads its own.
        copied++
      } catch (err) {
        log.warn('intake', 'An attachment could not be copied', { error: err instanceof Error ? err.message : String(err) })
        failed++
      }
    }
    this.#chats.delete(toChatId)
    if (copied > 0) this.#changed(toChatId)
    return { copied, failed }
  }

  removeChat(chatId: string): void {
    if (!CHAT_ID.test(chatId)) return
    for (const entry of this.#chats.get(chatId)?.values() ?? []) entry.job++
    this.#chats.delete(chatId)
    rmSync(join(this.#deps.dir, chatId), { recursive: true, force: true })
  }

  setRemoteFile(chatId: string, id: string, keyFingerprint: string, fileId: string): void {
    const list = this.#remote(chatId).filter((r) => !(r.id === id && r.fingerprint === keyFingerprint))
    list.push({ id, fingerprint: keyFingerprint, fileId })
    writeAtomic(join(this.#deps.dir, chatId, REMOTE), JSON.stringify(list))
  }

  remoteFiles(chatId: string): string[] {
    return this.#remote(chatId).map((r) => r.fileId)
  }

  remoteFile(chatId: string, id: string, keyFingerprint: string): string | null {
    return this.#remote(chatId).find((r) => r.id === id && r.fingerprint === keyFingerprint)?.fileId ?? null
  }

  file(chatId: string, id: string): { ref: AttachmentRef; originalPath: string | null; preparedPath: string | null } | null {
    const entry = this.#entries(chatId).get(id)
    if (!entry) return null
    const folder = this.#folder(chatId, id)
    const original = join(folder, ORIGINAL)
    return {
      ref: { ...entry.meta.ref },
      originalPath: entry.meta.hasOriginal && existsSync(original) ? original : null,
      preparedPath: entry.meta.prepared && !entry.meta.pruned ? join(folder, entry.meta.prepared.file) : null,
    }
  }

  async settled(chatId: string, ids: readonly string[]): Promise<AttachmentRef[]> {
    for (;;) {
      const entries = ids.map((id) => this.#get(chatId, id))
      if (this.#disposed || entries.every((e) => e.meta.ref.state !== 'preparing')) return entries.map((e) => ({ ...e.meta.ref }))
      await new Promise<void>((resolve) => this.#settle.add(resolve))
    }
  }

  sizes(): { chatAttachments: number } {
    return { chatAttachments: folderSize(this.#deps.dir) }
  }

  /** One chat's attachments on disk, and how much of that is images (ST-54's per-chat rows). */
  chatSize(chatId: string): { bytes: number; imageBytes: number } {
    if (!CHAT_ID.test(chatId)) return { bytes: 0, imageBytes: 0 }
    let imageBytes = 0
    for (const entry of this.#entries(chatId).values()) {
      if (entry.meta.ref.kind !== 'image' || entry.meta.pruned) continue
      const folder = this.#folder(chatId, entry.meta.ref.id)
      imageBytes += fileSize(join(folder, ORIGINAL)) + (entry.meta.prepared ? fileSize(join(folder, entry.meta.prepared.file)) : 0)
    }
    return { bytes: folderSize(join(this.#deps.dir, chatId)), imageBytes }
  }

  pruneImages(olderThanDays: number, chatIds?: readonly string[]): number {
    const cutoff = this.#now() - olderThanDays * 86_400_000
    let pruned = 0
    for (const chatId of chatIds ? chatIds.filter((id) => CHAT_ID.test(id)) : this.#chatIds()) {
      for (const entry of this.#entries(chatId).values()) {
        const { meta } = entry
        if (meta.ref.kind !== 'image' || meta.messageId === null || meta.pruned || meta.createdAt >= cutoff) continue
        const folder = this.#folder(chatId, meta.ref.id)
        rmSync(join(folder, ORIGINAL), { force: true })
        if (meta.prepared) rmSync(join(folder, meta.prepared.file), { force: true })
        meta.pruned = true
        meta.hasOriginal = false
        this.#save(chatId, entry)
        pruned++
      }
    }
    return pruned
  }

  // ---- for the chat files browser ----

  /** Every attachment the chat holds, sent or not, with its folder. */
  all(chatId: string): { ref: AttachmentRef; messageId: string | null; createdAt: number; folder: string; hasOriginal: boolean; source: SavedSource }[] {
    return [...this.#entries(chatId).values()]
      .sort((a, b) => a.meta.createdAt - b.meta.createdAt)
      .map((e) => ({ ref: { ...e.meta.ref }, messageId: e.meta.messageId, createdAt: e.meta.createdAt, folder: this.#folder(chatId, e.meta.ref.id), hasOriginal: e.meta.hasOriginal && !e.meta.pruned, source: e.meta.source }))
  }

  /** The prepared text of a text-like attachment (or a PDF's extracted text). */
  text(chatId: string, id: string): string | null {
    return this.#entries(chatId).has(id) ? this.#text(chatId, id) : null
  }

  /** The meetings changed: waiting meeting attachments check their transcript again. */
  meetingsChanged(): void {
    for (const wake of [...this.#waiters]) wake()
  }

  /** Startup tidy-up: drafts of chats that no longer exist, a day after they were made. */
  sweep(isChat: (chatId: string) => boolean): void {
    const dayAgo = this.#now() - 86_400_000
    for (const chatId of this.#chatIds()) {
      if (isChat(chatId)) continue
      try {
        if (statSync(join(this.#deps.dir, chatId)).mtimeMs < dayAgo) this.removeChat(chatId)
      } catch {
        // Gone already.
      }
    }
  }

  dispose(): void {
    this.#disposed = true
    this.meetingsChanged()
    for (const resolve of [...this.#settle]) resolve()
    this.#settle.clear()
  }

  // ---- internals ----

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #folder(chatId: string, id: string): string {
    return join(this.#deps.dir, chatId, id)
  }

  #chatIds(): string[] {
    try {
      return readdirSync(this.#deps.dir).filter((name) => CHAT_ID.test(name))
    } catch {
      return []
    }
  }

  #entries(chatId: string): Map<string, Entry> {
    const loaded = this.#chats.get(chatId)
    if (loaded) return loaded
    const entries = new Map<string, Entry>()
    this.#chats.set(chatId, entries)
    let names: string[] = []
    try {
      names = readdirSync(join(this.#deps.dir, chatId)).filter((n) => ID.test(n))
    } catch {
      return entries
    }
    for (const name of names) {
      try {
        const meta = JSON.parse(readFileSync(join(this.#folder(chatId, name), META), 'utf8')) as Meta
        if (meta.v !== 1 || meta.ref?.id !== name) continue
        const entry: Entry = { meta, job: 0 }
        entries.set(name, entry)
        // Apex quit while it was preparing: start again from what was saved.
        if (meta.ref.state === 'preparing') void this.#prepare(chatId, entry)
      } catch {
        // A folder without a readable meta.json is skipped, not fatal.
      }
    }
    return entries
  }

  #get(chatId: string, id: string): Entry {
    const entry = this.#entries(chatId).get(id)
    if (!entry) throw new Error(mainT('intake.error.gone'))
    return entry
  }

  #save(chatId: string, entry: Entry): void {
    const folder = this.#folder(chatId, entry.meta.ref.id)
    if (!existsSync(folder)) return
    writeAtomic(join(folder, META), JSON.stringify(entry.meta))
  }

  #changed(chatId: string): void {
    for (const resolve of [...this.#settle]) resolve()
    this.#settle.clear()
    this.#deps.emit(chatId, this.list(chatId))
  }

  #remote(chatId: string): RemoteEntry[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.#deps.dir, chatId, REMOTE), 'utf8'))
      return Array.isArray(raw) ? raw.filter((r): r is RemoteEntry => typeof r?.id === 'string' && typeof r?.fingerprint === 'string' && typeof r?.fileId === 'string') : []
    } catch {
      return []
    }
  }

  #text(chatId: string, id: string): string | null {
    try {
      return readFileSync(join(this.#folder(chatId, id), TEXT), 'utf8')
    } catch {
      return null
    }
  }

  /** The first meta and original for a new attachment, from what is known at once. */
  #start(chatId: string, id: string, source: AttachmentSource): { meta: Meta; original: Uint8Array | string | null } {
    const base = (kind: AttachmentKind, name: string, saved: SavedSource, extra: Partial<AttachmentRef> = {}): Meta => ({
      v: 1,
      ref: { id, kind, name: cleanName(name), state: 'preparing', error: null, size: 0, mediaType: 'text/plain', thumbnail: null, ...extra },
      createdAt: this.#now(),
      source: saved,
      messageId: null,
      prepared: null,
      hasText: false,
      hasOriginal: false,
      title: cleanName(name),
      sourceUrl: null,
    })
    switch (source.type) {
      case 'file': {
        const bytes = this.#pending?.bytes ?? Buffer.from(source.base64, 'base64')
        const size = this.#pending?.size ?? bytes.length
        // Only a picked file too big to read arrives as its head alone.
        const type = sniff(bytes, source.name, bytes.length < size)
        const kind: AttachmentKind = type.kind === 'heic' || type.kind === 'svg' ? 'image' : type.kind === 'image' || type.kind === 'pdf' || type.kind === 'office' || type.kind === 'text' ? type.kind : 'text'
        const meta = base(kind, source.name, { type: 'file', name: source.name }, { mediaType: 'mediaType' in type ? type.mediaType : 'application/octet-stream' })
        // CH-23: the wrong kind or an oversized file is refused at once, with its reason, and never saved.
        const refused = fileRefusal(type, size)
        if (refused) meta.ref = { ...meta.ref, state: 'failed', error: refused }
        return { meta, original: bytes }
      }
      case 'inline': {
        const label = source.attachment.label
        return { meta: base('image', label || mainT('intake.name.screenshot'), { type: 'inline', ...(label ? { label } : {}) }, { mediaType: source.attachment.mediaType }), original: Buffer.from(source.attachment.data, 'base64') }
      }
      case 'paste':
        return { meta: base('paste', mainT('intake.name.paste'), { type: 'paste' }), original: source.text }
      case 'selection': {
        const meta = base('selection', excerpt(source.text) || mainT('intake.name.selection', { title: source.title }), { type: 'selection', url: source.url, title: source.title }, { source: { url: source.url, title: source.title } })
        meta.title = mainT('intake.name.selection', { title: source.title || source.url })
        meta.sourceUrl = source.url
        return { meta, original: selectionText(source) }
      }
      case 'tab': {
        const tab = this.#deps.sources.tab(source.tabId)
        return { meta: base('tab', tab?.title || tab?.url || '', source, tab ? { source: { url: tab.url, title: tab.title, tabId: source.tabId } } : {}), original: null }
      }
      case 'page-url': {
        const tab = this.#deps.sources.tab(source.tabId)
        return { meta: base('image', nameFromUrl(source.url), source, { source: { url: source.url, title: tab?.title ?? '', tabId: source.tabId } }), original: null }
      }
      case 'chat': {
        const title = this.#deps.sources.chatTitle(source.chatId)
        return { meta: base('chat', mainT('intake.name.chat', { title: title ?? '' }), source, { sourceId: source.chatId, mediaType: 'text/markdown' }), original: null }
      }
      case 'skill': {
        const skill = this.#deps.sources.skill(source.skillId)
        return { meta: base('skill', skill ? `/${skill.name}` : '', source, { sourceId: source.skillId, mediaType: 'text/markdown' }), original: null }
      }
      case 'meeting':
        return { meta: base('meeting', '', source, { sourceId: source.meetingId }), original: null }
      case 'connector-record':
        return { meta: base('connector-record', source.title, source, { sourceId: source.uri }), original: null }
    }
  }

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= CONCURRENCY) await new Promise<void>((resolve) => this.#queue.push(resolve))
    this.#running++
    try {
      return await work()
    } finally {
      this.#running--
      this.#queue.shift()?.()
    }
  }

  /** Prepares an attachment from its saved source: the folder's original, or the tab, chat, skill, meeting or record it names. */
  async #prepare(chatId: string, entry: Entry): Promise<void> {
    const job = entry.job
    const id = entry.meta.ref.id
    const folder = this.#folder(chatId, id)
    const check = (): void => {
      if (entry.job !== job || this.#disposed) throw new Cancelled()
    }
    try {
      await Promise.resolve()
      const saved = entry.meta.source
      const original = (): Uint8Array => readFileSync(join(folder, ORIGINAL))
      const fileJob = (name: string, bytes: Uint8Array): Promise<Prepared> =>
        this.#slot(() => prepareFile({ chatId, name, bytes, originalPath: join(folder, ORIGINAL) }, this.#deps.prepare))
      let prepared: Prepared
      // Refused before it was saved: a retry gives the same answer.
      if ((saved.type === 'file' || saved.type === 'inline') && !entry.meta.hasOriginal) throw new IntakeError(entry.meta.ref.error ?? mainT('intake.reason.prepareFailed'))
      switch (saved.type) {
        case 'file':
          prepared = await fileJob(saved.name, original())
          break
        case 'inline':
          prepared = await fileJob(entry.meta.ref.name, original())
          break
        case 'paste':
          prepared = prepareText('paste', readFileSync(join(folder, ORIGINAL), 'utf8'))
          break
        case 'selection':
          prepared = prepareText('selection', readFileSync(join(folder, ORIGINAL), 'utf8'))
          break
        case 'tab':
          prepared = await this.#prepareTab(chatId, entry, saved.tabId, fileJob, check)
          break
        case 'page-url':
          prepared = await this.#preparePageUrl(chatId, entry, saved.url, saved.tabId, fileJob, check)
          break
        case 'chat': {
          if (saved.chatId === chatId) throw new IntakeError(mainT('intake.reason.chatSelf'))
          const chat = this.#deps.sources.chatMarkdown(saved.chatId)
          if (!chat) throw new IntakeError(mainT('intake.reason.chatMissing'))
          entry.meta.ref.name = cleanName(mainT('intake.name.chat', { title: chat.title }))
          entry.meta.title = entry.meta.ref.name
          prepared = prepareText('chat', capText(chat.text, CHAT_ATTACH_MAX_CHARS).text, 'text/markdown')
          break
        }
        case 'skill': {
          const skill = this.#deps.sources.skill(saved.skillId)
          if (!skill) throw new IntakeError(mainT('intake.reason.skillMissing'))
          entry.meta.ref.name = `/${skill.name}`
          entry.meta.title = skill.name
          // Kept as a reference: the request expands it as <skill> at send.
          prepared = prepareText('skill', skill.instructions, 'text/markdown')
          break
        }
        case 'meeting': {
          const meeting = await this.#readyMeeting(saved.meetingId, check, (title) => {
            // The waiting chip names the meeting while its transcript is finished.
            if (entry.meta.ref.name !== cleanName('') || !title) return
            entry.meta.ref.name = cleanName(title)
            this.#changed(chatId)
          })
          entry.meta.ref.name = cleanName(meeting.title)
          entry.meta.title = entry.meta.ref.name
          prepared = prepareText('meeting', meeting.text)
          break
        }
        case 'connector-record': {
          const record = await this.#deps.sources.record(saved.connectorId, saved.uri).catch(() => {
            throw new IntakeError(mainT('intake.reason.recordFailed'))
          })
          entry.meta.ref.name = cleanName(record.title || saved.title)
          entry.meta.title = entry.meta.ref.name
          prepared = prepareText('connector-record', record.text)
          break
        }
      }
      check()
      this.#finish(chatId, entry, prepared)
    } catch (err) {
      if (err instanceof Cancelled) return
      if (!(err instanceof IntakeError)) log.warn('intake', 'Preparing an attachment failed', { kind: entry.meta.ref.kind, error: err instanceof Error ? err.message : String(err) })
      if (entry.job !== job || !this.#entries(chatId).has(id)) return
      entry.meta.ref = { ...entry.meta.ref, state: 'failed', error: reasonOf(err) }
      this.#save(chatId, entry)
      this.#changed(chatId)
    }
  }

  async #prepareTab(chatId: string, entry: Entry, tabId: string, fileJob: (name: string, bytes: Uint8Array) => Promise<Prepared>, check: () => void): Promise<Prepared> {
    const tab = this.#deps.sources.tab(tabId)
    if (!tab) throw new IntakeError(mainT('intake.reason.tabGone'))
    if (tab.internal) throw new IntakeError(mainT('intake.reason.tabInternal'))
    entry.meta.ref = { ...entry.meta.ref, name: cleanName(tab.title || tab.url), source: { url: tab.url, title: tab.title, tabId } }
    entry.meta.title = entry.meta.ref.name
    entry.meta.sourceUrl = tab.url
    const content = await this.#deps.sources.readTab(tabId).catch(() => {
      throw new IntakeError(mainT('intake.reason.tabUnreadable'))
    })
    check()
    this.#tabChanged(chatId, entry, true, tab)
    if ('pdf' in content) {
      // A PDF tab: its text through the pdf module, kept as a tab attachment.
      const pdf = await fileJob(tab.title || 'document.pdf', content.pdf)
      if (pdf.kind !== 'pdf') throw new IntakeError(mainT('intake.reason.tabUnreadable'))
      return { ...prepareText('tab', pdf.text ?? ''), pages: pdf.pages, thumbnail: pdf.thumbnail }
    }
    return prepareText('tab', content.text)
  }

  async #preparePageUrl(chatId: string, entry: Entry, url: string, tabId: string, fileJob: (name: string, bytes: Uint8Array) => Promise<Prepared>, check: () => void): Promise<Prepared> {
    const got = await this.#deps.sources.fetchFromTab(tabId, url, PAGE_FETCH_MAX_BYTES).catch((err: unknown) => {
      throw err instanceof IntakeError ? err : new IntakeError(mainT('intake.reason.pageFetchFailed'))
    })
    check()
    if (!isReadableType(got.contentType)) throw new IntakeError(mainT('intake.reason.unsupported'))
    const folder = this.#folder(chatId, entry.meta.ref.id)
    writePrivate(join(folder, ORIGINAL), got.bytes)
    entry.meta.hasOriginal = true
    entry.meta.sourceUrl = url
    const name = looksLikePdfType(got.contentType) && !/\.pdf$/i.test(entry.meta.ref.name) ? `${entry.meta.ref.name}.pdf` : entry.meta.ref.name
    return fileJob(name, got.bytes)
  }

  /** MV-14: a meeting stays preparing until its transcript is final, checked on every change. */
  async #readyMeeting(meetingId: string, check: () => void, pending: (title: string) => void): Promise<{ title: string; text: string }> {
    let named = false
    for (;;) {
      const meeting = await this.#deps.sources.meeting(meetingId).catch(() => null)
      check()
      if (!meeting) throw new IntakeError(mainT('intake.reason.meetingMissing'))
      if (meeting.ready) return meeting
      if (!named) {
        named = true
        pending(meeting.title)
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer)
          this.#waiters.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, this.#deps.meetingPollMs ?? 5000)
        this.#waiters.add(wake)
      })
      check()
    }
  }

  #tabChanged(chatId: string, entry: Entry, attached: boolean, tab?: { url: string; title: string; favicon: string | null }): void {
    const { meta } = entry
    if (meta.source.type !== 'tab' || !this.#deps.onTab) return
    const tabId = meta.source.tabId
    // Another chip for the same tab keeps it attached.
    if (!attached && [...this.#entries(chatId).values()].some((e) => e !== entry && e.meta.source.type === 'tab' && e.meta.source.tabId === tabId)) return
    const info = tab ?? { url: meta.ref.source?.url ?? '', title: meta.ref.source?.title ?? '', favicon: null }
    this.#deps.onTab(chatId, { tabId, url: info.url, title: info.title, favicon: info.favicon }, attached)
  }

  /** Saves what preparation produced and marks the attachment ready (or failed over the request cap). */
  #finish(chatId: string, entry: Entry, prepared: Prepared): void {
    const id = entry.meta.ref.id
    const folder = this.#folder(chatId, id)
    if (!existsSync(folder)) return
    let preparedFile: Meta['prepared'] = null
    if (prepared.image) {
      const file = prepared.image.mediaType === 'image/png' ? 'prepared.png' : 'prepared.jpg'
      writePrivate(join(folder, file), prepared.image.bytes)
      preparedFile = { file, mediaType: prepared.image.mediaType }
    }
    if (prepared.text !== undefined) writePrivate(join(folder, TEXT), prepared.text)
    if (prepared.thumbnail) writePrivate(join(folder, THUMB), Buffer.from(prepared.thumbnail.replace(/^data:[^,]*,/, ''), 'base64'))
    const ref: AttachmentRef = {
      ...entry.meta.ref,
      kind: prepared.kind,
      state: 'ready',
      error: null,
      size: prepared.size,
      mediaType: prepared.mediaType,
      thumbnail: prepared.thumbnail,
      ...(prepared.lines !== undefined ? { lines: prepared.lines } : {}),
      ...(prepared.pages !== undefined ? { pages: prepared.pages } : {}),
    }
    entry.meta = { ...entry.meta, ref, prepared: preparedFile, hasText: prepared.text !== undefined }
    // The request cap counts every ready draft chip of the next message.
    if (entry.meta.messageId === null) {
      const others = [...this.#entries(chatId).values()].filter((e) => e !== entry && e.meta.messageId === null && e.meta.ref.state === 'ready')
      const total = others.reduce((sum, e) => sum + e.meta.ref.size, prepared.size)
      if (total > ATTACHMENT_LIMITS.requestBytes) entry.meta.ref = { ...entry.meta.ref, state: 'failed', error: mainT('intake.reason.requestTooLarge') }
    }
    this.#save(chatId, entry)
    this.#changed(chatId)
  }

  #payload(chatId: string, entry: Entry): PreparedAttachment['payload'] {
    const { meta } = entry
    const folder = this.#folder(chatId, meta.ref.id)
    switch (meta.ref.kind) {
      case 'image':
        if (meta.pruned || !meta.prepared) return { type: 'text', text: mainT('intake.text.pruned', { name: meta.ref.name }), title: meta.ref.name, sourceUrl: null }
        return { type: 'image', mediaType: meta.prepared.mediaType, path: join(folder, meta.prepared.file) }
      case 'pdf':
        return { type: 'pdf', path: join(folder, ORIGINAL), pages: meta.ref.pages ?? 0, text: this.#text(chatId, meta.ref.id) ?? '' }
      case 'office':
        return { type: 'office', path: join(folder, ORIGINAL), mediaType: meta.ref.mediaType }
      case 'skill':
        return { type: 'skill', skillId: meta.source.type === 'skill' ? meta.source.skillId : (meta.ref.sourceId ?? '') }
      default:
        return { type: 'text', text: this.#text(chatId, meta.ref.id) ?? '', title: meta.title || meta.ref.name, sourceUrl: meta.sourceUrl ?? meta.ref.source?.url ?? null }
    }
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function folderSize(dir: string): number {
  let total = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      total += stat.isDirectory() ? folderSize(path) : stat.size
    } catch {
      // Removed while measuring.
    }
  }
  return total
}
