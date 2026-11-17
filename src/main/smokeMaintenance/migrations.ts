/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CHAT_FORMAT_VERSION, type MigrationReport } from '@shared/migrations'
import type { ChatView } from '@shared/chats'
import { normalizeSummary, type ChatContent, type ChatStore } from '../chats'
import { FIRST_COMPANION_ID } from '../companions'
import { BACKUP_DIR, backupPath } from '../migrations/backup'
import { migrateChatFile } from '../migrations/runner'
import { SettingsStore } from '../settings'
import { assert, waitFor } from '../smokeKit'
import type { SmokeContext } from '../smokeBrowser/types'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// Chat file migrations: v0, current, newer and corrupt chat files seeded into the
// running ChatStore; the migrated file and its single backup; the newer file
// opened read-only and never rewritten; the corrupt file's notice with the
// composer disabled, and Try again after the file is fixed; a newer
// settings.json copy; every chat format fixture; About › Data updates.
// Offline only.

const V0 = (id: string, title: string): string =>
  JSON.stringify({
    id, title, createdAt: 1, updatedAt: 1, lastActiveAt: 1, routineId: null, companionId: FIRST_COMPANION_ID, model: 'claude-opus-5-5', status: 'finished',
    capabilities: { model: 'claude-opus-5-5', effort: 'high', browser: true, webTools: true, memory: true, connectorIds: [] },
    system: 'You are Pip.',
    messages: [{ role: 'user', content: 'Plan a picnic' }, { role: 'assistant', content: [{ type: 'text', text: 'Bring a blanket.' }] }],
    log: [
      { type: 'user-message', id: randomUUID(), text: 'Plan a picnic' },
      { type: 'tool', id: 'toolu_smoke', label: 'Read the page', state: 'done' },
      { type: 'text-delta', turnId: randomUUID(), text: 'Bring a blanket.' },
    ],
    details: {},
    feedback: {},
  })

const NEWER = (id: string): string =>
  JSON.stringify({
    formatVersion: CHAT_FORMAT_VERSION + 4, id, title: 'Saved by a newer Apex', companionId: FIRST_COMPANION_ID,
    capabilities: { model: 'claude-opus-5-5', browser: true, webTools: true, memory: true, connectorIds: [], engine: 'api-key', newerOnly: true },
    system: 's',
    messages: [{ role: 'user', content: 'Hello from later' }],
    log: [{ type: 'user-message', id: randomUUID(), text: 'Hello from later' }, { type: 'text-delta', turnId: randomUUID(), text: 'This came from a newer build.' }],
    details: {},
    feedback: {},
  })

interface Seeded {
  v0: string
  current: string
  newer: string
  corrupt: string
  newerBytes: string
}

let seeded: Seeded | null = null

/** Adds a chat to the running store, then replaces its file with `text`. */
function seed(chats: ChatStore, title: string, text: (id: string) => string): string {
  const id = randomUUID()
  const now = Date.now()
  const summary = normalizeSummary({ id, title, createdAt: now, updatedAt: now, lastActiveAt: now, companionId: FIRST_COMPANION_ID, status: 'finished', model: 'claude-opus-5-5' }, FIRST_COMPANION_ID)
  const content: ChatContent = {
    id,
    capabilities: { model: 'claude-opus-5-5', browser: true, webTools: true, memory: true, connectorIds: [] },
    system: 's',
    messages: [{ role: 'user', content: title }],
    log: [{ type: 'user-message', id: randomUUID(), text: title }],
    details: {},
    feedback: {},
  }
  chats.save(content, { created: summary })
  writeFileSync(chats.fileOf(id), text(id))
  return id
}

function seedAll(ctx: SmokeContext): Seeded {
  if (seeded) return seeded
  const { chats } = ctx
  const newer = seed(chats, 'Saved by a newer Apex', NEWER)
  seeded = {
    v0: seed(chats, 'Picnic from an older Apex', (id) => V0(id, 'Picnic from an older Apex')),
    current: seed(chats, 'Already up to date', (id) => JSON.stringify({ ...JSON.parse(V0(id, 'Already up to date')), formatVersion: CHAT_FORMAT_VERSION, capabilities: { model: 'claude-opus-5-5', browser: true, webTools: true, memory: true, connectorIds: [], engine: 'api-key' } })),
    newer,
    corrupt: seed(chats, 'A damaged chat', () => '{"title":"A damaged chat","messages":['),
    newerBytes: readFileSync(chats.fileOf(newer), 'utf8'),
  }
  return seeded
}

