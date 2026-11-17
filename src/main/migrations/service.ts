/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatView } from '@shared/chats'
import { CHAT_FORMAT_VERSION, type MigrationReport, type MigrationsEvent, type MigrationsServices } from '@shared/migrations'
import type { ChatStore } from '../chats'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { writeAtomic } from '../settings'
import { BACKUP_DIR, findBackup, keepReplaced, removeBackups } from './backup'
import { startPass, type Pass, type PassTally } from './background'
import { MigrationReportStore } from './report'
import { ChatMigrationError, type ChatFileStatus } from './runner'
import { newerFileOutcomes } from './versionedFile'

// The migrations service (SS-09): the
// report behind About › Data updates, the background pass after an upgrade,
// and the notice's actions (Try again, Restore original, Show file).

export interface MigrationsDeps {
  chats: ChatStore
  dataDir: string
  /** For the report; the feature passes app.getVersion(). */
  appVersion?: string
  /** A chat's view after a retry or restore (AgentHost.view). */
  view?: (chatId: string) => ChatView
  broadcast?: (event: MigrationsEvent) => void
  /** shell.showItemInFolder in the app. */
  reveal?: (path: string) => void
  /** Runs work later: the pass's start and its batches. */
  schedule?: (fn: () => void, ms: number) => void
  /** How long after start-up the background pass begins. */
  startDelayMs?: number
  now?: () => number
}

/** chats/format.json: the format the whole store was last brought up to. */
interface StoreFormat {
  version: number
  at: number
}

const START_DELAY_MS = 4000
const CHAT_ID = /^[0-9a-f-]{36}$/

function readFormat(path: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreFormat>
    return typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : null
  } catch {
    return null
  }
}

const defaultSchedule = (fn: () => void, ms: number): void => {
  setTimeout(fn, ms).unref?.()
}

/** The migrations runtime; setupMigrations wires it, tests drive it directly. */
export class Migrations {
  readonly report: MigrationReportStore
  readonly #deps: MigrationsDeps
  readonly #formatPath: string
  readonly #backupDir: string
  readonly #now: () => number
  #pass: Pass | null = null

