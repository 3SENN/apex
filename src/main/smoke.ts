/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync } from 'node:fs'
import { BrowserWindow, app, nativeImage, type WebContents } from 'electron'
import type { CompanionPreset } from '@shared/companion'
import type { ViewportInfo } from '@shared/ipc'
import { NOT_EXECUTED, runToolCalls, type ResultBlock } from './agent/browserTool'
import type { AgentHost } from './agent/host'
import type { AgentSession } from './agent/session'
import type { ChatStore } from './chats'
import type { DownloadManager } from './downloads'
import type { HistoryStore } from './history'
import type { MemoryService } from './memory'
import type { PageBridge } from './pageBridge'
import type { PeekManager } from './peek'
import type { SettingsStore } from './settings'
import { runBaseChecks } from './smokeBase'
import { runFirstWeekChecks } from './smokeFirstWeek'
import { runPresenceChecks } from './smokePresence'
import type { SmokeClient } from './smokeClient'
import { Chrome, assert, waitFor } from './smokeKit'
import { captureTour } from './smokeShots'
import { runSmokeGroups } from './smokeGroups'
import { startSmokeServer, tlsFixtureDir } from './smokeServer'
import type { BookmarkStore, ConnectorStore, RoutineStore, SkillStore } from './stores'
import type { TabManager } from './tabs'
import type { ChromeWindow } from './window'

// End-to-end check of the agent's browser plumbing in real Chromium: the
// page preload, refs, trusted input, screenshots, tabs and the approval
// guard. It needs no API key; it calls the executor directly.

// ── network guard ──
// In smoke nothing may leave the machine. The main process's own fetch is
// fenced from the moment this module loads: a request to any other host is
// refused and recorded, and the run fails on it. Chromium's requests are
// checked from the run's net log by scripts/smoke.mjs.
const smokeExternalFetches: string[] = []
export function isLocalSmokeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h)) return true
  return /\.(test|invalid|localhost|example)$/.test(h)
}
if (process.env.APEX_SMOKE === '1' && typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let host = ''
    try {
      const url = new URL(href)
      host = /^(https?|wss?|ftp):$/.test(url.protocol) ? url.hostname : ''
    } catch {
      host = ''
    }
    if (host && !isLocalSmokeHost(host)) {
      smokeExternalFetches.push(href)
      return Promise.reject(new TypeError(`Smoke runs offline: ${host} is outside this machine.`))
    }
    return realFetch(input, init)
  }) as typeof fetch
}

const FIXTURE = `<!doctype html>
<html><head><title>Apex smoke test</title></head>
<body>
<main>
  <h1>Smoke test</h1>
  <form onsubmit="event.preventDefault()">
    <label for="name">Full name</label> <input id="name" name="name">
    <label><input type="checkbox" id="news"> Subscribe to newsletter</label>
    <select id="color" aria-label="Favorite color"><option value="r">Red</option><option value="g">Green</option></select>
    <input type="password" id="pw" aria-label="Password" autocomplete="current-password">
    <button type="button" id="save" onclick="out.textContent = 'saved:' + document.getElementById('name').value">Save</button>
    <button type="button" id="order" onclick="out.textContent = 'ordered'">Place order</button>
  </form>
  <p id="out">idle</p>
  <a href="/second">Second page</a>
  <a href="/second" target="_blank" id="aside">Second page in a new tab</a>
  <a href="/report.txt" id="dl">Download report</a>
  <div style="height: 4000px">Tall content</div>
</main>
</body></html>`

const SECOND = '<!doctype html><title>Second page</title><h1>Second page</h1>'

interface SmokeDeps {
  /** The chrome UI's webContents. */
  ui: WebContents
  tabs: TabManager
  /** A draft session whose executor the browser checks drive directly. */
  agent: AgentSession
  /** Every chat's session, for the core chat checks. */
  host: AgentHost
  /** The offline stand-in the chats talk to. */
  client: SmokeClient
  bridge: PageBridge
  memory: MemoryService
  bookmarks: BookmarkStore
  downloads: DownloadManager
  peek: PeekManager
  settings: SettingsStore
  skills: SkillStore
  routines: RoutineStore
  connectors: ConnectorStore
  chats: ChatStore
  history: HistoryStore
  windowState: ChromeWindow
}