async function openChat(ctx: SmokeContext, id: string, ready: string): Promise<string> {
  const tab = ctx.tabs.create('about:blank')
  ctx.tabs.navigate(tab.id, `apex://chat/${id}`)
  await ctx.chrome.until(`return document.querySelector(${JSON.stringify(ready)})`, 8000, `apex://chat/${id} to show ${ready}`)
  return tab.id
}

export const checks: SmokeCheck[] = [
  {
    name: 'migrations: a v0 chat is migrated once, with one backup, and reported',
    async run(ctx) {
      const s = seedAll(ctx)
      const view = ctx.host.view(s.v0)
      assert(!view.notice, `the v0 chat shows a notice: ${view.notice?.message}`)
      assert(view.log.some((e) => e.type === 'tool' && e.kind === 'other'), 'the tool event has no kind')
      const file = ctx.chats.fileOf(s.v0)
      assert(JSON.parse(readFileSync(file, 'utf8')).formatVersion === CHAT_FORMAT_VERSION, 'the migrated file has no current formatVersion')
      const backupDir = join(dirname(file), BACKUP_DIR)
      const backup = backupPath(backupDir, s.v0, 0)
      assert(existsSync(backup), 'no backup was written')
      const first = readFileSync(backup, 'utf8')
      writeFileSync(file, V0(s.v0, 'Picnic from an older Apex (again)'))
      ctx.chats.upgradeFile(s.v0)
      assert(readFileSync(backup, 'utf8') === first, 'the backup was rewritten')
      assert(readdirSync(backupDir).filter((n) => n.startsWith(s.v0)).length === 1, 'more than one backup')
      const report = await ctx.chrome.invoke<MigrationReport>('migrations', 'report')
      assert(report.migrated >= 1 && report.to === CHAT_FORMAT_VERSION, `the report says ${JSON.stringify(report)}`)
      assert(!ctx.host.view(s.current).notice, 'the current chat shows a notice')
    },
  },
  {
    name: 'migrations: a newer chat opens read-only and is never rewritten',
    async run(ctx) {
      const s = seedAll(ctx)
      const view = ctx.host.view(s.newer)
      assert(view.notice?.kind === 'newer-format', `expected the newer-format notice, got ${JSON.stringify(view.notice)}`)
      assert(view.log.some((e) => e.type === 'text-delta'), 'the newer chat shows nothing read-only')
      let refused = false
      try {
        ctx.host.send(s.newer, 'Can I continue?')
      } catch {
        refused = true
      }
      assert(refused, 'sending in a newer chat was not refused')
      const tabId = await openChat(ctx, s.newer, '.migration-notice[data-kind="newer-format"]')
      assert(await ctx.chrome.js<boolean>(`return document.querySelector('.chat-view--page .chat-composer__field')?.disabled === true`), 'the composer is not disabled')
      ctx.tabs.close(tabId)
      assert(readFileSync(ctx.chats.fileOf(s.newer), 'utf8') === s.newerBytes, 'the newer file was rewritten')
      const report = await ctx.chrome.invoke<MigrationReport>('migrations', 'report')
      assert(report.newer.some((o) => o.id === s.newer), 'the newer chat is not in the report')
    },
  },
  {
    name: 'migrations: a corrupt chat shows the notice, and Try again works after a repair',
    async run(ctx) {
      const s = seedAll(ctx)
      const tabId = await openChat(ctx, s.corrupt, '.migration-notice[data-kind="migration-failed"]')
      assert(await ctx.chrome.js<boolean>(`return document.querySelector('.chat-view--page .chat-composer__field')?.disabled === true`), 'the composer is not disabled')
      assert(await ctx.chrome.js<boolean>(`return !document.querySelector('.chat-view--page .chat-start')`), 'the start surface shows under a notice')
      await ctx.shot('migration-notice')
      const failed = await ctx.chrome.invoke<ChatView>('migrations', 'retry', s.corrupt)
      assert(failed.notice?.kind === 'migration-failed', 'Try again on a still-damaged file cleared the notice')
      writeFileSync(ctx.chats.fileOf(s.corrupt), V0(s.corrupt, 'A damaged chat'))
      await ctx.chrome.click(/^Try again$/, `document.querySelector('.migration-notice')`)
      await ctx.chrome.until(`return !document.querySelector('.migration-notice') && document.querySelector('.chat-view--page .chat-composer__field')?.disabled === false`, 8000, 'the notice to clear after Try again')
      const report = await ctx.chrome.invoke<MigrationReport>('migrations', 'report')
      assert(!report.failed.some((o) => o.id === s.corrupt), 'the repaired chat is still listed as failed')
      ctx.tabs.close(tabId)
    },
  },
  {
    name: 'migrations: a newer settings.json is kept before the fallback',
    async run() {
      const dir = mkdtempSync(join(tmpdir(), 'apex-smoke-e3-'))
      const saved = JSON.stringify({ formatVersion: 7, theme: 'dark', fromTheFuture: true })
      writeFileSync(join(dir, 'settings.json'), saved)
      const store = new SettingsStore(dir)
      assert(store.get().theme === 'dark', 'the newer settings were not read field by field')
      assert(readFileSync(join(dir, 'settings.newer-v7.json'), 'utf8') === saved, 'no copy of the newer settings.json')
    },
  },
  {
    name: 'migrations: every chat format fixture migrates to the current format',
    async run() {
      const root = join(process.env.APEX_SMOKE_FIXTURES ?? join(app.getAppPath(), 'tests', 'fixtures'), 'chats')
      // The packaged app ships without the test fixtures; the unit suite covers them there.
      if (!existsSync(root)) return
      const base = { capabilities: { model: 'claude-opus-5-5', browser: true, webTools: true, memory: true, connectorIds: [] }, system: 's', messages: [{ role: 'user', content: 'hi' }], details: {}, feedback: {} }
      const read = (...p: string[]): Record<string, unknown> => JSON.parse(readFileSync(join(root, ...p), 'utf8')) as Record<string, unknown>
      const files: Array<[string, Record<string, unknown>]> = [
        ['original-summary', { ...read('formats', 'original-summary.json'), ...base, log: [] }],
        ['flags-summary + flags-log', { ...read('formats', 'flags-summary.json'), ...base, log: JSON.parse(readFileSync(join(root, 'formats', 'flags-log.json'), 'utf8')) as unknown[] }],
        ['attachments', read('formats', 'attachments.json')],
        ['refs', read('formats', 'refs.json')],
        ['before-summary-fields', read('formats', 'before-summary-fields.json')],
        ['summary-fields', read('formats', 'summary-fields.json')],
        ['v0/chat', read('v0', 'chat.json')],
      ]
      for (const [name, raw] of files) {
        const { migratedFrom } = migrateChatFile(raw, String(raw.id))
        assert(migratedFrom === 0, `${name} did not migrate from v0`)
      }
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'migrations: the notice and About › Data updates',
    async run(ctx) {
      const s = seedAll(ctx)
      // A damaged chat with a backup, so every action shows.
      ctx.host.view(s.v0)
      writeFileSync(ctx.chats.fileOf(s.v0), '{"broken"')
      // The loaded chat is forgotten (not deleted), so opening it reads the damaged file.
      ctx.host.discard([s.v0])
      const notice = await openChat(ctx, s.v0, '.migration-notice[data-kind="migration-failed"]')
      await ctx.shot('migration-notice-failed')
      ctx.tabs.close(notice)
      const newer = await openChat(ctx, s.newer, '.migration-notice[data-kind="newer-format"]')
      await ctx.shot('migration-notice-newer')
      ctx.tabs.close(newer)
      // About › Data updates, once the About page mounts MigrationResults.
      const about = ctx.tabs.create('about:blank')
      ctx.tabs.navigate(about.id, 'apex://settings/about')
      let shown = true
      await waitFor(async () => ctx.chrome.js<boolean>(`return Boolean(document.querySelector('.migration-results .sp-row'))`), 6000, 'About › Data updates').catch(() => {
        shown = false
      })
      if (shown) await ctx.shot('about-data-updates')
      ctx.tabs.close(about.id)
      // Put the chat back as it was for the checks after this one.
      await ctx.chrome.invoke<ChatView>('migrations', 'restoreBackup', s.v0)
    },
  },
]
