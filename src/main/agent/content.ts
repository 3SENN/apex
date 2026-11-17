/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { toFile } from '@anthropic-ai/sdk'
import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessageParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ATTACHMENT_LIMITS } from '@shared/attachments'
import type { PreparedAttachment } from '../intake/types'
import { log } from '../log'
import { writeAtomic } from '../settings'

// The request half: a message's prepared attachments become content
// blocks placed before the typed text. On the API key, images and PDFs go to
// the Files API once (cached per attachment and key fingerprint) and are sent
// by file_id, with base64 when the upload fails; text-like kinds become
// titled text documents. An engine that runs the model elsewhere makes its
// own blocks from the same prepared attachments (AgentBackend.attachmentBlocks).
// Files sent to Anthropic are deleted with their chat.

export const OFFICE_NEEDS_DOCUMENTS = 'This chat started without Files and documents, so it can’t read office files. Turn it on in Settings › Model and key, then start a new chat.'
export const REQUEST_TOO_LARGE = 'This message and its attachments come to more than 32 MB, the most one request can carry. Remove some attachments, or start a new chat for them.'

/** The part of the SDK's Files API Apex uses (stable `client.files`, no beta header). */
export interface FilesApi {
  upload(params: { file: Awaited<ReturnType<typeof toFile>> }): PromiseLike<{ id: string }>
  download(fileId: string): PromiseLike<{ arrayBuffer(): Promise<ArrayBuffer> }>
  delete(fileId: string): PromiseLike<unknown>
  retrieveMetadata(fileId: string): PromiseLike<{ filename: string; mime_type: string; size_bytes: number }>
}

/** A short, non-reversible tag for the API key, so a key change uploads again (files belong to a key's organization). */
export function keyFingerprint(apiKey: string | null): string | null {
  return apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : null
}

type CacheFile = Record<string, Record<string, Record<string, string>>>

/**
 * Files API ids by chat, attachment and key fingerprint, in
 * userData/agent/remote-files.json. A duplicated chat lists the same ids
 * under its own id, so deleting one chat keeps files the other still sends.
 */
