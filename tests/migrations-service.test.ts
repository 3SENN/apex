/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS, type ChatSummary, type ChatView } from '@shared/chats'
import { t } from '@shared/i18n/core'
import { CHAT_FORMAT_VERSION, type MigrationReport, type MigrationsEvent } from '@shared/migrations'
import { ChatStore, type ChatContent } from '../src/main/chats'
import { startPass } from '../src/main/migrations/background'
import { BACKUP_DIR, backupPath } from '../src/main/migrations/backup'
import { noticeView } from '../src/main/migrations/notice'
import { MigrationReportStore, readReport } from '../src/main/migrations/report'
import { ChatMigrationError } from '../src/main/migrations/runner'
import { Migrations, setupMigrations } from '../src/main/migrations/service'
import { readVersioned, resetNewerFiles } from '../src/main/migrations/versionedFile'
import type { EngineId } from '@shared/engine'

// The migrations service: the report, the background pass in batches, Try again,
// Restore original and Show file, and the read-only notice view.

const FIXTURES = join(__dirname, 'fixtures', 'chats')
const fixtureText = (...path: string[]): string => readFileSync(join(FIXTURES, ...path), 'utf8')
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const summary = (id: string, title = 'Chat'): ChatSummary => ({
  id, title, createdAt: 1, updatedAt: 1, lastActiveAt: 1, routineId: null, companionId: 'companion-1', model: 'claude-opus-5-5',
  status: 'finished', unread: false, pinned: false, archived: false, needsInput: false, draft: false, ...CHAT_SUMMARY_FLAG_DEFAULTS, ...CHAT_SUMMARY_LINK_DEFAULTS,
})

const content = (id: string): ChatContent => ({
  id,
  capabilities: { model: 'claude-opus-5-5', browser: true, webTools: true, memory: true, connectorIds: [] },
  system: 's',
  messages: [{ role: 'user', content: 'hi' }],
  log: [{ type: 'user-message', id: 'aaaaaaaa-0000-4000-8000-000000000001', text: 'hi' }],
  details: {},
  feedback: {},
})

/** A v0 file (what every build before chat migrations wrote) for chat `id`. */
const v0 = (id: string, title = 'Chat'): string => fixtureText('v0', 'chat.json').replace('0a0a0a0a-1111-4222-8333-444444444444', id).replace('Old trip', title)

interface Harness {
  dir: string
  chats: ChatStore
  queue: Array<() => void>
  events: MigrationsEvent[]
  revealed: string[]
  make(): Migrations
  /** Runs scheduled work until none is left. */
  drain(): void
}

/** A store with `n` saved chats whose files are then put back to v0. */
function harness(n: number, dir = mkdtempSync(join(tmpdir(), 'atelier-migrations-svc-'))): Harness {
  const chats = new ChatStore(dir, 'companion-1')
  for (let i = 1; i <= n; i++) {
    chats.save(content(ID(i)), { created: summary(ID(i), `Chat ${i}`) })
    writeFileSync(chats.fileOf(ID(i)), v0(ID(i), `Chat ${i}`))
  }
  const h: Harness = {
    dir,
    chats,
    queue: [],
    events: [],
    revealed: [],
    make: () =>
      new Migrations({
        chats,
        dataDir: dir,
        appVersion: '1.2.3',
        schedule: (fn) => h.queue.push(fn),
        broadcast: (e) => h.events.push(e),
        reveal: (p) => h.revealed.push(p),
        view: (id): ChatView => {
          try {
            chats.load(id)
            return { notice: null } as ChatView
          } catch (err) {
            if (err instanceof ChatMigrationError) return noticeView({ summary: chats.summary(id)!, error: err, seq: 0, effort: 'high' })
            throw err
          }
        },
        now: () => 1_800_000_000_000,
      }),
    drain: () => {
      while (h.queue.length > 0) h.queue.shift()?.()
    },
  }
  return h
}

