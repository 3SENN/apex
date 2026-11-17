/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { readFileSync } from 'node:fs'
import { CHAT_FORMAT_VERSION, type MigrationOutcome } from '@shared/migrations'
import type { ChatCapabilities, ChatContent, EngineSession } from '../chats'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { writeAtomic } from '../settings'
import { findBackup, writeBackupOnce } from './backup'
import { applySteps, type RawChat } from './chatSteps'
import { chatSchema, schemaProblem } from './chatSchema'

// The chat migration runner (SS-09). ChatStore.load() and the background
// pass call upgradeChatFile: it reads a chat file, detects its version and
// brings it up to CHAT_FORMAT_VERSION through chatSteps, validates it with
// chatSchema, backs the original up once and writes the result. A file
// newer than this build is never written; a damaged one is never written
// either. Both come back as a ChatMigrationError, which the chat view turns
// into a notice.

export interface ChatMigrationErrorOptions {
  /** What a newer file still shows, read-only; null when nothing could be read. */
  readOnly?: ChatContent | null
  /** chats/.backup holds an original this build can restore. */
  backup?: boolean
  /** The technical reason, for the log and the report (never shown as the notice). */
  detail?: string
}

export class ChatMigrationError extends Error {
  readonly readOnly: ChatContent | null
  readonly backup: boolean
  readonly detail: string

