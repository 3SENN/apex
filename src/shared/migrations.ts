/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Versioned chat-store migrations and repair notices (SS-09). Each chat
// file format version below has its own upgrade step.
import type { ChatView } from './chats'

/**
 * The chat file format this build writes (`formatVersion` in each chat file).
 * One version per group of format changes, each with a step in
 * main/migrations/chatSteps.ts:
 * - v0: no `formatVersion` (every chat saved before versioning);
 * - v1: the original shape normalized: capabilities (effort, memoryScope, engine
 *   'api-key'), log events validated, details and feedback objects;
 * - v2: summary flags (actWithoutAsking, muted) and tool event fields;
 * - v3: inline `user-message.attachments` (AttachmentView);
 * - v4: AttachmentRef, documents, compaction, container and local tools;
 * - v5: private chats, delegation, project, import and routine-run fields,
 *   client tools and remembered grants.
 */
export const CHAT_FORMAT_VERSION: number = 5

export interface MigrationOutcome {
  /** The chat id (or a file name for other versioned files). */
  id: string
  title: string
  from: number
  to: number
  ok: boolean
  error?: string
  at: number
}

/** `userData/migrations.json`, shown in About › Data updates and included in problem reports. */
export interface MigrationReport {
  lastRunAt: number | null
  appVersion: string
  from: number | null
  to: number
  migrated: number
  skipped: number
  failed: MigrationOutcome[]
  /** Files saved by a newer Atelier: kept as they are, opened read-only. */
  newer: MigrationOutcome[]
}

export type ChatNoticeKind = 'migration-failed' | 'newer-format'

/** Shown above a chat whose file could not be brought up to date; the composer is disabled while it shows. */
export interface ChatNotice {
  kind: ChatNoticeKind
  message: string
  /** chats/.backup holds an original this build can restore (Restore original). */
  backup?: boolean
}

export function emptyMigrationReport(appVersion: string): MigrationReport {
  return { lastRunAt: null, appVersion, from: null, to: CHAT_FORMAT_VERSION, migrated: 0, skipped: 0, failed: [], newer: [] }
}

export interface MigrationsServices {
  migrations: {
    report(): MigrationReport
    /** Runs the chat's migration again (after a repair) and returns its view. */
    retry(chatId: string): ChatView
    retryAll(): MigrationReport
    /** Puts the original file from `chats/.backup/` back and opens it again. */
    restoreBackup(chatId: string): ChatView
    revealFile(chatId: string): void
  }
}

export type MigrationsEvent = { type: 'migrations'; report: MigrationReport }