const formatOf = (dir: string): number | null => {
  const path = join(dir, 'chats', 'format.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { version: number }).version : null
}

afterEach(() => resetNewerFiles())

describe('the background pass', () => {
  it('migrates every chat in batches of 20 and marks the store current', async () => {
    const h = harness(45)
    const m = h.make()
    const pass = m.start()
    expect(pass).not.toBeNull()
    let batches = 0
    while (h.queue.length > 0) {
      h.queue.shift()?.()
      batches++
    }
    const tally = await pass!.done
    expect(batches).toBe(3)
    expect(tally).toMatchObject({ total: 45, migrated: 45, failed: 0 })
    expect(m.report.get()).toMatchObject({ from: 0, to: CHAT_FORMAT_VERSION, migrated: 45, skipped: 0, failed: [], appVersion: '1.2.3' })
    expect(m.report.get().lastRunAt).toBeGreaterThan(0)
    expect(formatOf(h.dir)).toBe(CHAT_FORMAT_VERSION)
    expect(readdirSync(join(h.dir, 'chats', BACKUP_DIR))).toHaveLength(45)
    // The report is saved and broadcast.
    expect(readReport(join(h.dir, 'migrations.json'), 'x').migrated).toBe(45)
    expect(h.events.at(-1)?.report.migrated).toBe(45)
    // Nothing to do on the next start.
    expect(h.make().start()).toBeNull()
  })

  it('resumes after being cut short, without losing the count', async () => {
    const h = harness(30)
    const m = h.make()
    m.start()
    h.queue.shift()?.() // the first batch of 20
    m.stop()
    h.queue.length = 0
    expect(formatOf(h.dir)).toBeNull()
    const again = h.make()
    const pass = again.start()
    h.drain()
    await pass!.done
    expect(again.report.get()).toMatchObject({ migrated: 30, skipped: 0 })
    expect(formatOf(h.dir)).toBe(CHAT_FORMAT_VERSION)
  })

  it('counts current chats as skipped and lists failures and newer files', async () => {
    const h = harness(4)
    h.chats.save(content(ID(2)), {}) // current again
    writeFileSync(h.chats.fileOf(ID(3)), fixtureText('corrupt', 'truncated.json'))
    writeFileSync(h.chats.fileOf(ID(4)), fixtureText('newer', 'v9.json'))
    const newerText = readFileSync(h.chats.fileOf(ID(4)), 'utf8')
    const m = h.make()
    const pass = m.start()
    h.drain()
    expect(await pass!.done).toMatchObject({ migrated: 1, current: 1, failed: 1, newer: 1 })
    const report = m.report.get()
    expect(report).toMatchObject({ migrated: 1, skipped: 1 })
    expect(report.failed.map((o) => [o.id, o.title, o.error])).toEqual([[ID(3), 'Chat 3', 'not valid JSON']])
    expect(report.newer.map((o) => [o.id, o.from])).toEqual([[ID(4), 9]])
    expect(readFileSync(h.chats.fileOf(ID(4)), 'utf8')).toBe(newerText)
  })

  it('leaves a store from a newer Atelier as it is, and marks a new store current', () => {
    const h = harness(0)
    expect(h.make().start()).toBeNull()
    expect(formatOf(h.dir)).toBe(CHAT_FORMAT_VERSION)
    writeFileSync(join(h.dir, 'chats', 'format.json'), JSON.stringify({ version: CHAT_FORMAT_VERSION + 3, at: 1 }))
    expect(h.make().start()).toBeNull()
    expect(formatOf(h.dir)).toBe(CHAT_FORMAT_VERSION + 3)
  })

  it('runs batches through the schedule, with a gap between them', () => {
    const delays: number[] = []
    const queue: Array<() => void> = []
    const seen: string[] = []
    startPass({ ids: () => ['a', 'b', 'c'], upgrade: (id) => (seen.push(id), 'current'), schedule: (fn, ms) => (delays.push(ms), queue.push(fn)), batch: 2, gapMs: 99 })
    while (queue.length > 0) queue.shift()?.()
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(delays).toEqual([0, 99])
  })
})

describe('the lazy path', () => {
  it('migrates on open and records it', () => {
    const h = harness(1)
    const m = h.make()
    const loaded = h.chats.load(ID(1))
    expect(loaded.capabilities.engine).toBe('api-key')
    expect(m.report.get()).toMatchObject({ migrated: 1, from: 0 })
    expect(existsSync(backupPath(join(h.dir, 'chats', BACKUP_DIR), ID(1), 0))).toBe(true)
    // Opening again changes nothing.
    h.chats.load(ID(1))
    expect(m.report.get().migrated).toBe(1)
  })

  it('throws ChatMigrationError for a damaged or newer file, and lists it once', () => {
    const h = harness(2)
    writeFileSync(h.chats.fileOf(ID(1)), '{')
    writeFileSync(h.chats.fileOf(ID(2)), fixtureText('newer', 'v9.json'))
    const m = h.make()
    expect(() => h.chats.load(ID(1))).toThrow(ChatMigrationError)
    expect(() => h.chats.load(ID(1))).toThrow(t('migrations.notice.damaged'))
    expect(() => h.chats.load(ID(2))).toThrow(t('migrations.notice.newer'))
    expect(m.report.get().failed).toHaveLength(1)
    expect(m.report.get().newer).toHaveLength(1)
    const broadcasts = h.events.length
    expect(() => h.chats.load(ID(2))).toThrow()
    expect(h.events.length).toBe(broadcasts)
  })
})

describe('the notice actions', () => {
  it('Try again succeeds once the file is repaired', () => {
    const h = harness(1)
    const m = h.make()
    writeFileSync(h.chats.fileOf(ID(1)), '{"broken"')
    const failed = m.retry(ID(1))
    expect(failed.notice).toMatchObject({ kind: 'migration-failed', message: t('migrations.notice.damaged'), backup: false })
    expect(m.report.get().failed).toHaveLength(1)
    writeFileSync(h.chats.fileOf(ID(1)), v0(ID(1)))
    expect(m.retry(ID(1)).notice).toBeNull()
    expect(m.report.get().failed).toEqual([])
  })

  it('Retry all clears what was repaired', () => {
    const h = harness(3)
    for (const n of [1, 2]) writeFileSync(h.chats.fileOf(ID(n)), '[]')
    const m = h.make()
    const pass = m.start()
    h.drain()
    void pass
    expect(m.report.get().failed.map((o) => o.id).sort()).toEqual([ID(1), ID(2)])
    writeFileSync(h.chats.fileOf(ID(1)), v0(ID(1)))
    h.chats.remove([ID(2)])
    const report: MigrationReport = m.retryAll()
    expect(report.failed).toEqual([])
    expect(report.migrated).toBe(2)
  })

  it('Restore original puts the backup back and keeps the file it replaced', () => {
    const h = harness(1)
    const m = h.make()
    h.chats.load(ID(1)) // migrated, with a v0 backup
    writeFileSync(h.chats.fileOf(ID(1)), '{"damaged"')
    expect(() => h.chats.load(ID(1))).toThrow(ChatMigrationError)
    expect(m.report.get().failed).toHaveLength(1)
    const view = m.restoreBackup(ID(1))
    expect(view.notice).toBeNull()
    expect(h.chats.load(ID(1)).system).toBe('You are Pip.')
    const backups = readdirSync(join(h.dir, 'chats', BACKUP_DIR))
    const replaced = backups.find((name) => name.includes('.replaced-'))
    expect(replaced && readFileSync(join(h.dir, 'chats', BACKUP_DIR, replaced), 'utf8')).toBe('{"damaged"')
    expect(m.report.get().failed).toEqual([])
  })

  it('Restore original refuses without a backup, or for a chat that opens fine', () => {
    const h = harness(1)
    const m = h.make()
    expect(() => m.restoreBackup(ID(1))).toThrow(t('migrations.notice.notNeeded'))
    const fresh = harness(0)
    fresh.chats.save(content(ID(9)), { created: summary(ID(9)) })
    writeFileSync(fresh.chats.fileOf(ID(9)), 'nope')
    expect(() => fresh.make().restoreBackup(ID(9))).toThrow(t('migrations.notice.noBackup'))
    expect(() => m.restoreBackup(ID(7))).toThrow('no longer exists')
  })

  it('deleting a chat removes its backups and report lines', () => {
    const h = harness(2)
    const m = h.make()
    h.chats.load(ID(1))
    h.chats.load(ID(2))
    writeFileSync(h.chats.fileOf(ID(1)), '{')
    expect(() => h.chats.load(ID(1))).toThrow(ChatMigrationError)
    h.chats.remove([ID(1)])
    expect(readdirSync(join(h.dir, 'chats', BACKUP_DIR))).toEqual([`${ID(2)}.v0.json`])
    expect(m.report.get().failed).toEqual([])
  })

  it('Show file reveals the chat file', () => {
    const h = harness(1)
    h.make().revealFile(ID(1))
    expect(h.revealed).toEqual([h.chats.fileOf(ID(1))])
  })
})

describe('the report', () => {
  it('persists across restarts and survives a damaged file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-report-'))
    const path = join(dir, 'migrations.json')
    const seen: MigrationReport[] = []
    const store = new MigrationReportStore(path, '2.0.0', (r) => seen.push(r))
    store.startRun(2, 50)
    store.record({ id: ID(1), title: 'A', from: 2, to: CHAT_FORMAT_VERSION, ok: true, at: 60 })
    store.record({ id: ID(2), title: 'B', from: 2, to: CHAT_FORMAT_VERSION, ok: false, error: 'bad', at: 61 })
    // The same failure again is not a change.
    expect(store.record({ id: ID(2), title: 'B', from: 2, to: CHAT_FORMAT_VERSION, ok: false, error: 'bad', at: 62 })).toBe(false)
    store.flush()
    store.flush()
    expect(seen).toHaveLength(1)
    expect(new MigrationReportStore(path, '2.0.1').get()).toMatchObject({ appVersion: '2.0.1', from: 2, migrated: 1, failed: [{ id: ID(2) }], lastRunAt: 60 })
    writeFileSync(path, '{"lastRunAt":"yesterday"}')
    expect(readReport(path, '3.0.0')).toMatchObject({ appVersion: '3.0.0', lastRunAt: null, migrated: 0 })
  })

  it('lists newer settings files, and drops them once they read fine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-report-files-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 4 }))
    readVersioned(join(dir, 'settings.json'), 1, (raw) => raw)
    const { migrations, services } = setupMigrations({ chats: new ChatStore(dir, 'companion-1'), dataDir: dir, schedule: () => undefined })
    expect(services.migrations.report().newer.map((o) => [o.id, o.from])).toEqual([['settings.json', 4]])
    migrations.stop()
    resetNewerFiles()
    const later = setupMigrations({ chats: new ChatStore(dir, 'companion-1'), dataDir: dir, schedule: () => undefined })
    expect(later.services.migrations.report().newer).toEqual([])
  })
})

