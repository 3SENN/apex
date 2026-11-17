/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, session } from 'electron'
import { APEX_APP_PARTITION_PREFIX, APP_CSP, type AppSummary, type AppVersion } from '@shared/apps'
import type { CalendarStatus } from '@shared/calendar'
import type { FlagState } from '@shared/flags'
import type { AgentEvent } from '@shared/ipc'
import type { SiteSuggestion, SiteSuggestionSettings } from '@shared/siteSuggestions'
import type { CsvPreview, TableSummary } from '@shared/tables'
import type { AgentRequestResponse } from '@shared/agentTools'
import type { WebApp } from '@shared/webApps'
import { clientTool, type ClientToolContext } from '../agent/tools/registry'
import { appsSmoke, smokeOpened } from '../apps/feature'
import { core } from '../app'
import { menuContributions, type MenuState } from '@shared/menuModel'
import { lintAppDesign } from '@shared/appDesign'
import { registerScenario } from '../smokeClient'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// Apps in their sandbox, CSV tables and the SQL guard, flags, the calendar with the fake helper, app links and site suggestions.
// Offline only: build_app runs from a registerScenario script, pages come
// from the fixture server on 127.0.0.1, the calendar is the fake helper in
// tests/fixtures/calendar, and open-in-app is recorded, never launched.
// Every check puts settings and flags back the way it found them.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** An app that reports, in its title, whether the sandbox let it reach the network or open a window. */
const PROBE_APP = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title><style>body{font:16px system-ui;margin:40px;color:CanvasText;background:Canvas}h1{font-size:28px}</style></head><body><h1>Tip splitter</h1><p>Bill, people, tip: done.</p><script>
(async () => {
  let net = 'open'
  try { await fetch('http://127.0.0.1:9/ping') } catch { net = 'blocked' }
  const popup = window.open('https://example.com/') ? 'open' : 'blocked'
  document.title = 'net:' + net + ' popup:' + popup
})()
</script></body></html>`

/** An app built the way the design notes ask: Apex UI's components and tokens, every state, no colours of its own (APP-UI). */
const TIP_APP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tip splitter</title>
<style>.result { margin-top: var(--space-6); }</style></head>
<body><main class="ax-app">
<header class="ax-header"><div><h1 class="ax-title">Tip splitter</h1><p class="ax-subtitle">Split a bill and the tip between friends.</p></div>
<button class="ax-btn ax-btn--ghost ax-btn--sm" type="button" id="reset">Reset</button></header>
<section class="ax-section"><h2 class="ax-section__title">The bill</h2>
<div class="ax-card ax-stack">
<div class="ax-field"><label class="ax-label" for="total">Total</label><input class="ax-input ax-input--num" id="total" inputmode="decimal" value="120" autocomplete="off"><p class="ax-hint">Before the tip.</p></div>
<div class="ax-field"><span class="ax-label" id="tip-label">Tip</span>
<div class="ax-segmented" role="radiogroup" aria-labelledby="tip-label" id="tips">
<button type="button" role="radio" aria-checked="false" data-tip="10">10%</button><button type="button" role="radio" aria-checked="true" data-tip="15">15%</button><button type="button" role="radio" aria-checked="false" data-tip="20">20%</button></div></div>
<div class="ax-field"><label class="ax-label" for="people">People</label><input class="ax-input ax-input--num" id="people" inputmode="numeric" value="4"></div>
<label class="ax-check"><input type="checkbox" role="switch" class="ax-switch" id="round" checked> Round up each share</label>
</div></section>
<section class="ax-section result"><h2 class="ax-section__title">Each person pays</h2>
<dl class="ax-pairs ax-pairs--total" aria-live="polite"><div><dt>Tip</dt><dd id="tip"></dd></div><div><dt>Bill with tip</dt><dd id="sum"></dd></div><div><dt>Per person</dt><dd id="each"></dd></div></dl></section>
</main>
<script>
const money = new Intl.NumberFormat(navigator.language, { style: 'currency', currency: 'EUR' })
let tip = 15
const $ = (id) => document.getElementById(id)
const show = () => {
  const total = Number($('total').value.replace(',', '.')) || 0
  const people = Math.max(1, Math.round(Number($('people').value) || 1))
  const withTip = total * (1 + tip / 100)
  const each = $('round').checked ? Math.ceil(withTip / people) : withTip / people
  $('tip').textContent = money.format(total * tip / 100)
  $('sum').textContent = money.format(withTip)
  $('each').textContent = money.format(each)
}
$('tips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return
  tip = Number(b.dataset.tip)
  for (const o of $('tips').children) o.setAttribute('aria-checked', String(o === b))
  show()
})
for (const id of ['total', 'people', 'round']) $(id).addEventListener('input', show)
$('reset').addEventListener('click', () => { $('total').value = ''; $('people').value = '2'; show() })
show()
</script></body></html>`

