/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_FORMAT_VERSION } from '@shared/migrations'
import { t } from '@shared/i18n/core'
import { BACKUP_DIR, backupPath, findBackup } from '../src/main/migrations/backup'
import { CHAT_STEPS, applySteps } from '../src/main/migrations/chatSteps'
import { chatSchema } from '../src/main/migrations/chatSchema'
import { ChatMigrationError, migrateChatFile, upgradeChatFile, upgradeRecord } from '../src/main/migrations/runner'
import { declaredVersion, newerCopyPath, newerFileOutcomes, readVersioned, resetNewerFiles } from '../src/main/migrations/versionedFile'
import { SettingsStore } from '../src/main/settings'
import { CompanionStore } from '../src/main/companions'

// The versioned chat steps, the runner on load, backups, and the
// newer-file guard for settings and companions (SS-09).

const FIXTURES = join(__dirname, 'fixtures', 'chats')
const fixtureText = (...path: string[]): string => readFileSync(join(FIXTURES, ...path), 'utf8')
const fixture = (...path: string[]): Record<string, unknown> => JSON.parse(fixtureText(...path)) as Record<string, unknown>
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'apex-migrations-'))

afterEach(() => resetNewerFiles())

describe('chat steps', () => {
  it('run in order from v0 to the current format', () => {
    expect(CHAT_STEPS[0]?.from).toBe(0)
    CHAT_STEPS.forEach((step, i) => {
      expect(step.to).toBe(step.from + 1)
      if (i > 0) expect(step.from).toBe(CHAT_STEPS[i - 1]?.to)
    })
    expect(CHAT_STEPS.at(-1)?.to).toBe(CHAT_FORMAT_VERSION)
  })

  it.each(CHAT_STEPS.map((s) => [`${s.from} → ${s.to}: ${s.name}`, s] as const))('%s matches its expected output', (_name, step) => {
    const input = fixture('steps', `${step.from}-${step.to}.in.json`)
    const before = JSON.stringify(input)
    const out = step.up(input)
    expect(out).toMatchObject(fixture('steps', `${step.from}-${step.to}.out.json`))
    expect(out.formatVersion).toBe(step.to)
    // Pure: the input is left as it was.
    expect(JSON.stringify(input)).toBe(before)
  })

  it.each(CHAT_STEPS.map((s) => [`${s.from} → ${s.to}`, s] as const))('%s is idempotent', (_name, step) => {
    const once = step.up(fixture('steps', `${step.from}-${step.to}.in.json`))
    expect(step.up(once)).toEqual(once)
  })

  it('brings an unversioned file all the way to a valid current chat', () => {
    const out = applySteps(fixture('v0', 'chat.json'), 0)
    expect(chatSchema.safeParse(out).success).toBe(true)
    expect(out).toMatchObject({
      formatVersion: CHAT_FORMAT_VERSION,
      pinned: true,
      actWithoutAsking: false,
      muted: false,
      private: false,
      parentChatId: null,
      projectId: null,
      details: {},
      feedback: {},
      grants: [],
      capabilities: { model: 'claude-opus-5-5', engine: 'api-key', connectorIds: ['c1'], documents: false, compaction: false, containerId: null, localTools: [], toolPolicies: {}, clientTools: [], private: false },
    })
    // An unknown effort follows the global setting again.
    expect(out.capabilities).not.toHaveProperty('effort')
    const log = out.log as Array<Record<string, unknown>>
    expect(log.map((e) => e.type)).toEqual(['user-message', 'tool', 'tool', 'text-delta'])
    expect(log[1]).toMatchObject({ kind: 'other', state: 'done' })
    expect(log[2]).toMatchObject({ kind: 'other', state: 'done' })
    expect(log[2]).not.toHaveProperty('startedAt')
    expect(log[2]).not.toHaveProperty('input')
  })
})