describe('the notice view', () => {
  it('opens a newer chat read-only with what can be shown', () => {
    const error = new ChatMigrationError('newer', 9, 'Saved by a newer Atelier.', {
      readOnly: { ...content(ID(1)), capabilities: { model: 'claude-opus-6', effort: 'low', browser: true, webTools: true, memory: false, connectorIds: ['c'], engine: 'another-engine' as EngineId } },
      backup: true,
    })
    const view = noticeView({ summary: summary(ID(1), 'Future'), error, seq: 12, effort: 'high' })
    expect(view.notice).toEqual({ kind: 'newer-format', message: 'Saved by a newer Atelier.', backup: true })
    expect(view.setup).toMatchObject({ model: 'claude-opus-6', effort: 'low', engine: 'another-engine', fixed: true, connectorIds: ['c'] })
    expect(view.log).toHaveLength(1)
    expect(view).toMatchObject({ seq: 12, agentStatus: 'idle', queued: [], tabIds: [] })
  })

  it('opens a damaged chat with an empty log', () => {
    const view = noticeView({ summary: summary(ID(2)), error: new ChatMigrationError('failed', 0, 'Damaged.'), seq: 0, effort: 'medium' })
    expect(view.notice).toEqual({ kind: 'migration-failed', message: 'Damaged.', backup: false })
    expect(view.log).toEqual([])
    expect(view.setup).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', engine: 'api-key' })
  })
})