registerScenario(/^smoke-d6: build the tip splitter/, [
  { kind: 'tool', name: 'build_app', input: { name: 'Tip splitter', description: 'Splits a bill and the tip.', html: TIP_APP } },
  { kind: 'text', text: 'Here it is: type the total, pick a tip and how many of you there are.' },
])

registerScenario(/^smoke-d6: build an app/, [
  { kind: 'tool', name: 'build_app', input: { name: 'Tip splitter', description: 'Splits a bill with a tip.', html: PROBE_APP } },
  { kind: 'text', text: 'Here is a draft. Try it, then press Save.' },
])

const fakeCtx = (asked: unknown[], answer: AgentRequestResponse | null = null): ClientToolContext => ({
  chatId: 'smoke-d6-chat',
  companionId: 'shared',
  isPrivate: false,
  isRoutine: false,
  signal: new AbortController().signal,
  emit: () => undefined,
  ask: async <R extends AgentRequestResponse>(event: unknown) => {
    asked.push(event)
    return answer as R
  },
})

function fixtureCsv(): string {
  const dir = mkdtempSync(join(tmpdir(), 'apex-smoke-d6-csv-'))
  const path = join(dir, 'harvest.csv')
  writeFileSync(path, 'Crop;Kilos;Price per kilo;Field\nApples;1200;1.85;North\nPears;640;2.1;East\nPlums;;3.4;South\n', 'utf8')
  return path
}

async function importFixture(ctx: SmokeContext): Promise<TableSummary> {
  process.env.APEX_SMOKE_TABLE_CSV = fixtureCsv()
  const preview = await ctx.chrome.invoke<CsvPreview>('tables', 'pickCsv')
  return ctx.chrome.invoke<TableSummary>('tables', 'confirmImport', preview.token, { name: `harvest ${Date.now() % 100000}`, columns: preview.columns })
}

async function withFlags<T>(ctx: SmokeContext, fn: () => Promise<T>): Promise<T> {
  const before = await ctx.chrome.invoke<FlagState[]>('flags', 'list')
  try {
    return await fn()
  } finally {
    // Parents first, so no child is refused while its parent is still off.
    for (const f of [...before].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)))) await ctx.chrome.invoke('flags', 'set', f.id, f.locked ? f.default : f.value).catch(() => undefined)
  }
}

async function withSuggestions<T>(ctx: SmokeContext, fn: () => Promise<T>): Promise<T> {
  const before = await ctx.chrome.invoke<SiteSuggestionSettings>('siteSuggestions', 'settings')
  try {
    return await fn()
  } finally {
    await ctx.chrome.invoke('siteSuggestions', 'update', before)
  }
}

function suggestionPage(ctx: SmokeContext): string {
  ctx.server.page('/d6-orchard', '<!doctype html><title>Orchard board</title><h1>Orchard board</h1><p>Harvest plan for the week.</p>')
  return `${ctx.server.http}/d6-orchard`
}

function fakeHelperPath(): string {
  // A packaged run has no tests/ inside its asar: smoke-packaged.mjs points APEX_SMOKE_FIXTURES at the repo's.
  return join(process.env.APEX_SMOKE_FIXTURES ?? join(app.getAppPath(), 'tests', 'fixtures'), 'calendar', 'fake-helper.mjs')
}

