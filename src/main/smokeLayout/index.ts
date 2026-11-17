/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import type { ChatSummary } from '@shared/chats'
import type { DecisionsSettings } from '@shared/decisions'
import type { SetupState } from '@shared/onboarding'
import { fileViewerUrl } from '@shared/files'
import { UI } from '@shared/ipc'
import { viewSourceUrl } from '@shared/viewSource'
import { core } from '../app'
import { filesForSmoke } from '../features/files'
import type { SmokeGroup, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { assert, captureWindow, sleep } from '../smokeKit'
import { checkLayout, type LayoutIssue, type LayoutSnapshot } from './check'
import { COLLECT_SCRIPT, SETTLE_SCRIPT } from './collect'
import { LAYOUT_SIZES, layoutPages, sizeLabel, type LayoutPage } from './pages'
import { SMOKE_SERVER } from '../decisions/smokeServer'

// The layout audit (ATELIER_SMOKE_ONLY=layout): every atelier:// page and Settings
// page, every setup step, the new-tab page, a chat page and a chat in the side panel, at
// 900, 1280, 1470 and 1920 wide and at 1280 with the panel open. Each one is
// checked in the chrome's DOM (check.ts) and, with ATELIER_SMOKE_SHOTS, shot
// into <shots>/layout/ with the findings in <shots>/layout-report.json.
// The check fails on any finding unless ATELIER_LAYOUT_REPORT_ONLY=1.
// ATELIER_LAYOUT_PAGES=<regex> narrows the pages (for checking one fix);
// ATELIER_LAYOUT_SNAPSHOTS=1 also keeps each page's box snapshot (layout/*.json).

export interface LayoutReportRow extends LayoutIssue {
  page: string
  size: string
  theme: string
}

const PANEL_SHOWN = `Boolean(document.querySelector('.panel-frame:not([data-state="closing"]) .chat-panel'))`
const SOURCE_FIXTURE = '<!doctype html><title>Layout source</title><main><h1>Layout source</h1><p>A page whose source the layout audit shows.</p></main>'

async function setPanel(ctx: SmokeContext, open: boolean): Promise<void> {
  if ((await ctx.chrome.js<boolean>(`return ${PANEL_SHOWN}`)) === open) return
  ctx.chrome.ui.send(UI.command, 'toggle-agent')
  await ctx.chrome.until(`return ${open ? '' : '!'}${PANEL_SHOWN}`, 5000, open ? 'the side panel to open' : 'the side panel to close')
}

async function settle(ctx: SmokeContext, maxMs: number): Promise<void> {
  await sleep(150)
  await ctx.chrome.js(SETTLE_SCRIPT.replace('__MAX__', String(maxMs)))
}

async function show(ctx: SmokeContext, page: LayoutPage, blankId: string): Promise<void> {
  // A setup step: setup moves there first (finish puts it back), then the page opens on it.
  if (page.welcomeStep) await ctx.chrome.invoke('onboarding', 'goTo', page.welcomeStep)
  if (page.url === null) ctx.tabs.activate(blankId)
  else ctx.tabs.openInternal(page.url)
  // Shots must not depend on where the OS cursor happens to rest: no tooltips in them.
  const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
  if (win && !win.window.isDestroyed() && win.overlay.attached) win.overlay.closeAll((s) => s === 'tooltip')
  await settle(ctx, 4000)
  // The intro's dawn holds still for a second before the companion rises: check (and shoot) the step it lands on.
  if (page.welcomeStep === 'intro') {
    await ctx.chrome.js(INTRO_DONE_SCRIPT)
    await settle(ctx, 2000)
  }
}

/** Waits (at most 4 s) until the welcome page's opening has played. */
const INTRO_DONE_SCRIPT = String.raw`
return (async () => {
  const start = Date.now()
  while (Date.now() - start < 4000) {
    if ([...document.querySelectorAll('.wl[data-intro]')].every((wl) => wl.getAttribute('data-intro') === 'done')) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
})()
`

/** One line per finding, for the console and a failure message. */
export function formatRow(r: LayoutReportRow): string {
  return `${r.page} @ ${r.size}: ${r.kind} ${r.selector}${r.count > 1 ? ` (x${r.count})` : ''} "${r.text}" (${r.detail})`
}

interface Audit {
  window: BrowserWindow
  before: { size: number[]; tabs: Set<string>; active: string | null; setupStep: SetupState['step'] | null; decisions: DecisionsSettings }
  pages: LayoutPage[]
  blankId: string
  removeFile: () => Promise<void>
  rows: LayoutReportRow[]
  dir: string | undefined
  theme: string
  keep: boolean
}

let audit: Audit | null = null
// The harness gives each check 90 s and moves on when one runs over; chaining keeps a slow chunk from overlapping the next.
let chain: Promise<unknown> = Promise.resolve()
function serial(run: () => Promise<void>): Promise<void> {
  const next = chain.then(run)
  chain = next.catch(() => undefined)
  return next
}

async function setUp(ctx: SmokeContext): Promise<void> {
  const dir = process.env.ATELIER_SMOKE_SHOTS
  const only = process.env.ATELIER_LAYOUT_PAGES ? new RegExp(process.env.ATELIER_LAYOUT_PAGES) : null
  const window = BrowserWindow.fromWebContents(ctx.chrome.ui)
  assert(window, 'no browser window')
  if (dir) mkdirSync(join(dir, 'layout'), { recursive: true })
  const setupStep = (await ctx.chrome.invoke<SetupState>('onboarding', 'state').catch(() => null))?.step ?? null
  const before = { size: window.getContentSize(), tabs: new Set(ctx.tabs.all().map((t) => t.id)), active: ctx.tabs.active()?.id ?? null, setupStep, decisions: ctx.settings.get().decisions }
  // Settings › Quick decisions lays out set up, its fullest form (smoke's stand-in model answers offline).
  ctx.settings.update({ decisions: SMOKE_SERVER })
  const listed = ctx.chats
    .list()
    .filter((c) => !c.archived && !c.routineId)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  const chatId = listed?.id ?? (await ctx.chrome.invoke<ChatSummary>('chats', 'create', {})).id
  const companionId = await ctx.chrome.invoke<string>('companions', 'activeId').catch(() => null)
  ctx.server.page('/layout-source', SOURCE_FIXTURE)
  const files = filesForSmoke()
  const ref = files?.library.addGenerated({ chatId, companionId: companionId ?? 'pip', name: 'layout-notes.md', mediaType: 'text/markdown', bytes: Buffer.from('# Layout notes\n\nA file the layout audit opens.\n') }) ?? null
  const pages = layoutPages({
    chatId,
    companionId,
    fileUrl: ref ? fileViewerUrl({ kind: 'library', id: ref.id }, { name: ref.name }) : null,
    sourceUrl: viewSourceUrl(`${ctx.server.http}/layout-source`),
  }).filter((p) => !only || only.test(p.name))
  const blank = ctx.tabs.create()
  ctx.tabs.leaveRail()
  await setPanel(ctx, false)
  audit = {
    window,
    before,
    pages,
    blankId: blank.id,
    removeFile: async () => {
      if (ref) await files?.services.files.remove(ref.id).catch(() => undefined)
    },
    rows: [],
    dir,
    theme: process.env.ATELIER_SMOKE_THEME === 'dark' ? 'dark' : 'light',
    keep: process.env.ATELIER_LAYOUT_SNAPSHOTS === '1',
  }
}

/** Checks pages [from, to) of the full list at one size. */
async function auditChunk(ctx: SmokeContext, sizeIndex: number, from: number, to: number): Promise<void> {
  const a = audit
  assert(a, 'the layout audit did not set up')
  const size = LAYOUT_SIZES[sizeIndex]!
  const [w0, h0] = a.window.getContentSize()
  if (w0 !== size.width || (h0 !== size.height && from === 0)) {
    a.window.setContentSize(size.width, size.height)
    await settle(ctx, 2000)
  }
  await setPanel(ctx, size.panel)
  const [width = size.width, height = size.height] = a.window.getContentSize()
  const label = sizeLabel(width, height, size.panel)
  const names = new Set(ALL_PAGE_NAMES.slice(from, to))
  for (const page of a.pages.filter((p) => names.has(p.name))) {
    await show(ctx, page, a.blankId)
    // Opening a chat as a page can take it out of the panel: put the panel back.
    if (size.panel && !(await ctx.chrome.js<boolean>(`return ${PANEL_SHOWN}`))) {
      await setPanel(ctx, true)
      await settle(ctx, 3000)
    }
    const snap = await ctx.chrome.js<LayoutSnapshot>(COLLECT_SCRIPT)
    if (a.dir && a.keep) writeFileSync(join(a.dir, 'layout', `${page.name}@${label}-${a.theme}.json`), JSON.stringify(snap))
    for (const issue of checkLayout(snap)) a.rows.push({ page: page.name, size: label, theme: a.theme, ...issue })
    if (a.dir) writeFileSync(join(a.dir, 'layout', `${page.name}@${label}-${a.theme}.png`), (await captureWindow(ctx.chrome.ui, ctx.tabs)).toPNG())
  }
  if (a.dir) writeFileSync(join(a.dir, 'layout-report.json'), JSON.stringify(a.rows, null, 1))
}

async function finish(ctx: SmokeContext): Promise<void> {
  const a = audit
  assert(a, 'the layout audit did not set up')
  audit = null
  try {
    await setPanel(ctx, false).catch(() => undefined)
    ctx.tabs.leaveRail()
    // A copy: closing splices the live list, which would skip every other tab.
    for (const tab of [...ctx.tabs.all()]) if (!a.before.tabs.has(tab.id)) ctx.tabs.close(tab.id)
    if (a.before.active && ctx.tabs.all().some((t) => t.id === a.before.active)) ctx.tabs.activate(a.before.active)
    await a.removeFile()
    if (a.before.setupStep) await ctx.chrome.invoke('onboarding', 'save', { step: a.before.setupStep }).catch(() => undefined)
    ctx.settings.update({ decisions: a.before.decisions })
    a.window.setContentSize(a.before.size[0] ?? 1440, a.before.size[1] ?? 900)
    await sleep(300)
  } finally {
    if (a.dir) writeFileSync(join(a.dir, 'layout-report.json'), JSON.stringify(a.rows, null, 1))
  }
  const rows = a.rows
  console.log(`layout: ${rows.length} findings over ${a.pages.length} pages x ${LAYOUT_SIZES.length} sizes (${a.theme})${a.dir ? `, report in ${join(a.dir, 'layout-report.json')}` : ''}`)
  if (rows.length > 0 && process.env.ATELIER_LAYOUT_REPORT_ONLY !== '1') {
    const shown = rows.slice(0, 20).map(formatRow).join('\n')
    throw new Error(`${rows.length} layout findings:\n${shown}${rows.length > 20 ? `\n... and ${rows.length - 20} more` : ''}`)
  }
}

/** Every page name the audit can visit, in order; chunks are slices of it so the check list is fixed up front. */
const ALL_PAGE_NAMES = layoutPages({ chatId: 'x', companionId: 'x', fileUrl: 'x', sourceUrl: 'x' }).map((p) => p.name)
const CHUNK = 12

const checks: SmokeCheck[] = [{ name: 'layout: set up the pages', run: (ctx) => serial(() => setUp(ctx)) }]
LAYOUT_SIZES.forEach((size, si) => {
  for (let from = 0; from < ALL_PAGE_NAMES.length; from += CHUNK) {
    const to = Math.min(from + CHUNK, ALL_PAGE_NAMES.length)
    checks.push({ name: `layout: ${sizeLabel(size.width, size.height, size.panel)} pages ${from + 1}-${to}`, run: (ctx) => serial(() => auditChunk(ctx, si, from, to)) })
  }
})
checks.push({ name: 'layout: every page lays out at every width', run: (ctx) => serial(() => finish(ctx)) })

export const layoutSmoke: SmokeGroup = {
  group: 'LAYOUT',
  checks,
  shots: [],
}