describe('the chat format fixtures', () => {
  const base = { capabilities: { model: 'claude-opus-5-5', browser: true, webTools: true, memory: true, connectorIds: [] }, system: 's', messages: [{ role: 'user', content: 'hi' }], details: {}, feedback: {} }
  const cases: Array<[string, Record<string, unknown>]> = [
    ['original-summary', { ...fixture('formats', 'original-summary.json'), ...base, log: [] }],
    ['flags-summary + flags-log', { ...fixture('formats', 'flags-summary.json'), ...base, log: JSON.parse(fixtureText('formats', 'flags-log.json')) as unknown[] }],
    ['attachments', fixture('formats', 'attachments.json')],
    ['refs', fixture('formats', 'refs.json')],
    ['before-summary-fields', fixture('formats', 'before-summary-fields.json')],
    ['summary-fields', fixture('formats', 'summary-fields.json')],
    ['v0/chat', fixture('v0', 'chat.json')],
  ]

  it.each(cases)('%s migrates to the current format', (_name, raw) => {
    const id = String(raw.id)
    const { content, migratedFrom } = migrateChatFile(raw, id)
    expect(migratedFrom).toBe(0)
    expect(content.id).toBe(id)
    expect(content.capabilities.engine).toBeDefined()
    expect(content.grants).toBeInstanceOf(Array)
    // Running it again on the result changes nothing.
    const again = upgradeRecord({ ...applySteps(raw, 0) }, id)
    expect(again.from).toBe(CHAT_FORMAT_VERSION)
    expect(migrateChatFile(again.record, id)).toEqual({ content, migratedFrom: null })
  })

  it('keeps what each era wrote', () => {
    const a = migrateChatFile(cases[1]![1], 'x').content
    expect(a.log.filter((e) => e.type === 'tool').map((e) => (e as { kind?: string }).kind)).toEqual(['other', 'web-search'])
    const b = migrateChatFile(fixture('formats', 'attachments.json'), 'b').content
    const message = b.log[0] as { attachments?: Array<{ kind: string; state: string; sourceId?: string }> }
    expect(message.attachments?.map((x) => [x.kind, x.state, x.sourceId ?? null])).toEqual([['image', 'ready', null], ['meeting', 'ready', 'm-1']])
    const d = migrateChatFile(fixture('formats', 'summary-fields.json'), 'd').content
    expect(d.capabilities).toMatchObject({ engine: 'claude-code', clientTools: ['list_routines', 'update_plan'] })
    expect(d.grants).toEqual([{ origin: 'https://shop.example', action: 'purchase', at: 1795000030000 }])
  })
})