export const checks: SmokeCheck[] = [
  {
    name: 'a scripted build_app makes a draft, Save makes it current, and the sandbox blocks network and pop-ups',
    async run(ctx) {
      const id = ctx.host.start('smoke-d6: build an app for tips')
      await waitFor(() => ctx.host.view(id).log.some((e) => e.type === 'app-built'), 'the app-built card', 10_000)
      const built = ctx.host.view(id).log.find((e): e is Extract<AgentEvent, { type: 'app-built' }> => e.type === 'app-built')
      assert(built, 'no app-built event')
      const draft = await ctx.chrome.invoke<AppSummary>('apps', 'get', built.appId)
      assert(draft.draftVersionId === built.versionId && draft.currentVersionId === null, 'the draft is not waiting to be saved')
      const saved = await ctx.chrome.invoke<AppSummary>('apps', 'saveDraft', built.appId, built.versionId)
      assert(saved.currentVersionId === built.versionId, 'Save did not make the draft current')

      await ctx.chrome.invoke('apps', 'open', built.appId)
      const tab = await (async () => {
        let found: ReturnType<SmokeContext['tabs']['all']>[number] | undefined
        await waitFor(() => (found = ctx.tabs.all().find((t) => t.view.webContents.getURL().startsWith(`apex-app://${built.appId}`))) !== undefined, 'the app tab')
        return found!
      })()
      // The response carries the strict CSP (the app's session exists once the app has opened).
      const response = await session.fromPartition(`${APEX_APP_PARTITION_PREFIX}${built.appId}`).fetch(`apex-app://${built.appId}/`)
      assert(response.headers.get('content-security-policy') === APP_CSP, 'the app response lacks the CSP header')
      // APP-UI: Apex UI first in the head, in the colours of the companion that built it.
      const served = await response.text()
      assert(/<head>\s*<style data-apex-ui>/.test(served) && served.includes('@layer apex.tokens') && served.includes('--companion-accent-light:'), 'the app is served without Apex UI and its companion’s accent')
      assert(tab.sandbox !== undefined, 'the app tab is not in its sandbox session')
      await waitFor(() => tab.view.webContents.getTitle().startsWith('net:'), 'the probe to report')
      assert(tab.view.webContents.getTitle() === 'net:blocked popup:blocked', `the sandbox let something through: ${tab.view.webContents.getTitle()}`)
      ctx.tabs.close(tab.id)
      await ctx.chrome.invoke('apps', 'remove', built.appId).catch(() => undefined)
    },
  },
  {
    name: 'a CSV imports with inferred types; list_tables and query_table read it; a DELETE asks as destructive and Deny keeps the rows',
    async run(ctx) {
      const table = await importFixture(ctx)
      assert(table.rowCount === 3, `expected 3 rows, got ${table.rowCount}`)
      assert(table.columns.map((c) => c.type).join(',') === 'TEXT,INTEGER,REAL,TEXT', `types were ${table.columns.map((c) => c.type).join(',')}`)
      const asked: unknown[] = []
      const ctxShared = fakeCtx(asked, { kind: 'table-write', allowed: false, scope: 'once' })
      const listed = await clientTool('list_tables')!.run({}, ctxShared)
      assert(listed.content.includes(table.name), 'list_tables misses the table')
      const read = await clientTool('query_table')!.run({ sql: `SELECT SUM(kilos) AS total FROM ${table.name}` }, ctxShared)
      assert(!read.isError && read.content.includes('1840'), `query_table answered ${read.content}`)
      const write = await clientTool('write_table')!.run({ sql: `DELETE FROM ${table.name}`, scope: 'companion' }, ctxShared)
      assert(write.isError === true, 'a denied DELETE still ran')
      assert(asked.length === 1 && (asked[0] as { destructive?: boolean }).destructive === true, 'the DELETE card was not destructive')
      assert((await ctx.chrome.invoke<TableSummary>('tables', 'get', table.id)).rowCount === 3, 'Deny changed the table')
      for (const sql of [`ATTACH DATABASE '/tmp/x.sqlite' AS x`, 'PRAGMA table_info(x)']) {
        const refused = await clientTool('query_table')!.run({ sql }, ctxShared)
        assert(refused.isError === true, `${sql} was not refused`)
      }
      await ctx.chrome.invoke('tables', 'remove', table.id)
    },
  },
  {
    name: 'a child flag is locked while its parent is off; a restart flag raises the banner',
    async run(ctx) {
      await withFlags(ctx, async () => {
        const off = await ctx.chrome.invoke<FlagState[]>('flags', 'set', 'tables', 'off')
        const child = off.find((f) => f.id === 'tables-agent-writes')
        assert(child?.locked === true && child.value === 'off', 'tables-agent-writes is not locked')
        await ctx.chrome.invoke('flags', 'set', 'tables', 'on')
        const restart = (await ctx.chrome.invoke<FlagState[]>('flags', 'list')).find((f) => f.requiresRestart)
        assert(restart, 'no restart-required flag')
        const after = await ctx.chrome.invoke<FlagState[]>('flags', 'set', restart.id, restart.values.find((v) => v !== restart.value) ?? restart.value)
        assert(after.find((f) => f.id === restart.id)?.pendingRestart === true, 'the restart flag is not pending')
        ctx.tabs.openInternal('apex://flags')
        await ctx.chrome.until(`return document.querySelector('.pl-flags') && document.body.innerText.includes('Relaunch')`, 8000, 'the relaunch banner')
      })
    },
  },
  {
    name: 'the calendar card shows unavailable without a helper; with the fake helper calendar_events returns fixture events',
    async run(ctx) {
      const before = process.env.APEX_CALENDAR_HELPER
      try {
        process.env.APEX_CALENDAR_HELPER = join(tmpdir(), 'no-such-calendar-helper')
        const missing = await ctx.chrome.invoke<CalendarStatus>('calendar', 'status')
        assert(missing.available === false, 'available without a helper')
        ctx.tabs.openInternal('apex://settings/permissions')
        await ctx.chrome.until(`return document.querySelector('.pl-access') && document.body.innerText.includes(${JSON.stringify(`Not available in this version of ${BRAND_NAME}`)})`, 8000, 'the unavailable state')

        process.env.APEX_CALENDAR_HELPER = fakeHelperPath()
        const on = await ctx.chrome.invoke<CalendarStatus>('calendar', 'setEnabled', 'events', true)
        assert(on.available && on.events === 'granted' && on.enabled.events, 'the fake helper did not grant events')
        const result = await clientTool('calendar_events')!.run({}, fakeCtx([]))
        assert(!result.isError && result.content.includes('Team stand-up'), `calendar_events answered ${result.content.slice(0, 200)}`)
        assert((await ctx.chrome.invoke<boolean>('transcription', 'calendarAvailable')) === true, 'the calendar source was not set')
        await ctx.chrome.invoke('calendar', 'setEnabled', 'events', false)
      } finally {
        if (before === undefined) delete process.env.APEX_CALENDAR_HELPER
        else process.env.APEX_CALENDAR_HELPER = before
        await ctx.chrome.invoke('calendar', 'status').catch(() => undefined)
      }
    },
  },
  {
    name: 'site suggestions are off by default; once on, the fixture host offers tasks that draft into a chat; snooze and off-for-site hide it',
    async run(ctx) {
      await withSuggestions(ctx, async () => {
        const url = suggestionPage(ctx)
        const tab = ctx.tabs.create(url, { activate: true })
        await waitFor(() => tab.view.webContents.getURL() === url && !tab.view.webContents.isLoading(), 'the fixture page')
        await ctx.chrome.invoke('siteSuggestions', 'update', { enabled: false, offSites: [], snoozedUntil: null })
        assert((await ctx.chrome.invoke<SiteSuggestion | null>('siteSuggestions', 'current', tab.id)) === null, 'a suggestion while off')
        // Open in app needs no opt-in; smoke records the launch instead of making it.
        assert((await ctx.chrome.invoke<{ app: string } | null>('siteSuggestions', 'appLink', tab.id))?.app === 'Apex Test App', 'no app link for the fixture host')
        assert((await ctx.chrome.invoke<boolean>('siteSuggestions', 'openInApp', tab.id)) === true && smokeOpened.some((u) => u.startsWith('apex-smoke://open/d6-orchard')), 'open in app did not run')

        await ctx.chrome.invoke('siteSuggestions', 'update', { enabled: true })
        const suggestion = await ctx.chrome.invoke<SiteSuggestion | null>('siteSuggestions', 'current', tab.id)
        assert(suggestion && suggestion.kind === 'app-link' && suggestion.tasks.length > 0, 'no suggestion once on')
        const chatId = await ctx.chrome.invoke<string>('siteSuggestions', 'draft', tab.id, suggestion.tasks[0]!.id, 'new')
        assert(typeof chatId === 'string' && chatId.length > 0, 'drafting returned no chat')

        await ctx.chrome.invoke('siteSuggestions', 'dismiss', tab.id, { snoozeUntil: Date.now() + 60 * 60_000 })
        assert((await ctx.chrome.invoke<SiteSuggestion | null>('siteSuggestions', 'current', tab.id)) === null, 'snooze did not hide it')
        await ctx.chrome.invoke('siteSuggestions', 'update', { snoozedUntil: null })
        await ctx.chrome.invoke('siteSuggestions', 'dismiss', tab.id, 'site')
        assert((await ctx.chrome.invoke<SiteSuggestion | null>('siteSuggestions', 'current', tab.id)) === null, 'off for this site did not hide it')
        ctx.tabs.close(tab.id)
      })
    },
  },
  {
    name: 'WA-01: a tab saves as a web app with its manifest name, start page and icon; opening it goes back to its tab, else a new one; Workspace › Apps lists it',
    async run(ctx) {
      // A 1×1 PNG: the manifest's icon.
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
      ctx.server.route('/d-wa/icon.png', (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' }).end(png)
      })
      ctx.server.route('/d-wa/manifest.json', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/manifest+json' }).end(JSON.stringify({ name: 'Orchard planner', short_name: 'Orchard', start_url: '/d-wa/app/', icons: [{ src: '/d-wa/icon.png', sizes: '192x192', type: 'image/png' }] }))
      })
      const page = (title: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="manifest" href="/d-wa/manifest.json"></head><body><h1>${title}</h1></body></html>`
      ctx.server.page('/d-wa/app/', page('Orchard'))
      ctx.server.page('/d-wa/app/board', page('Board - Orchard planner'))
      // The only app on its site owns every page there, so earlier checks' tabs on the fixture server would
      // count as its tab: they go, leaving the person this describes, with no other tab on the site.
      const fixture = new URL(ctx.server.http).origin
      for (const w of core()?.windows.all() ?? []) {
        for (const t of [...w.tabs.all()]) if (w.tabs.all().length > 1 && /^https?:/.test(w.tabs.info(t).url) && new URL(w.tabs.info(t).url).origin === fixture) w.tabs.close(t.id)
      }
      const tab = ctx.tabs.create(`${ctx.server.http}/d-wa/app/board`, { activate: true })
      await waitFor(() => !tab.view.webContents.isLoading() && tab.view.webContents.getTitle().startsWith('Board'), 'the page to load')
      const saved = await ctx.chrome.invoke<WebApp>('webApps', 'saveTab', tab.id)
      try {
        assert(saved.name === 'Orchard', `the app is named ${saved.name}, not the manifest's short name`)
        assert(saved.url === `${ctx.server.http}/d-wa/app/`, `the app opens at ${saved.url}, not the manifest's start page`)
        assert(saved.icon?.startsWith('data:image/png;base64,'), 'the manifest icon was not kept')
        const again = await ctx.chrome.invoke<WebApp>('webApps', 'saveTab', tab.id)
        assert(again.id === saved.id, 'saving the same page twice made a second app')

        // Its tab is open: opening the app goes back to it, from a tab off its site.
        const other = ctx.tabs.create('about:blank', { activate: true })
        const count = ctx.tabs.all().length
        await ctx.chrome.invoke('webApps', 'open', saved.id)
        await waitFor(() => ctx.tabs.activeId() === tab.id, 'the app’s own tab to come back')
        assert(ctx.tabs.all().length === count, 'opening the app made a new tab while its tab was open')

        // Its tab is closed: opening it makes one at its start page.
        ctx.tabs.close(tab.id)
        await ctx.chrome.invoke('webApps', 'open', saved.id)
        await waitFor(() => ctx.tabs.active()?.view.webContents.getURL() === saved.url, 'a new tab at the app’s start page')
        const reopened = ctx.tabs.active()!
        ctx.tabs.activate(other.id)
        await ctx.chrome.invoke('webApps', 'open', saved.id)
        await waitFor(() => ctx.tabs.activeId() === reopened.id, 'the new tab to be reused')
        ctx.tabs.close(other.id)

        ctx.tabs.openInternal('apex://workspace/apps')
        await ctx.chrome.until(`return [...document.querySelectorAll('.wa-tile')].some((el) => el.textContent.includes('Orchard')) || null`, 8000, 'the app in Workspace › Apps')
        await ctx.shot('workspace-web-apps')
        ctx.tabs.close(reopened.id)
      } finally {
        await ctx.chrome.invoke('webApps', 'remove', saved.id).catch(() => undefined)
      }
    },
  },
  {
    name: 'APP-UI: an app built with Apex UI passes the design check, and build_app looks at its draft in light and dark',
    async run(ctx) {
      assert(lintAppDesign(TIP_APP).length === 0, `the sample app fails the design check: ${lintAppDesign(TIP_APP).join(' ')}`)
      const id = ctx.host.start('smoke-d6: build the tip splitter')
      await waitFor(() => ctx.host.view(id).log.some((e) => e.type === 'app-built'), 'the app-built card', 10_000)
      const built = ctx.host.view(id).log.find((e): e is Extract<AgentEvent, { type: 'app-built' }> => e.type === 'app-built')!
      try {
        assert(appsSmoke.preview, 'the preview is not wired')
        const preview = await appsSmoke.preview(built.appId, built.versionId)
        assert(preview.images.length === 2, `the preview has ${preview.images.length} images, not light and dark`)
        assert(preview.images[0]!.data !== preview.images[1]!.data, 'light and dark look the same')
        assert(preview.errors.length === 0, `the draft logged errors: ${preview.errors.join('; ')}`)
        if (process.env.APEX_SMOKE_SHOTS) {
          for (const [i, scheme] of (['light', 'dark'] as const).entries()) writeFileSync(join(process.env.APEX_SMOKE_SHOTS, `apps-apex-ui-preview-${scheme}.jpg`), Buffer.from(preview.images[i]!.data, 'base64'))
        }
      } finally {
        await ctx.chrome.invoke('apps', 'remove', built.appId).catch(() => undefined)
      }
    },
  },
  {
    name: 'AP-01: any app shows in the sidebar as just its icon or as a row, or not at all, as the person chooses; Workspace › Apps lists every kind',
    async run(ctx) {
      const before = ctx.settings.get().sidebar.apps
      const made: string[] = []
      try {
        for (const [path, name] of [['/ap/mail', 'Mail'], ['/ap/figma', 'Figma'], ['/ap/notes', 'Notes']] as const) {
          ctx.server.page(path, `<!doctype html><title>${name}</title><h1>${name}</h1>`)
          made.push((await ctx.chrome.invoke<WebApp>('webApps', 'saveUrl', `${ctx.server.http}${path}`, name)).id)
        }
        const [mail, figma, notes] = made as [string, string, string]
        const sidebarHas = (selector: string, name: string): string => `return [...document.querySelectorAll('.side-apps ${selector}')].some((el) => el.getAttribute('aria-label') === 'Open ${name}')`
        // Saved apps stay out of the sidebar until the person puts them there.
        await new Promise((r) => setTimeout(r, 400))
        assert(!(await ctx.chrome.js<boolean>(`${sidebarHas('button', 'Mail')}`)), 'a saved web app showed in the sidebar by itself')

        ctx.settings.update({ sidebar: { apps: [{ ref: `web:${mail}`, show: 'icon' }, { ref: `web:${figma}`, show: 'icon' }, { ref: `web:${notes}`, show: 'row' }] } })
        await ctx.chrome.until(`${sidebarHas('.side-app-icon', 'Figma')} || null`, 5000, 'Figma as an icon in the sidebar')
        assert(await ctx.chrome.js<boolean>(sidebarHas('.side-app-icon', 'Mail')), 'Mail is not an icon')
        assert(await ctx.chrome.js<boolean>(sidebarHas('.side-row', 'Notes')), 'Notes is not a row')
        const order = await ctx.chrome.js<string[]>(`return [...document.querySelectorAll('.side-apps .side-app-icon')].map((el) => el.getAttribute('aria-label'))`)
        assert(order.join() === 'Open Mail,Open Figma', `the icons are in the wrong order: ${order.join()}`)
        await ctx.shot('sidebar-apps')

        // An icon opens its app.
        await ctx.chrome.js(`[...document.querySelectorAll('.side-apps .side-app-icon')].find((el) => el.getAttribute('aria-label') === 'Open Figma').click(); return true`)
        await waitFor(() => ctx.tabs.active()?.view.webContents.getURL() === `${ctx.server.http}/ap/figma`, 'Figma to open from its icon')

        // Out of the sidebar again.
        ctx.settings.update({ sidebar: { apps: [{ ref: `web:${mail}`, show: 'icon' }, { ref: `web:${figma}`, show: 'hidden' }, { ref: `web:${notes}`, show: 'row' }] } })
        await ctx.chrome.until(`return !(${sidebarHas('button', 'Figma').slice(7)}) || null`, 5000, 'Figma to leave the sidebar')

        // The library: every kind under its own heading, with a mark on what's in the sidebar.
        ctx.tabs.openInternal('apex://workspace/apps')
        await ctx.chrome.until(`return document.querySelector('.wa__title') && [...document.querySelectorAll('.wa__title')].map((el) => el.textContent).join('|')`, 8000, 'Workspace › Apps')
        const headings = (await ctx.chrome.js<string>(`return [...document.querySelectorAll('.wa__title')].map((el) => el.textContent).join('|')`)).split('|')
        // A group shows only when it holds something; those that show keep this order.
        const groups = ['Websites', 'From packs', 'Made with your companions']
        assert(headings[0] === 'Websites' && headings.every((h, i) => groups.includes(h) && (i === 0 || groups.indexOf(h) > groups.indexOf(headings[i - 1] as string))), `the library's groups are ${headings.join('|')}`)
        const marks = await ctx.chrome.js<number>(`return document.querySelectorAll('.wa-tile .ap-mark').length`)
        assert(marks === 2, `${marks} tiles are marked as in the sidebar, not 2`)
        await ctx.shot('workspace-apps-library')
        const tab = ctx.tabs.active()
        if (tab) ctx.tabs.close(tab.id)
      } finally {
        ctx.settings.update({ sidebar: { apps: before } })
        for (const t of ctx.tabs.all()) if (t.view.webContents.getURL().includes('/ap/')) ctx.tabs.close(t.id)
        for (const id of made) await ctx.chrome.invoke('webApps', 'remove', id).catch(() => undefined)
      }
    },
  },
  {
    name: 'AP-02: the Packs page has front doors: the sidebar (More, or a row of its own), the main menu, the Extensions menu, Workspace › Apps and Settings › Extensions and packs',
    async run(ctx) {
      // The sidebar: in More by default; shown as its own row, it opens Packs on the destination surface.
      assert(ctx.settings.get().sidebar.destinations.packs === false, 'Packs is a sidebar row by default')
      const packsRow = `[...document.querySelectorAll('.destinations .dest-row')].find((b) => b.textContent.trim() === 'Packs')`
      ctx.settings.update({ sidebar: { destinations: { packs: true } } })
      try {
        await ctx.chrome.until(`return Boolean(${packsRow}) || null`, 5000, 'the Packs row in the sidebar')
        await ctx.chrome.js(`${packsRow}.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); return true`)
        await waitFor(() => ctx.tabs.rail() === 'apex://packs', 'Packs on the destination surface')
        await ctx.chrome.until(`return (document.querySelector('.pane--rail')?.innerText ?? '').includes(${JSON.stringify(`Add apps, games, worlds, skills and looks to ${BRAND_NAME}`)}) || null`, 8000, 'the Packs page saying what a pack is')
        await ctx.shot('packs-from-sidebar')
        ctx.tabs.leaveRail()
      } finally {
        ctx.settings.update({ sidebar: { destinations: { packs: false } } })
      }

      // The main menu's tools and the menu bar's Extensions menu.
      const runMenu = async (target: 'main-menu:tools' | 'extensions', itemId: string): Promise<void> => {
        const owner = menuContributions(target).find((c) => c.build({} as MenuState).some((i) => i.id === itemId))
        assert(owner?.run, `${target} has no ${itemId}`)
        await owner.run(itemId, null)
      }
      const tools = menuContributions('main-menu:tools').flatMap((c) => c.build({} as MenuState))
      assert(tools.some((i) => i.id === 'packs-open' && i.label === 'Packs' && i.icon === 'package'), 'the main menu has no Packs row')
      await runMenu('main-menu:tools', 'packs-open')
      await waitFor(() => ctx.tabs.rail() === 'apex://packs', 'Packs from the main menu')
      ctx.tabs.leaveRail()
      await runMenu('extensions', 'packs-browse')
      await waitFor(() => ctx.tabs.rail() === 'apex://packs?tab=browse', 'Browse from the Extensions menu')
      ctx.tabs.leaveRail()

      // Workspace › Apps: Get more apps, next to New app, opens Discover.
      ctx.tabs.openInternal('apex://workspace/apps')
      const more = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Get more apps')`
      await ctx.chrome.until(`return Boolean(${more}) || null`, 8000, 'Get more apps in Workspace › Apps')
      await ctx.chrome.js(`${more}.click(); return true`)
      await waitFor(() => ctx.tabs.rail() === 'apex://packs?tab=browse', 'Discover from Get more apps')
      ctx.tabs.leaveRail()

      // Settings: Extensions and packs, with Packs first.
      ctx.tabs.openInternal('apex://settings/extensions')
      // Settings may still show the page an earlier check left open, until it switches.
      let seen: { title: string; first: string } | null = null
      await waitFor(
        async () => {
          seen = await ctx.chrome.js<{ title: string; first: string } | null>(
            `const title = document.querySelector('.sp-header__title')?.textContent?.trim()
             const first = document.querySelector('.sp-section h2, .sp-section__title')?.textContent?.trim()
             return title && first ? { title, first } : null`,
          )
          return seen?.title === 'Extensions and packs'
        },
        'Settings › Extensions and packs',
      ).catch(() => assert(false, `Settings shows "${seen?.title}" with "${seen?.first}" first`))
      const settings = seen as unknown as { title: string; first: string }
      assert(settings.first === 'Packs', `Settings shows "${settings.title}" with "${settings.first}" first`)
      const tab = ctx.tabs.active()
      if (tab) ctx.tabs.close(tab.id)
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'workspace-apps',
    async run(ctx) {
      const id = ctx.host.start('smoke-d6: build an app for the shot')
      await waitFor(() => ctx.host.view(id).log.some((e) => e.type === 'app-built'), 'the app-built card', 10_000)
      const built = ctx.host.view(id).log.find((e): e is Extract<AgentEvent, { type: 'app-built' }> => e.type === 'app-built')!
      ctx.tabs.openInternal(`apex://chat/${id}`)
      await new Promise((r) => setTimeout(r, 600))
      await ctx.shot('apps-preview-card')
      await ctx.chrome.invoke('apps', 'saveDraft', built.appId, built.versionId)
      ctx.tabs.openInternal('apex://workspace/apps')
      await ctx.chrome.until(`return document.querySelector('.pl-tile')`, 8000, 'the apps grid')
      await ctx.shot('workspace-apps')
      const detail = await ctx.chrome.invoke<AppSummary & { versions: AppVersion[] }>('apps', 'get', built.appId)
      ctx.tabs.openInternal(`apex://workspace/apps/${detail.id}`)
      await ctx.chrome.js(`document.querySelector('.pl-tile')?.click(); return true`)
      await ctx.chrome.until(`return document.querySelector('.pl-versions')`, 8000, 'the app detail')
      await ctx.shot('workspace-app-detail')
      await ctx.chrome.invoke('apps', 'remove', built.appId).catch(() => undefined)
    },
  },
  {
    name: 'workspace-tables',
    async run(ctx) {
      const table = await importFixture(ctx)
      ctx.tabs.openInternal('apex://workspace/tables')
      await ctx.chrome.until(`return document.querySelector('.pl-list__row')`, 8000, 'the tables list')
      await ctx.shot('workspace-tables')
      await ctx.chrome.js(`document.querySelector('.pl-list__row')?.click(); return true`)
      await ctx.chrome.until(`return document.querySelector('.pl-table__row')`, 8000, 'the table grid')
      await ctx.shot('workspace-table-grid')
      await ctx.chrome.js(`document.querySelector('.pl-th')?.click(); return true`)
      await new Promise((r) => setTimeout(r, 300))
      // Back goes to Files, where the tables are a block.
      await ctx.chrome.js(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Back to Files')?.click(); return true`)
      await ctx.chrome.until(`return (document.querySelector('.ws-page[data-section="files"]') && document.querySelector('.pl-list__row')) || null`, 8000, 'the tables in Files again')
      await ctx.chrome.click(/^Import CSV$/)
      await ctx.chrome.until(`return document.querySelector('.pl-columns')`, 8000, 'the import preview')
      await ctx.shot('tables-import')
      await ctx.chrome.escape()
      await ctx.chrome.invoke('tables', 'remove', table.id)
    },
  },
  {
    name: 'flags-page',
    async run(ctx) {
      await withFlags(ctx, async () => {
        const restart = (await ctx.chrome.invoke<FlagState[]>('flags', 'list')).find((f) => f.requiresRestart)
        if (restart) await ctx.chrome.invoke('flags', 'set', restart.id, restart.values.find((v) => v !== restart.value) ?? restart.value)
        await ctx.chrome.invoke('flags', 'set', 'tables', 'off')
        ctx.tabs.openInternal('apex://flags')
        await ctx.chrome.until(`return document.querySelector('.pl-flag--locked')`, 8000, 'the flags page')
        await ctx.shot('flags-page')
      })
    },
  },
  {
    name: 'this-mac-settings',
    async run(ctx) {
      const before = process.env.APEX_CALENDAR_HELPER
      try {
        process.env.APEX_CALENDAR_HELPER = fakeHelperPath()
        await ctx.chrome.invoke('calendar', 'setEnabled', 'events', true)
        ctx.tabs.openInternal('apex://settings/permissions')
        await ctx.chrome.until(`return document.querySelector('.pl-access__row [role="switch"], .pl-access__row input')`, 8000, 'the This Mac card')
        await ctx.chrome.js(`document.querySelector('.pl-access')?.scrollIntoView({ block: 'center' }); return true`)
        await ctx.shot('this-mac-settings')
        await ctx.chrome.invoke('calendar', 'setEnabled', 'events', false)
      } finally {
        if (before === undefined) delete process.env.APEX_CALENDAR_HELPER
        else process.env.APEX_CALENDAR_HELPER = before
      }
    },
  },
  {
    name: 'site-suggestion',
    async run(ctx) {
      await withSuggestions(ctx, async () => {
        await ctx.chrome.invoke('siteSuggestions', 'update', { enabled: true, offSites: [], snoozedUntil: null })
        const tab = ctx.tabs.create(suggestionPage(ctx), { activate: true })
        await ctx.chrome.until(`return document.querySelector('.pl-chip') && document.querySelector('.pl-suggest-btn')`, 8000, 'the open-in-app chip and suggestion button')
        await ctx.shot('toolbar-open-in-app')
        await ctx.chrome.js(`document.querySelector('.pl-suggest-btn')?.click(); return true`)
        await new Promise((r) => setTimeout(r, 500))
        await ctx.shot('site-suggestion-popover')
        await ctx.chrome.escape()
        ctx.tabs.close(tab.id)
      })
    },
  },
]