  constructor(deps: MigrationsDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
    const chatsDir = join(deps.dataDir, 'chats')
    this.#formatPath = join(chatsDir, 'format.json')
    this.#backupDir = join(chatsDir, BACKUP_DIR)
    this.report = new MigrationReportStore(join(deps.dataDir, 'migrations.json'), deps.appVersion ?? '0.0.0', (report) => deps.broadcast?.({ type: 'migrations', report }))
    // Settings and companions read through readVersioned before this runs; a
    // file listed last time that reads fine now (Atelier was updated) leaves the list.
    const files = newerFileOutcomes()
    for (const listed of this.report.get().newer) if (!CHAT_ID.test(listed.id) && !files.some((f) => f.id === listed.id)) this.report.resolve(listed.id)
    for (const outcome of files) this.report.record(outcome)
    // The lazy path: every chat opened before (or without) the pass.
    deps.chats.on('migration', (outcome) => {
      if (this.report.record(outcome)) this.report.flush()
    })
    // A chat deleted for good takes its backups and report lines with it.
    deps.chats.on('removed', (ids) => {
      for (const id of ids) {
        removeBackups(this.#backupDir, id)
        this.report.resolve(id)
      }
      this.report.flush()
    })
    this.report.flush()
  }

  /**
   * Starts the background pass when chats/format.json is older than this
   * build (or missing while chats exist). Returns null when there is nothing
   * to do; a newer format.json (a downgrade) is left alone.
   */
  start(): Pass | null {
    const stored = readFormat(this.#formatPath)
    const ids = this.#deps.chats.list().map((c) => c.id)
    const from = stored ?? (ids.length > 0 || existsSync(this.#formatPath) ? 0 : CHAT_FORMAT_VERSION)
    if (from > CHAT_FORMAT_VERSION) {
      log.warn('migrations', `Chats were last updated by a newer ${BRAND_NAME} (format ${from}); they stay as they are.`)
      return null
    }
    if (from === CHAT_FORMAT_VERSION) {
      if (stored === null) this.#writeFormat()
      return null
    }
    log.info('migrations', `Updating ${ids.length} chats from format ${from} to ${CHAT_FORMAT_VERSION} in the background.`)
    this.report.startRun(from, this.#now())
    this.report.flush()
    const schedule = this.#deps.schedule ?? defaultSchedule
    let first = true
    const pass = startPass({
      ids: () => ids,
      upgrade: (id) => this.#upgrade(id),
      schedule: (fn, ms) => schedule(fn, first ? ((first = false), this.#deps.startDelayMs ?? START_DELAY_MS) : ms),
      onBatch: () => this.report.flush(),
    })
    this.#pass = pass
    void pass.done.then((tally) => this.#finish(tally))
    return pass
  }

  stop(): void {
    this.#pass?.cancel()
    this.#pass = null
  }

  services(): MigrationsServices {
    return {
      migrations: {
        report: () => this.report.get(),
        retry: (chatId) => this.retry(chatId),
        retryAll: () => this.retryAll(),
        restoreBackup: (chatId) => this.restoreBackup(chatId),
        revealFile: (chatId) => this.revealFile(chatId),
      },
    }
  }

  /** Runs the chat's migration again (after a repair) and returns its view: the chat, or the notice again. */
  retry(chatId: string): ChatView {
    this.#exists(chatId)
    this.#upgrade(chatId)
    this.report.flush()
    return this.#view(chatId)
  }

  retryAll(): MigrationReport {
    const ids = [...this.report.get().failed, ...this.report.get().newer].map((o) => o.id).filter((id) => CHAT_ID.test(id))
    for (const id of new Set(ids)) {
      if (this.#deps.chats.summary(id)) this.#upgrade(id)
      else this.report.resolve(id)
    }
    this.report.flush()
    return this.report.get()
  }

  /** Puts the newest readable original back (keeping the file it replaces) and opens the chat again. */
  restoreBackup(chatId: string): ChatView {
    this.#exists(chatId)
    const file = this.#deps.chats.fileOf(chatId)
    const status = this.#upgrade(chatId)
    // A chat that opens fine has no notice to answer, and its loaded session must not be pulled from under it.
    if (status === 'current' || status === 'migrated') throw new Error(mainT('migrations.notice.notNeeded'))
    const backup = findBackup(this.#backupDir, chatId)
    if (!backup) throw new Error(mainT('migrations.notice.noBackup'))
    const kept = keepReplaced(this.#backupDir, chatId, file, this.#now())
    writeAtomic(file, readFileSync(backup.path))
    log.info('migrations', `Restored a chat's original (format ${backup.version}).`, { chat: chatId, kept: kept ? 'yes' : 'no' })
    return this.retry(chatId)
  }

  revealFile(chatId: string): void {
    this.#exists(chatId)
    const file = this.#deps.chats.fileOf(chatId)
    const target = existsSync(file) ? file : (findBackup(this.#backupDir, chatId)?.path ?? this.#backupDir)
    this.#deps.reveal?.(target)
  }

  #exists(chatId: string): void {
    if (!this.#deps.chats.summary(chatId)) throw new Error('This chat no longer exists.')
  }

  /** Upgrades one chat; a chat that is fine now leaves the failure lists. The store reports the rest. */
  #upgrade(chatId: string): ChatFileStatus {
    try {
      const { status } = this.#deps.chats.upgradeFile(chatId)
      this.report.resolve(chatId)
      return status
    } catch (err) {
      if (err instanceof ChatMigrationError) return err.kind
      throw err
    }
  }

  #view(chatId: string): ChatView {
    if (!this.#deps.view) throw new Error('Not available yet')
    return this.#deps.view(chatId)
  }

  #finish(tally: PassTally): void {
    this.#pass = null
    const report = this.report.get()
    this.report.setSkipped(tally.total - report.migrated - tally.failed - tally.newer - tally.missing)
    this.report.flush()
    this.#writeFormat()
    log.info('migrations', 'The background chat update finished.', { migrated: tally.migrated, current: tally.current, failed: tally.failed, newer: tally.newer })
  }

  #writeFormat(): void {
    if ((readFormat(this.#formatPath) ?? -1) >= CHAT_FORMAT_VERSION) return
    try {
      writeAtomic(this.#formatPath, JSON.stringify({ version: CHAT_FORMAT_VERSION, at: this.#now() } satisfies StoreFormat))
    } catch (err) {
      log.error('migrations', "Couldn't save the chat format marker.", { code: (err as NodeJS.ErrnoException).code ?? null })
    }
  }
}

export function setupMigrations(deps: MigrationsDeps): { services: MigrationsServices; migrations: Migrations } {
  const migrations = new Migrations(deps)
  migrations.start()
  return { services: migrations.services(), migrations }
}