describe('the runner', () => {
  const ID = '0a0a0a0a-1111-4222-8333-444444444444'
  const setup = (text: string): { file: string; backupDir: string; ref: Parameters<typeof upgradeChatFile>[0] } => {
    const dir = tempDir()
    const file = join(dir, `${ID}.json`)
    writeFileSync(file, text)
    const backupDir = join(dir, BACKUP_DIR)
    return { file, backupDir, ref: { id: ID, file, backupDir, title: 'Old trip' } }
  }

  it('backs up an older file once, then writes the migrated one', () => {
    const original = fixtureText('v0', 'chat.json')
    const { file, backupDir, ref } = setup(original)
    const first = upgradeChatFile(ref, 1000)
    expect(first.status).toBe('migrated')
    expect(first.outcome).toEqual({ id: ID, title: 'Old trip', from: 0, to: CHAT_FORMAT_VERSION, ok: true, at: 1000 })
    expect(readFileSync(backupPath(backupDir, ID, 0), 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(file, 'utf8')).formatVersion).toBe(CHAT_FORMAT_VERSION)

    // Idempotent: the migrated file is current and is not written again.
    const written = readFileSync(file, 'utf8')
    expect(upgradeChatFile(ref).status).toBe('current')
    expect(readFileSync(file, 'utf8')).toBe(written)

    // A second v0 file for the same chat never replaces the first backup.
    writeFileSync(file, original.replace('Old trip', 'Changed'))
    expect(upgradeChatFile(ref).status).toBe('migrated')
    expect(readFileSync(backupPath(backupDir, ID, 0), 'utf8')).toBe(original)
    expect(readdirSync(backupDir)).toEqual([`${ID}.v0.json`])
  })

  it('never writes a file a newer Apex saved, and still shows what it can', () => {
    const text = fixtureText('newer', 'v9.json')
    const { file, backupDir, ref } = setup(text)
    const result = upgradeChatFile(ref)
    expect(result.status).toBe('newer')
    expect(result.outcome).toMatchObject({ from: 9, to: CHAT_FORMAT_VERSION, ok: false })
    expect(result.error).toBeInstanceOf(ChatMigrationError)
    expect(result.error?.kind).toBe('newer')
    expect(result.error?.message).toBe(t('migrations.notice.newer'))
    expect(result.error?.readOnly?.log.map((e) => e.type)).toEqual(['user-message', 'text-delta', 'teleport'])
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(existsSync(backupDir)).toBe(false)
  })

  it.each([
    ['truncated JSON', 'truncated.json', 'migrations.notice.damaged', 'not valid JSON'],
    ['a broken shape', 'no-messages.json', 'migrations.notice.failed', 'messages'],
  ] as const)('reports %s as failed and leaves the file alone', (_name, name, key, detail) => {
    const text = fixtureText('corrupt', name)
    const { file, ref } = setup(text)
    const result = upgradeChatFile(ref)
    expect(result.status).toBe('failed')
    expect(result.error?.message).toBe(t(key))
    expect(result.outcome?.error).toContain(detail)
    expect(result.error?.backup).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('says when a backup can be restored', () => {
    const { file, backupDir, ref } = setup(fixtureText('v0', 'chat.json'))
    upgradeChatFile(ref)
    writeFileSync(file, '{"oops"')
    expect(upgradeChatFile(ref).error?.backup).toBe(true)
    expect(findBackup(backupDir, ID)).toEqual({ path: backupPath(backupDir, ID, 0), version: 0 })
    // A backup from a newer format can't be restored here.
    writeFileSync(backupPath(backupDir, ID, CHAT_FORMAT_VERSION + 1), '{}')
    expect(findBackup(backupDir, ID)?.version).toBe(0)
  })

  it('treats a missing file as missing and an unreadable version as unknown', () => {
    const { file, ref } = setup('{}')
    writeFileSync(file, JSON.stringify({ ...fixture('v0', 'chat.json'), formatVersion: 'two' }))
    expect(upgradeChatFile(ref).error?.message).toBe(t('migrations.notice.unknownFormat'))
    expect(upgradeChatFile({ ...ref, file: join(ref.backupDir, 'gone.json') }).status).toBe('missing')
  })

  it('throws ChatMigrationError from the pure hook', () => {
    expect(() => migrateChatFile('nope', ID)).toThrow(ChatMigrationError)
    expect(() => migrateChatFile(fixture('newer', 'v9.json'), ID)).toThrow(t('migrations.notice.newer'))
  })
})

describe('versioned files', () => {
  it('reads the declared version', () => {
    expect(declaredVersion({ formatVersion: 2 })).toBe(2)
    expect(declaredVersion({ version: 1 })).toBe(1)
    expect(declaredVersion({ version: '3' })).toBeNull()
    expect(declaredVersion([])).toBeNull()
    expect(newerCopyPath('/a/settings.json', 4)).toBe(join('/a/settings.newer-v4.json'))
  })

  it('keeps a copy of a newer file before falling back, and lists it', () => {
    const dir = tempDir()
    const path = join(dir, 'thing.json')
    writeFileSync(path, JSON.stringify({ version: 3, value: 'kept' }))
    const out = readVersioned(path, 1, (raw) => (raw as { value: string }).value)
    expect(out).toEqual({ value: 'kept', newer: true })
    expect(JSON.parse(readFileSync(join(dir, 'thing.newer-v3.json'), 'utf8'))).toEqual({ version: 3, value: 'kept' })
    expect(newerFileOutcomes()).toMatchObject([{ id: 'thing.json', from: 3, to: 1, ok: false }])
  })

  it('reads current, missing and broken files without copies', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ version: 1 }))
    writeFileSync(join(dir, 'b.json'), '{')
    expect(readVersioned(join(dir, 'a.json'), 1, () => 'ok')).toEqual({ value: 'ok', newer: false })
    expect(readVersioned(join(dir, 'b.json'), 1, () => 'ok')).toEqual({ value: null, newer: false })
    expect(readVersioned(join(dir, 'none.json'), 1, () => 'ok')).toEqual({ value: null, newer: false })
    expect(readVersioned(join(dir, 'a.json'), 1, () => {
      throw new Error('bad')
    })).toEqual({ value: null, newer: false })
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json'])
    expect(newerFileOutcomes()).toEqual([])
  })

  it('protects settings.json from a downgrade', () => {
    const dir = tempDir()
    const saved = { formatVersion: 2, theme: 'dark', hologramMode: 'on' }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(saved))
    const store = new SettingsStore(dir)
    expect(store.get().theme).toBe('dark')
    expect(JSON.parse(readFileSync(join(dir, 'settings.newer-v2.json'), 'utf8'))).toEqual(saved)
    expect(newerFileOutcomes().map((o) => o.id)).toEqual(['settings.json'])
    // This build writes its own format marker.
    store.update({ theme: 'light' })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toMatchObject({ formatVersion: 1, theme: 'light' })
    expect(JSON.parse(readFileSync(join(dir, 'settings.newer-v2.json'), 'utf8'))).toEqual(saved)
  })

  it('protects companions.json from a downgrade', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    // A newer shape this build can't read: without the copy, the fallback would overwrite it.
    const saved = { version: 2, active: 'x', people: [{ key: 'x' }] }
    writeFileSync(join(dir, 'companions.json'), JSON.stringify(saved))
    const store = new CompanionStore(dir)
    expect(store.list().length).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(join(dir, 'companions.newer-v2.json'), 'utf8'))).toEqual(saved)
    expect(newerFileOutcomes().map((o) => o.id)).toEqual(['companions.json'])
  })
})