export class RemoteFileCache {
  readonly #path: string
  #data: CacheFile

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'agent', 'remote-files.json')
    this.#data = {}
    try {
      if (existsSync(this.#path)) {
        const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as unknown
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.#data = raw as CacheFile
      }
    } catch {
      this.#data = {}
    }
  }

  get(chatId: string, attachmentId: string, fingerprint: string): string | null {
    return this.#data[chatId]?.[attachmentId]?.[fingerprint] ?? null
  }

  set(chatId: string, attachmentId: string, fingerprint: string, fileId: string): void {
    const chat = (this.#data[chatId] ??= {})
    chat[attachmentId] = { ...chat[attachmentId], [fingerprint]: fileId }
    this.#write()
  }

  /** Every remote id the chat refers to (its uploads and generated files). */
  forChat(chatId: string): string[] {
    return [...new Set(Object.values(this.#data[chatId] ?? {}).flatMap((byKey) => Object.values(byKey)))]
  }

  /** CH-47: the copy refers to the same remote files. */
  copyChat(fromChatId: string, toChatId: string): void {
    const from = this.#data[fromChatId]
    if (!from) return
    this.#data[toChatId] = structuredClone(from)
    this.#write()
  }

  /** Forgets a chat; returns the ids no other chat still refers to, which can be deleted remotely. */
  removeChat(chatId: string, extra: readonly string[] = []): string[] {
    const ids = new Set([...this.forChat(chatId), ...extra])
    delete this.#data[chatId]
    for (const other of Object.keys(this.#data)) for (const id of this.forChat(other)) ids.delete(id)
    this.#write()
    return [...ids]
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      writeAtomic(this.#path, JSON.stringify(this.#data))
    } catch (err) {
      log.warn('agent', 'Could not save the remote file list', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export interface ApiBlockContext {
  chatId: string
  /** The chat's documents ability (fixed at its first message). */
  documents: boolean
  /** The Files API, or null without a key (everything goes as base64). */
  files: FilesApi | null
  fingerprint: string | null
  cache: RemoteFileCache
  /** Tells the attachment store about an upload, so it lists the file with the chat. */
  onRemote?(attachmentId: string, fileId: string): void
  skill(skillId: string): { name: string; instructions: string } | null
  readFile?(path: string): Buffer
}

/** A prepared attachment's bytes (tests pass readFile). */
export const readAttachment = (ctx: { readFile?(path: string): Buffer }, path: string): Buffer => (ctx.readFile ? ctx.readFile(path) : readFileSync(path))

/** The text a skill attachment expands to, like a typed /name. */
export function skillText(skill: { name: string; instructions: string } | null, fallbackName: string): string {
  if (!skill) return `(The skill “${fallbackName}” attached here no longer exists.)`
  return `<skill name="${skill.name}">\n${skill.instructions}\n</skill>`
}

/** What a text document's `context` says about where it came from. */
function sourceNote(prepared: PreparedAttachment): string | null {
  const url = prepared.payload.type === 'text' ? prepared.payload.sourceUrl : null
  const source = prepared.ref.source
  if (prepared.ref.kind === 'selection' && (url ?? source?.url)) return `A passage the user selected and quoted from “${source?.title ?? prepared.ref.name}” (${url ?? source?.url}).`
  if (url) return `Source: ${url}`
  return null
}

async function uploadOnce(prepared: PreparedAttachment, path: string, mediaType: string, ctx: ApiBlockContext): Promise<string | null> {
  if (!ctx.files || !ctx.fingerprint) return null
  const cached = ctx.cache.get(ctx.chatId, prepared.ref.id, ctx.fingerprint)
  if (cached) return cached
  try {
    const file = await toFile(readAttachment(ctx, path), prepared.ref.name || 'attachment', { type: mediaType })
    const uploaded = await ctx.files.upload({ file })
    ctx.cache.set(ctx.chatId, prepared.ref.id, ctx.fingerprint, uploaded.id)
    ctx.onRemote?.(prepared.ref.id, uploaded.id)
    return uploaded.id
  } catch (err) {
    log.warn('agent', 'Files API upload failed; sending the attachment inline', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** One attachment as API-key content blocks. Throws for office files in a chat without documents. */
export async function apiBlocksFor(prepared: PreparedAttachment, ctx: ApiBlockContext): Promise<BetaContentBlockParam[]> {
  const { payload, ref } = prepared
  switch (payload.type) {
    case 'image': {
      const fileId = await uploadOnce(prepared, payload.path, payload.mediaType, ctx)
      const image: BetaImageBlockParam = fileId
        ? { type: 'image', source: { type: 'file', file_id: fileId } }
        : { type: 'image', source: { type: 'base64', media_type: imageMediaType(payload.mediaType), data: readAttachment(ctx, payload.path).toString('base64') } }
      // With documents on, code can use the image too (a logo for slides).
      return fileId && ctx.documents ? [image, { type: 'container_upload', file_id: fileId }] : [image]
    }
    case 'pdf': {
      const fileId = await uploadOnce(prepared, payload.path, 'application/pdf', ctx)
      const title = ref.name || 'Document.pdf'
      const doc: BetaContentBlockParam = fileId
        ? { type: 'document', source: { type: 'file', file_id: fileId }, title }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: readAttachment(ctx, payload.path).toString('base64') }, title }
      return fileId && ctx.documents ? [doc, { type: 'container_upload', file_id: fileId }] : [doc]
    }
    case 'text': {
      const context = sourceNote(prepared)
      return [{
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: payload.text || '(empty)' },
        title: payload.title || ref.name || 'Text',
        ...(context ? { context } : {}),
      }]
    }
    case 'office': {
      if (!ctx.documents) throw new Error(OFFICE_NEEDS_DOCUMENTS)
      const fileId = await uploadOnce(prepared, payload.path, payload.mediaType, ctx)
      if (!fileId) throw new Error(`${BRAND_NAME} couldn’t send ${ref.name || 'the office file'} to the code workspace. Check your connection and try again.`)
      return [{ type: 'container_upload', file_id: fileId }, { type: 'text', text: `The user attached ${ref.name || 'a file'}; it is in the code workspace.` }]
    }
    case 'skill':
      return [{ type: 'text', text: skillText(ctx.skill(payload.skillId), ref.name) }]
  }
}

/** Every attachment of a message, in the order they were attached. */
export async function apiBlocks(prepared: readonly PreparedAttachment[], ctx: ApiBlockContext): Promise<BetaContentBlockParam[]> {
  const out: BetaContentBlockParam[] = []
  for (const item of prepared) out.push(...(await apiBlocksFor(item, ctx)))
  return out
}

function imageMediaType(mediaType: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  return mediaType === 'image/png' || mediaType === 'image/gif' || mediaType === 'image/webp' ? mediaType : 'image/jpeg'
}

/** The request's size as sent; the API refuses more than ATTACHMENT_LIMITS.requestBytes. */
export function requestBytes(messages: readonly BetaMessageParam[], extra: readonly BetaContentBlockParam[] = []): number {
  return Buffer.byteLength(JSON.stringify(messages)) + Buffer.byteLength(JSON.stringify(extra))
}

/** Throws the readable 32 MB error before anything is sent. */
export function assertRequestSize(messages: readonly BetaMessageParam[], extra: readonly BetaContentBlockParam[] = []): void {
  if (requestBytes(messages, extra) > ATTACHMENT_LIMITS.requestBytes) throw new Error(REQUEST_TOO_LARGE)
}

/**
 * The attachment blocks of a sent user message, to keep them on edit and
 * retry: everything but the browser context and the typed text (the last
 * text block), so blocks from any kind of attachment come along unchanged.
 */
export function attachmentBlocksOf(message: BetaMessageParam | undefined): BetaContentBlockParam[] {
  if (!message || message.role !== 'user' || typeof message.content === 'string') return []
  const blocks = message.content.filter((block) => block.type !== 'tool_result' && !(block.type === 'text' && block.text.startsWith('<browser_context>')))
  let typed = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === 'text') {
      typed = i
      break
    }
  }
  return blocks.filter((_, i) => i !== typed)
}

/** Deletes remote files, best effort (a file that is already gone is fine). */
export async function deleteRemoteFiles(files: FilesApi | null, ids: readonly string[]): Promise<number> {
  if (!files) return 0
  let deleted = 0
  for (const id of ids) {
    try {
      await files.delete(id)
      deleted++
    } catch (err) {
      log.debug('agent', 'Could not delete a remote file', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return deleted
}