function textOf(blocks: ResultBlock[]): string {
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
}

interface CompanionStats {
  ready: number
  errors: string[]
}

/** Polls the chrome's companion test hook until a companion drew a frame or reported an error. */
async function companionStats(ui: WebContents, timeoutMs: number): Promise<CompanionStats | null> {
  const start = Date.now()
  let stats: CompanionStats | null = null
  while (Date.now() - start < timeoutMs) {
    const raw: unknown = await ui.executeJavaScript('JSON.stringify(window.__apexCompanionStats ?? null)')
    stats = typeof raw === 'string' ? (JSON.parse(raw) as CompanionStats | null) : null
    if (stats && (stats.ready > 0 || stats.errors.length > 0)) return stats
    await new Promise((r) => setTimeout(r, 200))
  }
  return stats
}

/** Uncaught main-process errors during the run (index.ts); each one fails the run. */
export const smokeUncaught: string[] = []

export async function runSmoke(deps: SmokeDeps): Promise<number> {
  const { ui, tabs, agent, bridge, memory, bookmarks, downloads, peek } = deps
  const chrome = new Chrome(ui)
  const server: Server = createServer((req, res) => {
    if (req.url === '/report.txt') {
      res.setHeader('content-type', 'text/plain')
      res.setHeader('content-disposition', 'attachment; filename="report.txt"')
      res.end('quarterly numbers')
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(req.url === '/second' ? SECOND : FIXTURE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  // Which WebGL the run has: where it is software (a CI machine without a GPU), 3D checks take longer.
  // Vendor 0x1414 is Microsoft's software driver.
  const gpu = (await app.getGPUInfo('basic').catch(() => null)) as { gpuDevice?: Array<{ active?: boolean; vendorId?: number; deviceId?: number; vendorString?: string; deviceString?: string }>; auxAttributes?: { glRenderer?: string } } | null
  const device = gpu?.gpuDevice?.find((d) => d.active) ?? gpu?.gpuDevice?.[0]
  const hex = (n: number | undefined): string => `0x${(n ?? 0).toString(16)}`
  const named = gpu?.auxAttributes?.glRenderer || [device?.vendorString, device?.deviceString].filter(Boolean).join(' ')
  console.log(`smoke: WebGL ${app.getGPUFeatureStatus().webgl}; ${named || (device ? `GPU vendor ${hex(device.vendorId)}, device ${hex(device.deviceId)}` : 'GPU unknown')}`)
  const results: Array<{ name: string; ok: boolean; detail: string }> = []
  const signal = new AbortController().signal
  const call = (name: string, input: unknown): Promise<ResultBlock[]> => agent.executor.execute(name, input, signal)
  // Each check gets a time limit, so one stuck check fails on its own instead
  // of stalling the whole run; results print as they land.
  const limitMs = Number(process.env.APEX_SMOKE_CHECK_MS) || 90_000
  // A long check (the screenshot tour) passes its own, larger limit.
  const check = async (name: string, fn: () => Promise<string>, ownLimitMs?: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    const limit = Math.max(limitMs, ownLimitMs ?? 0)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${limit / 1000}s`)), limit)
    })
    try {
      results.push({ name, ok: true, detail: await Promise.race([fn(), timeout]) })
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
      // APEX_SMOKE_STACK=1 prints where a failing check threw, for chasing a flaky one.
      if (process.env.APEX_SMOKE_STACK && err instanceof Error) console.log(err.stack)
    } finally {
      clearTimeout(timer)
    }
    const r = results[results.length - 1]!
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${(r.detail.split('\n')[0] ?? '').slice(0, 160)}` : ''}`)
  }
  const expectError = async (fn: () => Promise<unknown>, pattern: RegExp): Promise<string> => {
    try {
      await fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      assert(pattern.test(message), `unexpected error: ${message}`)
      return message
    }
    throw new Error('expected an error, got success')
  }

  try {
    await waitFor(() => tabs.contentBounds().width > 0 && tabs.active() !== null, 15_000).catch(async (err: unknown) => {
      // Say what the chrome drew, so a render failure is not just a timeout.
      const drawn = String(await ui.executeJavaScript(`(document.getElementById('root')?.innerText ?? '').slice(0, 400)`).catch(() => '(no chrome)'))
      throw new Error(`${err instanceof Error ? err.message : String(err)} Tabs: ${tabs.all().length}, bounds ${JSON.stringify(tabs.contentBounds())}. Chrome shows: ${drawn}`)
    })
    const first = tabs.active()
    assert(first, 'no active tab')
    await first.view.webContents.loadURL(base)
    const wc = first.view.webContents

    let tree = ''
    const ref = (pattern: RegExp): string => {
      const match = tree.match(pattern)
      assert(match?.[1], `no ref matching ${pattern} in:\n${tree}`)
      return match[1]
    }
    const reread = async (): Promise<void> => {
      tree = textOf(await call('read_page', { filter: 'interactive' }))
    }
    const outText = async (): Promise<string> => textOf(await call('get_page_text', {}))

    await check('read_page lists controls with refs', async () => {
      await reread()
      assert(/textbox "Full name" \[ref_\d+\]/.test(tree), `missing textbox:\n${tree}`)
      assert(/button "Save" \[ref_\d+\]/.test(tree), `missing button:\n${tree}`)
      assert(/textbox "Password" \[ref_\d+\] empty/.test(tree), `password field not marked:\n${tree}`)
      return `${tree.split('\n').length} interactive lines`
    })
    await check('form_input fills a textbox', async () => {
      return textOf(await call('form_input', { target: { type: 'ref', ref: ref(/textbox "Full name" \[(ref_\d+)\]/) }, value: 'Ada Lovelace' }))
    })
    await check('left_click on a ref fires the page handler', async () => {
      await call('left_click', { target: { type: 'ref', ref: ref(/button "Save" \[(ref_\d+)\]/) } })
      const text = await outText()
      assert(text.includes('saved:Ada Lovelace'), `page text was:\n${text}`)
      return 'saved:Ada Lovelace'
    })
    await check('form_input toggles a checkbox', async () => {
      await call('form_input', { target: { type: 'ref', ref: ref(/checkbox "Subscribe to newsletter" \[(ref_\d+)\]/) }, value: true })
      await reread()
      assert(/checkbox "Subscribe to newsletter" \[ref_\d+\] checked/.test(tree), tree)
      return 'checked'
    })
    await check('form_input selects an option by its text', async () => {
      await call('form_input', { target: { type: 'ref', ref: ref(/combobox "Favorite color" \[(ref_\d+)\]/) }, value: 'Green' })
      await reread()
      assert(/combobox "Favorite color" \[ref_\d+\] value="Green"/.test(tree), tree)
      return 'Green'
    })
    await check('the agent cannot fill password fields', () =>
      expectError(() => call('form_input', { target: { type: 'ref', ref: ref(/textbox "Password" \[(ref_\d+)\]/) }, value: 'hunter2' }), /password/))
    await check('find ranks the matching element first', async () => {
      const found = textOf(await call('find', { query: 'place order button' }))
      assert(found.split('\n')[0]?.includes('"Place order"'), found)
      return found.split('\n')[0] ?? ''
    })
    await check('a consequential click waits for approval and honors a denial', async () => {
      const message = await expectError(() => call('left_click', { target: { type: 'ref', ref: ref(/button "Place order" \[(ref_\d+)\]/) } }), /declined/)
      assert(!(await outText()).includes('ordered'), 'the click went through despite the denial')
      return message
    })
    await check('screenshot matches the viewport', async () => {
      // The chrome can still be settling its layout on a cold start, so a shot
      // taken while the page area moved is retaken once against stable bounds.
      const shoot = async (): Promise<{ size: Electron.Size; moved: boolean }> => {
        const before = tabs.contentBounds()
        const [block] = await call('screenshot', {})
        assert(block?.type === 'image' && block.source.type === 'base64', 'no image block')
        const after = tabs.contentBounds()
        return { size: nativeImage.createFromBuffer(Buffer.from(block.source.data, 'base64')).getSize(), moved: before.width !== after.width || before.height !== after.height }
      }
      let shot = await shoot()
      if (shot.moved) shot = await shoot()
      const { size } = shot
      const bounds = tabs.contentBounds()
      assert(size.width > 0 && size.width <= bounds.width && size.height <= bounds.height, `image ${size.width}x${size.height} vs view ${bounds.width}x${bounds.height}`)
      return `${size.width}x${size.height} (view ${bounds.width}x${bounds.height})`
    })
    await check('scroll down moves the page', async () => {
      await call('scroll', { target: { type: 'coordinate', x: 200, y: 200 }, scroll_direction: 'down', scroll_amount: 5 })
      // The wheel lands within a frame or two on a fast Mac; a slow CI runner can take longer, so it waits for the move.
      let vp = await bridge.request<ViewportInfo>(wc, { op: 'viewport' })
      for (let waited = 0; vp.scrollY === 0 && waited < 3000; waited += 100) {
        await new Promise((r) => setTimeout(r, 100))
        vp = await bridge.request<ViewportInfo>(wc, { op: 'viewport' })
      }
      assert(vp.scrollY > 0, `scrollY is ${vp.scrollY}`)
      return `scrollY=${vp.scrollY}`
    })
    await check('click, key and type edit the focused field', async () => {
      await call('left_click', { target: { type: 'ref', ref: ref(/textbox "Full name" \[(ref_\d+)\]/) } })
      await call('key', { text: 'ctrl+a' })
      await call('type', { text: 'Grace Hopper' })
      await reread()
      assert(/textbox "Full name" \[ref_\d+\] value="Grace Hopper"/.test(tree), tree)
      return 'Grace Hopper'
    })
    await check('input still works when the window does not have focus', async () => {
      for (const win of BrowserWindow.getAllWindows()) win.blur()
      await call('left_click', { target: { type: 'ref', ref: ref(/textbox "Full name" \[(ref_\d+)\]/) } })
      await call('key', { text: 'ctrl+a' })
      await call('type', { text: 'Katherine Johnson' })
      await reread()
      assert(/textbox "Full name" \[ref_\d+\] value="Katherine Johnson"/.test(tree), tree)
      return `focused window: ${BrowserWindow.getFocusedWindow() ? 'yes' : 'none'}`
    })
    await check('navigate reports browser_state and back returns', async () => {
      const blocks = await call('navigate', { url: `${base}second` })
      assert(blocks.some((b) => b.type === 'browser_state'), 'no browser_state after navigation')
      assert(wc.getURL().endsWith('/second'), wc.getURL())
      await call('navigate', { url: 'back' })
      assert(wc.getURL() === base, `back went to ${wc.getURL()}`)
      return 'second → back'
    })
    await check('navigate refuses non-http schemes', async () => {
      await expectError(() => call('navigate', { url: 'javascript:alert(1)' }), /not allowed/)
      return await expectError(() => call('navigate', { url: 'file:///etc/passwd' }), /not allowed/)
    })
    await check('refs go stale after a reload', async () => {
      const oldRef = ref(/textbox "Full name" \[(ref_\d+)\]/)
      await call('navigate', { url: 'reload' })
      return expectError(() => call('form_input', { target: { type: 'ref', ref: oldRef }, value: 'x' }), /stale/)
    })
    await check('a blank tab explains why it cannot be screenshotted', async () => {
      const opened = await call('new_tab', {})
      const change = opened[0]?.type === 'browser_state' ? opened[0].state_changes?.[0] : undefined
      const blankId = change?.type === 'tab_opened' ? change.tab_id : undefined
      try {
        return await expectError(() => call('screenshot', {}), /blank/)
      } finally {
        if (blankId) await call('close_tab', { tab_id: blankId })
        await call('switch_tab', { tab_id: first.id })
      }
    })
    await check('memory tool stores, reads and confines paths', async () => {
      await memory.execute({ command: 'create', path: '/memories/smoke.md', file_text: 'User prefers aisle seats.' })
      const view = await memory.execute({ command: 'view', path: '/memories/smoke.md' })
      assert(view.includes('aisle seats'), view)
      assert(memory.list().some((f) => f.path === '/memories/smoke.md'), 'file not listed')
      await expectError(() => memory.execute({ command: 'view', path: '/memories/../../etc/passwd' }), /escape|Invalid|must start/)
      return 'create, view, list, traversal refused'
    })
    await check('bookmarks toggle on and off', async () => {
      assert(bookmarks.toggle(base, 'Smoke') === true, 'not added')
      assert(bookmarks.findByUrl(base), 'not stored')
      assert(bookmarks.toggle(base, 'Smoke') === false, 'not removed')
      return 'toggled'
    })
    await check('a download lands in the downloads folder', async () => {
      await reread()
      await call('left_click', { target: { type: 'ref', ref: ref(/link "Download report" \[(ref_\d+)\]/) } })
      await waitFor(() => downloads.list().some((d) => d.filename.startsWith('report') && d.state === 'completed'), 10_000)
      const item = downloads.list()[0]
      assert(item && readFileSync(item.path, 'utf8') === 'quarterly numbers', 'download content mismatch')
      return item.filename
    })
    await check('peek opens over the page and closes', async () => {
      // The peek is a card above the page (SH-43): the page stays laid out behind it.
      peek.open(`${base}second`)
      assert(peek.isOpen(), 'the peek did not open')
      await new Promise((r) => setTimeout(r, 500))
      peek.close()
      assert(!peek.isOpen(), 'the peek did not close')
      assert(!tabs.isHidden(), 'the page should be visible')
      return 'opened and closed'
    })
    await check('split view shows two tabs side by side', async () => {
      tabs.openSplit()
      const split = tabs.split()
      assert(split, 'split did not open')
      await waitFor(() => tabs.find(split.secondaryId)?.view.getBounds().width !== 0, 5_000)
      const left = tabs.get(split.primaryId).view.getBounds()
      const right = tabs.get(split.secondaryId).view.getBounds()
      assert(right.x >= left.x + left.width, `panes overlap: ${JSON.stringify({ left, right })}`)
      tabs.closeSplit()
      await new Promise((r) => setTimeout(r, 200))
      return `${left.width}px | ${right.width}px`
    })
    await check('the agent cannot act on Apex pages', async () => {
      tabs.navigate(first.id, 'apex://history')
      const text = textOf(await call('read_page', {}))
      assert(new RegExp(`${BRAND_NAME} page`).test(text), text)
      // Navigating from an Apex page opens a new tab, so the page (often the chat itself) stays put.
      const out = await call('navigate', { url: base })
      const state = out.find((b) => b.type === 'browser_state')
      const opened = state?.type === 'browser_state' ? state.state_changes?.find((c) => c.type === 'tab_opened') : undefined
      assert(opened?.type === 'tab_opened', 'navigate did not report a new tab')
      assert(first.internalUrl !== null, 'navigate replaced the Apex page')
      await expectError(() => call('close_tab', { tab_id: first.id }), new RegExp(`${BRAND_NAME} page`))
      await call('close_tab', { tab_id: opened.tab_id })
      tabs.leaveInternal(first.id)
      tabs.activate(first.id)
      assert(first.internalUrl === null && wc.getURL() === base, 'the tab did not come back to its page')
      return text
    })
    await check('new_tab, list_tabs, switch_tab and close_tab', async () => {
      const before = tabs.all().length
      const shown = tabs.activeId()
      const opened = await call('new_tab', {})
      const state = opened[0]
      assert(opened.length === 1 && state?.type === 'browser_state', 'new_tab must return one browser_state block')
      const change = state.state_changes?.[0]
      assert(change?.type === 'tab_opened', 'missing tab_opened')
      assert(tabs.activeId() === shown, 'new_tab took the person’s tab')
      // Regression: navigating right after new_tab must not lose to the new
      // tab's initial empty document.
      await call('navigate', { url: `${base}second`, tab_id: change.tab_id })
      const text = textOf(await call('get_page_text', { tab_id: change.tab_id }))
      assert(text.includes('Second page'), `new tab shows:\n${text}`)
      const listed = await call('list_tabs', {})
      assert(listed[0]?.type === 'browser_state' && listed[0].tabs.length === before + 1, `expected ${before + 1} tabs`)
      // switch_tab moves the agent, not the person: browser_state marks its tab active.
      await call('switch_tab', { tab_id: first.id })
      const switched = await call('list_tabs', {})
      assert(switched[0]?.type === 'browser_state' && switched[0].tabs.find((t) => t.active)?.tab_id === first.id, 'switch_tab did not move the agent')
      assert(tabs.activeId() === shown, 'switch_tab changed the person’s tab')
      await call('close_tab', { tab_id: change.tab_id })
      assert(tabs.all().length === before, 'close_tab did not close')
      return `opened and closed ${change.tab_id}`
    })
    await check('the agent works out of sight while the person keeps their tab', async () => {
      const shown = tabs.activeId()
      const opened = await call('new_tab', {})
      const change = opened[0]?.type === 'browser_state' ? opened[0].state_changes?.[0] : undefined
      assert(change?.type === 'tab_opened', 'missing tab_opened')
      const own = tabs.get(change.tab_id)
      const extra: string[] = []
      try {
        // No tab_id from here on: calls run in the agent's own tab.
        await call('navigate', { url: base })
        assert(own.view.webContents.getURL() === base, `navigate ran elsewhere: ${own.view.webContents.getURL()}`)
        // It paints (visible to Chromium) with at most one point inside the window.
        const bounds = own.view.getBounds()
        const area = BrowserWindow.fromWebContents(ui)?.getContentBounds() ?? { width: 0, height: 0 }
        const inside = Math.max(0, Math.min(bounds.x + bounds.width, area.width) - Math.max(bounds.x, 0)) * Math.max(0, Math.min(bounds.y + bounds.height, area.height) - Math.max(bounds.y, 0))
        assert(own.view.getVisible() && inside <= 1, `not painting out of sight: ${JSON.stringify(bounds)} in ${area.width}x${area.height}`)
        const [shot] = await call('screenshot', {})
        assert(shot?.type === 'image' && shot.source.type === 'base64', 'no image block')
        const size = nativeImage.createFromBuffer(Buffer.from(shot.source.data, 'base64')).getSize()
        assert(size.width > 0 && size.height > 0, 'empty screenshot')
        await reread()
        await call('left_click', { target: { type: 'ref', ref: ref(/textbox "Full name" \[(ref_\d+)\]/) } })
        await call('type', { text: 'Mary Jackson' })
        await call('left_click', { target: { type: 'ref', ref: ref(/button "Save" \[(ref_\d+)\]/) } })
        const text = await outText()
        assert(text.includes('saved:Mary Jackson'), `the page shows:\n${text}`)
        // A link that opens a tab opens it out of sight too, and the agent goes along.
        const known = new Set(tabs.all().map((t) => t.id))
        await call('left_click', { target: { type: 'ref', ref: ref(/link "Second page in a new tab" \[(ref_\d+)\]/) } })
        await waitFor(() => tabs.all().some((t) => !known.has(t.id)), 5_000)
        const popped = tabs.all().find((t) => !known.has(t.id))
        assert(popped, 'the link opened no tab')
        extra.push(popped.id)
        const listed = await call('list_tabs', {})
        assert(listed[0]?.type === 'browser_state' && listed[0].tabs.find((t) => t.active)?.tab_id === popped.id, 'the agent did not follow the tab its link opened')
        assert(tabs.activeId() === shown, `the agent's work took the person's tab (now ${tabs.activeId()})`)
        return `${size.width}x${size.height} shot, typed, saved and followed a link in ${own.id} while ${shown} stayed in front`
      } finally {
        await call('switch_tab', { tab_id: first.id }).catch(() => undefined)
        for (const id of [own.id, ...extra]) await call('close_tab', { tab_id: id }).catch(() => undefined)
        await reread().catch(() => undefined)
      }
    })
    await check('a failed call halts the rest of the batch', async () => {
      const out = await runToolCalls([
        { id: 'a', name: 'left_click', toolset_name: 'browser', input: { target: { type: 'ref', ref: 'ref_99999' } } },
        { id: 'b', name: 'screenshot', toolset_name: 'browser', input: {} },
      ], { browser: agent.executor }, signal)
      assert(out[0]?.is_error === true && out[0].toolset_name === 'browser', 'first call should fail')
      assert(out[1]?.is_error === true && out[1].content === NOT_EXECUTED, 'second call should not run')
      return String(out[0].content)
    })
    await check('the companion renders in the chrome without errors', async () => {
      const stats = await companionStats(ui, 20_000)
      assert(stats, 'window.__apexCompanionStats was never set')
      assert(stats.errors.length === 0, `companion errors: ${stats.errors.join('; ')}`)
      assert(stats.ready > 0, 'no companion drew a 3D frame')
      return `${stats.ready} ready, no errors`
    })
    await check('the look editor is the card’s ring: bubbles around the figure open parts, faces and colours', async () => {
      // The old Settings editor address opens the active companion's card with the ring.
      tabs.openInternal('apex://settings/companion')
      const bubbles = await chrome.until<number>(`const n = document.querySelectorAll('.co-hero--looking .co-ring__bubble').length; return n > 0 && n`, 20_000, 'the ring of look bubbles')
      const card = tabs.active()
      const lookUrl = card ? tabs.info(card).url : ''
      assert(card && /^apex:\/\/companion\/[^/]+\/general\/look$/.test(lookUrl), `the look editor opened at ${lookUrl}`)
      const open = async (index: number, ready: string, label: string): Promise<number> => {
        await chrome.js(`document.querySelectorAll('.co-ring__bubble')[${index}]?.click(); return true`)
        return chrome.until<number>(`const n = document.querySelectorAll(${JSON.stringify(ready)}).length; return n > 0 && n`, 8000, label)
      }
      const palettes = await open(0, '.co-ring-card .co-ring-tile--swatch, .co-ring-card .co-ring-tile--palette', 'the colour options')
      const faces = await open(2, '.co-ring-card .co-face-swatch', 'the eyes options')
      const hats = await open(5, '.co-ring-card .co-ring-tile', 'the hat options')
      const stats = await companionStats(ui, 1000)
      assert(stats && stats.errors.length === 0, `companion errors: ${stats?.errors.join('; ')}`)
      // Done drops /look from the address, so asking again opens the ring again.
      await chrome.js(`document.querySelector('.co-hero__look')?.click(); return true`)
      await waitFor(() => tabs.info(card).url === lookUrl.replace(/\/general\/look$/, ''), 5000, 'the card address without /look')
      tabs.close(card.id)
      return `${bubbles} bubbles; ${palettes} colours, ${faces} eyes, ${hats} hats`
    })
    await check('the new-companion sheet shows every preset with a thumbnail', async () => {
      tabs.openInternal('apex://settings/companions')
      await chrome.until(`return document.querySelector('.sp-page')`, 5000, 'Settings › Companions')
      await chrome.click(/^New companion$/)
      const presets = await chrome.invoke<CompanionPreset[]>('companion', 'presets')
      const started = Date.now()
      // The thumbnails draw one at a time after the renders already queued (the ring's stills just before); where
      // WebGL is software (a CI machine without a GPU) that takes a while, so the wait is long and says how far it got.
      const counts = `const cards = document.querySelectorAll('.co-preset').length
         const thumbs = document.querySelectorAll('.co-preset img').length`
      const seen = await chrome.until<{ cards: number; thumbs: number }>(`${counts}
         return cards === ${presets.length} && thumbs === cards && { cards, thumbs }`, 60_000, 'every preset thumbnail').catch(async (err: unknown) => {
        const got = await chrome.js<{ cards: number; thumbs: number }>(`${counts}
         return { cards, thumbs }`).catch(() => null)
        // The sheet goes, so the checks after this one start from Settings as usual.
        await chrome.escape().catch(() => undefined)
        const stats = await companionStats(ui, 1).catch(() => null)
        throw new Error(`${err instanceof Error ? err.message : String(err)} (${got ? `${got.thumbs} of ${got.cards} cards drawn` : 'no sheet'}, ${presets.length} presets${stats?.errors.length ? `; companion errors: ${stats.errors.join('; ')}` : ''})`)
      })
      await chrome.escape()
      await chrome.until(`return !document.querySelector('.co-preset')`, 3000, 'the sheet to close')
      return `${seen.thumbs}/${seen.cards} preset thumbnails in ${((Date.now() - started) / 1000).toFixed(1)} s`
    })

    // ---- core: chats, companions, settings, theme, sidebar, ⌘D ----
    const baseState = await runBaseChecks({ chrome, tabs, host: deps.host, client: deps.client, chats: deps.chats, settings: deps.settings, bookmarks, base }, check)

    // ---- companion presence: face-only avatars, presence, the waiting companion ----
    await runPresenceChecks({ chrome, tabs }, check)

    // Optional visual check: every core surface, as it looks on screen.
    const shotDir = process.env.APEX_SMOKE_SHOTS
    if (shotDir) {
      mkdirSync(shotDir, { recursive: true })
      await check('screenshots of every core surface', async () => {
        const written = await captureTour({ ...deps, chrome, first, base, baseState, dir: shotDir })
        return `${written.length} in ${shotDir}`
      }, 300_000)
    }

    // The smoke groups, before first-week finishes setup.
    const fixtures = await startSmokeServer({ tlsDir: tlsFixtureDir(app.getAppPath()) })
    try {
      await runSmokeGroups({ chrome, tabs, host: deps.host, client: deps.client, settings: deps.settings, chats: deps.chats, server: fixtures }, check)
    } finally {
      fixtures.close()
    }

    // ---- getting started (apex://first-week); finishes setup, so it runs last ----
    await runFirstWeekChecks({ chrome, tabs, host: deps.host, chats: deps.chats, dir: shotDir ?? null }, check)
  } catch (err) {
    results.push({ name: 'setup', ok: false, detail: err instanceof Error ? err.message : String(err) })
  } finally {
    // A chat the checks left working (its reply held) can end now.
    deps.client.release()
    server.close()
  }

  for (const detail of smokeUncaught) results.push({ name: 'no uncaught main-process errors', ok: false, detail })
  const fetched = [...new Set(smokeExternalFetches.map((u) => { try { return new URL(u).host } catch { return u } }))]
  results.push({ name: 'network guard: the main process fetched nothing outside this machine', ok: fetched.length === 0, detail: fetched.length ? `refused: ${fetched.join(', ')}` : '' })
  console.log(`${fetched.length ? 'FAIL' : 'PASS'}  network guard: the main process fetched nothing outside this machine${fetched.length ? `  — refused: ${fetched.join(', ')}` : ''}`)
  const failed = results.filter((r) => !r.ok)
  for (const f of failed) console.log(`\n[${f.name}]\n${f.detail}`)
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`)
  return failed.length === 0 ? 0 : 1
}