  constructor(
    readonly kind: 'failed' | 'newer',
    readonly from: number,
    message: string,
    options: ChatMigrationErrorOptions = {},
  ) {
    super(message)
    this.name = 'ChatMigrationError'
    this.readOnly = options.readOnly ?? null
    this.backup = options.backup ?? false
    this.detail = options.detail ?? message
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The file's format version: 0 without `formatVersion`, null when the field is there but unreadable. */
export function detectVersion(raw: RawChat): number | null {
  if (!('formatVersion' in raw)) return 0
  const v = raw.formatVersion
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

const failed = (from: number, detail: string, key: 'migrations.notice.damaged' | 'migrations.notice.failed' | 'migrations.notice.unknownFormat' = 'migrations.notice.failed'): ChatMigrationError =>
  new ChatMigrationError('failed', from, mainT(key), { detail })

/**
 * Brings a raw chat record to the current format and validates it. Files
 * at the current version run the same (idempotent) steps, so a hand-edited
 * or half-written current file is repaired in memory or reported as damaged
 * rather than breaking the chat surfaces. Throws ChatMigrationError.
 */
export function upgradeRecord(raw: unknown, id: string): { record: RawChat; from: number } {
  if (!isObject(raw)) throw failed(0, 'not a JSON object', 'migrations.notice.damaged')
  const from = detectVersion(raw)
  if (from === null) throw failed(0, `unreadable formatVersion ${JSON.stringify(raw.formatVersion).slice(0, 40)}`, 'migrations.notice.unknownFormat')
  if (from > CHAT_FORMAT_VERSION) {
    throw new ChatMigrationError('newer', from, mainT('migrations.notice.newer'), { readOnly: readOnlyContent(raw, id), detail: `saved as format ${from}; this build reads up to ${CHAT_FORMAT_VERSION}` })
  }
  let record: RawChat
  try {
    // Every step so far is a normalizer, so a current file runs the whole chain too.
    record = applySteps({ ...raw, id }, 0)
  } catch (err) {
    throw failed(from, `step failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = chatSchema.safeParse(record)
  if (!parsed.success) throw failed(from, schemaProblem(parsed.error))
  return { record, from }
}

/** The pure hook (contract): a raw chat file to current content, or ChatMigrationError. */
export function migrateChatFile(raw: unknown, id: string): { content: ChatContent; migratedFrom: number | null } {
  const { record, from } = upgradeRecord(raw, id)
  return { content: contentOf(record, id), migratedFrom: from < CHAT_FORMAT_VERSION ? from : null }
}

/** The content fields of a validated record. */
export function contentOf(record: RawChat, id: string): ChatContent {
  const session = record.engineSession
  return {
    id,
    capabilities: record.capabilities as ChatCapabilities,
    system: record.system as string,
    messages: record.messages as ChatContent['messages'],
    log: record.log as ChatContent['log'],
    details: record.details as ChatContent['details'],
    feedback: record.feedback as ChatContent['feedback'],
    engineSession: isObject(session) && typeof session.id === 'string' ? (session as unknown as EngineSession) : null,
    grants: record.grants as ChatContent['grants'],
  }
}

/** A newer file's chat as best this build can show it, read-only; null when its shape is beyond reading. */
export function readOnlyContent(raw: RawChat, id: string): ChatContent | null {
  try {
    const record = applySteps({ ...raw, id, formatVersion: 0 }, 0)
    const parsed = chatSchema.safeParse(record)
    return parsed.success ? contentOf(record, id) : null
  } catch {
    return null
  }
}

export type ChatFileStatus = 'missing' | 'current' | 'migrated' | 'failed' | 'newer'

export interface ChatFileResult {
  status: ChatFileStatus
  /** The record at the current format ('current' and 'migrated'). */
  record: RawChat | null
  /** Set when something changed or went wrong ('migrated', 'failed', 'newer'). */
  outcome: MigrationOutcome | null
  error: ChatMigrationError | null
}

export interface ChatFileRef {
  id: string
  /** chats/<id>.json */
  file: string
  /** chats/.backup */
  backupDir: string
  /** For the report. */
  title: string
}

/**
 * The load path's upgrade: reads the file, migrates an older one (backup
 * first, then validate, then an atomic write) and reports what happened.
 * Never throws; ChatStore throws `error` after recording the outcome.
 */
export function upgradeChatFile(ref: ChatFileRef, now = Date.now()): ChatFileResult {
  let text: string
  try {
    text = readFileSync(ref.file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', record: null, outcome: null, error: null }
    return failure(ref, failed(0, `unreadable: ${(err as NodeJS.ErrnoException).code ?? 'error'}`, 'migrations.notice.damaged'), now)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return failure(ref, failed(0, 'not valid JSON', 'migrations.notice.damaged'), now)
  }
  let upgraded: { record: RawChat; from: number }
  try {
    upgraded = upgradeRecord(raw, ref.id)
  } catch (err) {
    return failure(ref, err instanceof ChatMigrationError ? err : failed(0, String(err)), now)
  }
  const { record, from } = upgraded
  if (from === CHAT_FORMAT_VERSION) return { status: 'current', record, outcome: null, error: null }
  try {
    // The original first, exactly as the older Atelier wrote it; only then the new file.
    writeBackupOnce(ref.backupDir, ref.id, from, text)
    writeAtomic(ref.file, JSON.stringify(record))
  } catch (err) {
    return failure(ref, failed(from, `write failed: ${(err as NodeJS.ErrnoException).code ?? String(err)}`), now)
  }
  log.info('migrations', `Updated a chat from format ${from} to ${CHAT_FORMAT_VERSION}.`, { chat: ref.id })
  return { status: 'migrated', record, outcome: { id: ref.id, title: ref.title, from, to: CHAT_FORMAT_VERSION, ok: true, at: now }, error: null }
}

function failure(ref: ChatFileRef, error: ChatMigrationError, now: number): ChatFileResult {
  const backup = findBackup(ref.backupDir, ref.id) !== null
  const withBackup = new ChatMigrationError(error.kind, error.from, error.message, { readOnly: error.readOnly, backup, detail: error.detail })
  if (error.kind === 'newer') log.warn('migrations', `A chat was saved by a newer ${BRAND_NAME}; it opens read-only.`, { chat: ref.id, from: error.from })
  else log.warn('migrations', `A chat couldn't be brought up to date: ${error.detail}`, { chat: ref.id, from: error.from })
  return {
    status: error.kind,
    record: null,
    outcome: { id: ref.id, title: ref.title, from: error.from, to: CHAT_FORMAT_VERSION, ok: false, error: error.detail, at: now },
    error: withBackup,
  }
}
