/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import type { CrashState, LogPage } from '@shared/diagnostics'
import { isEngine } from '@shared/engine'
import { menuContributions, type MenuState } from '@shared/menuModel'
import { commands } from '../commands'
import { logger } from '../diagnostics/logger'
import { setDiagnosticsShell, type DiagnosticsShell } from '../diagnostics/service'
import { dialogsSmoke } from '../dialogsFeature'
import { log, registerSecret } from '../log'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { SmokeContext } from '../smokeBrowser/types'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// Diagnostics: the logger (redacted JSON lines in userData/logs), the Help items,
// the problem report opened by the report-problem command (⇧⌘H) and saved
// with ⌘↩ into a stand-in Downloads folder (nothing is revealed and no
// email app opens: the desktop shell is a recorder), the crash state and
// atelier://logs. Offline only.

interface ShellRecord {
  revealed: string[]
  opened: string[]
}

/** Swaps the desktop for a recorder with its own Downloads folder for the run of `fn`. */
async function withRecorder<T>(fn: (record: ShellRecord, downloads: string) => Promise<T>): Promise<T> {
  const downloads = mkdtempSync(join(tmpdir(), 'atelier-smoke-downloads-'))
  const record: ShellRecord = { revealed: [], opened: [] }
  const fake: DiagnosticsShell = {
    showItemInFolder: (path) => void record.revealed.push(path),
    openPath: async (path) => {
      record.revealed.push(path)
      return ''
    },
    openExternal: async (url) => {
      record.opened.push(url)
    },
    downloads: () => downloads,
  }
  setDiagnosticsShell(fake)
  try {
    return await fn(record, downloads)
  } finally {
    setDiagnosticsShell(null)
  }
}

/** The document that drew `selector`: the interactive overlay tier, else the chrome (its fallback). */
async function drawnIn(ctx: SmokeContext, selector: string, what: string): Promise<Chrome> {
  let found: Chrome = ctx.chrome
  await waitFor(
    async () => {
      const wc = dialogsSmoke.window()?.overlay.tierWebContents('interactive')
      const docs = [...(wc && !wc.isDestroyed() ? [new Chrome(wc)] : []), ctx.chrome]
      for (const doc of docs) {
        if (await doc.js<boolean>(`return Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)) {
          found = doc
          return true
        }
      }
      return false
    },
    8000,
    what,
  )
  return found
}

async function openReport(ctx: SmokeContext): Promise<Chrome> {
  const ran = await commands.run('report-problem', dialogsSmoke.window())
  assert(ran, 'report-problem is not a registered command')
  return drawnIn(ctx, '.dg-report__text', 'the problem report')
}

/** ⌘↩ (Ctrl+Enter off macOS) in the description field. */
async function pressSaveAndEmail(doc: Chrome): Promise<void> {
  const mac = process.platform === 'darwin'
  const ok = await doc.js<boolean>(`
    const el = document.querySelector('.dg-report__text')
    if (!el) return false
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: ${mac}, ctrlKey: ${!mac}, bubbles: true, cancelable: true }))
    return true`)
  assert(ok, 'no description field to press ⌘↩ in')
}

async function closeReport(doc: Chrome): Promise<void> {
  // Done in the success state; otherwise Cancel, then Discard if it asks.
  await doc.js(`
    const done = document.querySelector('.dg-report [data-autofocus]')
    if (done) done.click()`)
  await doc.escape()
  await sleep(150)
  await doc.js(`
    const discard = [...document.querySelectorAll('.dg-report__footer--confirm button')].pop()
    if (discard) discard.click()`)
  await doc.until<boolean>(`return !document.querySelector('.dg-report')`, 5000, 'the problem report to close')
}

export const checks: SmokeCheck[] = [
  {
    name: 'diagnostics: the logger writes redacted JSON lines to userData/logs and finds them again',
    async run(ctx) {
      const marker = `diagnostics-smoke-${Date.now().toString(36)}`
      const secret = `atelier-smoke-secret-${Math.random().toString(36).slice(2, 12)}`
      registerSecret(secret)
      log.info('diagnostics', `${marker} key=${secret} sk-ant-api03-SMOKExxxxxxxxxxxxxxxx https://example.test/a?q=private#part`)
      logger.flushSync()
      const file = logger.file
      assert(file && file.includes(join('logs', 'atelier.log')), `the log file is ${String(file)}`)
      const text = readFileSync(file, 'utf8')
      const line = text.split('\n').find((l) => l.includes(marker))
      assert(line, 'the marker line was not written')
      const entry = JSON.parse(line) as { level: string; source: string; message: string }
      assert(entry.level === 'info' && entry.source === 'diagnostics', `unexpected entry ${line}`)
      for (const leaked of [secret, 'sk-ant-api03-SMOKE', 'q=private', '#part']) assert(!line.includes(leaked), `the log line kept ${leaked}`)
      const page = await ctx.chrome.invoke<LogPage>('diagnostics', 'logs', { text: marker, limit: 10 })
      assert(page.entries.length === 1 && page.files >= 1, `the log query found ${page.entries.length} lines`)
    },
  },
  {
    name: 'diagnostics: Help holds Send Feedback, Report a Problem (⇧⌘H), Show Logs and What’s New',
    async run() {
      for (const target of ['help', 'main-menu:help'] as const) {
        const items = menuContributions(target).filter((c) => c.id.startsWith('diagnostics:')).flatMap((c) => c.build({} as MenuState))
        const ids = items.map((i) => i.id)
        for (const id of ['help:send-feedback', 'help:report-problem', 'help:show-logs', 'help:whats-new']) assert(ids.includes(id), `${target} lacks ${id}`)
        assert(items.find((i) => i.id === 'help:report-problem')?.accelerator === 'CmdOrCtrl+Shift+H', `${target}: Report a Problem has no ⇧⌘H`)
      }
    },
  },
  {
    name: 'diagnostics: ⇧⌘H opens the problem report; ⌘↩ saves the zip, reveals it and opens the email draft',
    async run(ctx) {
      await withRecorder(async (record, downloads) => {
        const doc = await openReport(ctx)
        try {
          // Nothing typed yet: ⌘↩ asks for a description and saves nothing.
          await pressSaveAndEmail(doc)
          await doc.until<boolean>(`return document.querySelector('.dg-report__text')?.getAttribute('aria-invalid') === 'true'`, 3000, 'the description to be asked for')
          assert(record.opened.length === 0, 'a report was saved without a description')
          await doc.type('.dg-report__text', 'Smoke: the page went blank after switching tabs.')
          await pressSaveAndEmail(doc)
          await doc.until<boolean>(`return Boolean(document.querySelector('.dg-report__done-mark'))`, 15000, 'the saved state')
          const zipPath = record.revealed.at(-1)
          assert(zipPath && zipPath.startsWith(downloads) && new RegExp(`${BRAND_NAME} problem report \\d{4}-\\d{2}-\\d{2} \\d{2}\\.\\d{2}( \\(\\d+\\))?\\.zip$`).test(zipPath), `revealed ${String(zipPath)}`)
          assert(record.opened.at(-1)?.startsWith('mailto:'), 'the email draft did not open')
          assert((record.opened.at(-1) ?? '').length < 4000, 'the mailto link is too long')
          const files = unzipSync(new Uint8Array(readFileSync(zipPath)))
          const names = Object.keys(files)
          for (const name of ['report.json', 'description.txt']) assert(names.includes(name), `the zip lacks ${name}`)
          assert(names.some((n) => /^logs\/atelier(\.\d)?\.log$/.test(n)), `the zip has no logs: ${names.join(', ')}`)
          assert(!names.includes('screenshot.png') && !names.includes('chat.md'), 'the zip holds parts that were not switched on')
          const part = (name: string): string => strFromU8(files[name] ?? new Uint8Array())
          const report = JSON.parse(part('report.json')) as { schema: number; engineKind: string; settingsSummary: Record<string, unknown> }
          assert(report.schema === 1, `report.json schema ${report.schema}`)
          assert(isEngine(report.engineKind), `engineKind ${report.engineKind}`)
          assert(!('name' in report.settingsSummary) && !('avatar' in report.settingsSummary), 'the settings summary carries your name or picture')
          assert(part('description.txt').includes('went blank'), 'description.txt is not the description')
        } finally {
          await closeReport(doc).catch(() => undefined)
        }
      })
    },
  },
  {
    name: 'diagnostics: Esc asks before discarding a typed description',
    async run(ctx) {
      const doc = await openReport(ctx)
      try {
        await doc.type('.dg-report__text', 'Smoke: something to keep.')
        await doc.js(`document.querySelector('.dg-report__text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
        await doc.until<boolean>(`return Boolean(document.querySelector('.dg-report__footer--confirm'))`, 3000, 'the discard question')
      } finally {
        await closeReport(doc).catch(() => undefined)
      }
    },
  },
  {
    name: 'diagnostics: the crash state answers, and atelier://logs lists lines and filters them',
    async run(ctx) {
      const state = await ctx.chrome.invoke<CrashState>('diagnostics', 'crashState')
      assert(typeof state.lastExitUnclean === 'boolean' && typeof state.dumps === 'number', `crash state ${JSON.stringify(state)}`)
      const marker = `diagnostics-logs-${Date.now().toString(36)}`
      log.warn('diagnostics', `${marker} shown on the logs page`)
      ctx.tabs.openInternal('atelier://logs', { newTab: true })
      await ctx.chrome.until<boolean>(`return document.querySelectorAll('.dg-log-row').length > 0`, 8000, 'log rows on atelier://logs')
      await ctx.chrome.type('.dg-logs__toolbar input', marker)
      await ctx.chrome.until<boolean>(
        `const rows = [...document.querySelectorAll('.dg-log-row')]; return rows.length === 1 && rows[0].textContent.includes(${JSON.stringify(marker)})`,
        5000,
        'the search to leave only the marker line',
      )
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'e2 problem report',
    async run(ctx) {
      const doc = await openReport(ctx)
      try {
        await doc.type('.dg-report__text', 'Pages stop loading after the laptop wakes from sleep.')
        await sleep(600)
        await ctx.shot('diagnostics-problem-report')
      } finally {
        await closeReport(doc).catch(() => undefined)
      }
    },
  },
  {
    name: 'e2 logs page',
    async run(ctx) {
      log.info('diagnostics', 'Logs page shot')
      ctx.tabs.openInternal('atelier://logs', { newTab: true })
      await ctx.chrome.until<boolean>(`return document.querySelectorAll('.dg-log-row').length > 0`, 8000, 'log rows on atelier://logs')
      await sleep(300)
      await ctx.shot('diagnostics-logs')
    },
  },
]
