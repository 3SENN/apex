/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Packs end to end in the real app (APEX_SMOKE_ONLY=PACKS, docs/packs.md): a
// signed pack installs only after its review, and its skill, command, menu
// item and tweak appear; its tool runs in the sandbox, reads only its sites,
// fetches only its hosts and has no network or Node of its own; its panel
// opens in its own tab and can't leave; turning it off takes everything
// away; a companion's draft is tested in a throwaway sandbox and proposed
// with a card; apex://packs shows the review. An app pack (docs/apps.md) opens
// its game in a tab, which runs its own module, worker and WebAssembly and
// loads its own image, sound (by byte range) and data, while the network, inline
// code and navigating away stay closed; only the game may go full screen. Two
// packs work together (docs/apps.md › Everything is a plugin): one waits for a
// service until the other provides it, calls it through its module and then
// its open page, hears its events and sees its app's status in the sidebar.
// Everything it adds is removed.
import type { WebContents } from 'electron'
import { NO_PACK_PERMISSIONS, PACK_MANIFEST_FILE, packToolName, packUrl, type PackManifest } from '@shared/packs'
import { clientTool, type ClientToolContext } from '../agent/tools/registry'
import { omnibox } from '../omnibox'
import { registerScenario } from '../smokeClient'
import { pageMenuSections } from '../pageMenu'
import { assert, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { SmokeGroup, SmokeContext } from '../smokeBrowser/types'
import type { Tab } from '../tabs'
import { packsRuntime } from './feature'
import { encodeArchive, packHash } from './files'
import type { PackFiles } from './manifest'
import { AuthorKey } from './signing'
import { NO_POLICY, parsePolicy } from './policy'
import { serverWorks } from './smokeServer'

const ID = 'smoke-pack'
const DRAFT = 'smoke-draft'
const APP_ID = 'smoke-app'
const PROVIDER_ID = 'smoke-scores'
const SITE_ID = 'smoke-site'
const DEV_ID = 'smoke-dev'
const DINER_ID = 'smoke-diner'
const WINTER_ID = 'smoke-winter'
const KIT_ID = 'smoke-kit'
const NET_ID = 'smoke-net'
const PLACE_ID = 'smoke-place'
const TOWN = 'smoke-town'
const ORG_ID = 'smoke-org'
const DASH_ID = 'smoke-dashboard'
const STILL_DRAFT = 'smoke-world-still'
const NOTES_CONNECTOR = 'smoke-notes'
const STARTER_2D = 'smoke-starter-2d'
const STARTER_3D = 'smoke-starter-3d'
const CREATOR_DRAFT = 'smoke-creator'

// A companion asked to make something turns Creator mode on, and builds with the tools that joined its chat in the same turn.
registerScenario(/^smoke-creator: make/, [
  { kind: 'tool', name: 'creator_mode', input: {} },
  { kind: 'tool', name: 'create_pack', input: { id: CREATOR_DRAFT, name: 'Smoke creator', description: 'A pack made after Creator mode came on.' } },
  { kind: 'text', text: 'Started your pack.' },
])
const CONSUMER_ID = 'smoke-board'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pack fixture</title></head>
<body style="font:16px system-ui;margin:0;padding:24px"><h1>Pack fixture page</h1><p id="promo">Hide me</p><p>Some words to count.</p></body></html>`

const TOOL = `// Reads the page, then tries what a pack may and may not do.
export async function run(input) {
  const info = await apex.page.info()
  const text = await apex.page.text()
  const heads = await apex.page.query('h1')
  const allowed = await apex.fetch(input.allowed)
  let refused = 'not refused'
  try { await apex.fetch('https://example.com/') } catch (err) { refused = String(err.message) }
  let direct = 'reached'
  try { await fetch(input.allowed) } catch { direct = 'blocked' }
  await apex.storage.set('runs', ((await apex.storage.get('runs')) ?? 0) + 1)
  return { host: info && info.host, text, heads, allowed: await allowed.text(), refused, direct, node: typeof require + '/' + typeof process }
}
`

const PANEL = `<!doctype html><html><head><meta charset="utf-8"><title>Smoke panel</title></head><body><p id="out">panel</p></body></html>`

function fixture(serverHost: string, version = '1.0.0'): PackFiles {
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 1,
    id: ID,
    name: 'Smoke pack',
    version,
    description: 'Smoke test pack.',
    contributes: {
      skills: ['skills/smoke-hi'],
      tweaks: [{ id: 'hide', match: [serverHost], css: 'tweak.css' }],
      panels: [{ id: 'main', title: 'Smoke panel', html: 'panel.html', sidebar: true }],
      cards: [{ id: 'hello', title: 'Smoke card', module: 'cards/hello.js', open: 'panel:main' }],
      commands: [{ id: 'open', title: 'Open the smoke panel', run: 'panel:main' }],
      menus: [{ id: 'hi', title: 'Smoke hi', context: 'page', run: 'skill:smoke-hi' }],
      tools: [{ name: 'probe', description: 'Smoke probe.', inputSchema: { type: 'object', properties: { allowed: { type: 'string' } } }, module: 'tools/probe.js' }],
    },
    permissions: { ...NO_PACK_PERMISSIONS, sites: [serverHost], network: [serverHost] },
  }
  return new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2))],
    ['skills/smoke-hi/SKILL.md', Buffer.from('---\nname: smoke-hi\ndescription: Says hi for the smoke test.\n---\n\nSay hi.\n')],
    ['tweak.css', Buffer.from('#promo { display: none !important; }\n')],
    ['panel.html', Buffer.from(PANEL)],
    ['tools/probe.js', Buffer.from(TOOL)],
    ['cards/hello.js', Buffer.from("export async function run() { return ['First line', 'Second line'] }\n")],
  ])
}

// A 1×1 PNG, a WAV-shaped file and a WebAssembly module exporting add(a, b): an app's own assets.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const WAV = Buffer.from('RIFF0000WAVEfmt smoke-sound-bytes')
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b])

const GAME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Smoke game</title></head>
<body><img id="logo" src="./art/logo.png" alt=""><iframe id="help" src="./help/index.html"></iframe><script type="module" src="./main.js"></script></body></html>`

/** The game's own module: everything a real game needs from its own folder, and the network it must not reach. The image waits for its load event, not decode(): a window behind others draws no frames, and decode() waits for one. */
const gameScript = (net: string): string => `const out = {}
window.__out = out
const step = async (name, run) => { out.at = name; try { out[name] = await run() } catch (err) { out[name] = 'error: ' + (err && err.message ? err.message : String(err)) } }
await step('worker', () => new Promise((resolve) => { const w = new Worker('./worker.js', { type: 'module' }); w.onmessage = (e) => resolve(e.data); w.onerror = (e) => resolve('error: ' + e.message); w.postMessage(21) }))
await step('wasm', async () => (await WebAssembly.instantiateStreaming(fetch('./add.wasm'))).instance.exports.add(2, 3))
await step('image', () => new Promise((resolve) => { const img = document.getElementById('logo'); const done = () => resolve(img.naturalWidth); if (img.complete) done(); else { img.onload = done; img.onerror = () => resolve('error') } }))
await step('range', async () => { const r = await fetch('./sfx/beep.wav', { headers: { range: 'bytes=0-3' } }); return r.status + ':' + (await r.text()) })
await step('spaced', async () => (await (await fetch('./data/level one.json')).json()).name)
await step('frame', () => new Promise((resolve) => { const f = document.getElementById('help'); const started = Date.now(); const poll = () => { const title = f.contentDocument ? f.contentDocument.title : null; if (title || Date.now() - started > 5000) resolve(title === null ? 'no document' : title); else setTimeout(poll, 50) }; poll() }))
await step('net', () => fetch(${JSON.stringify(net)}).then(() => 'reached', () => 'blocked'))
out.node = typeof require + '/' + typeof process
out.apex = Boolean(window.apex && window.apex.pack && window.apex.pack.id)
window.__out = out
document.title = 'ready'
`

function appFixture(serverHttp: string): PackFiles {
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: APP_ID,
    name: 'Smoke app',
    version: '1.0.0',
    description: 'Smoke test app pack.',
    contributes: {
      apps: [
        { id: 'main', name: 'Smoke game', root: 'game', entry: 'index.html', build: 'bundled', kind: 'game', sidebar: true },
        { id: 'notes', name: 'Smoke notes', root: 'notes', entry: 'index.html', build: 'kit', kind: 'tool' },
      ],
      commands: [{ id: 'play', title: 'Play the smoke game', run: 'app:main' }],
    },
    permissions: { ...NO_PACK_PERMISSIONS },
  }
  return new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2))],
    ['game/index.html', Buffer.from(GAME_PAGE)],
    ['game/main.js', Buffer.from(gameScript(`${serverHttp}/packs/api`))],
    ['game/worker.js', Buffer.from('self.onmessage = (e) => self.postMessage(e.data * 2)\n')],
    ['game/add.wasm', WASM],
    ['game/art/logo.png', PNG],
    ['game/sfx/beep.wav', WAV],
    ['game/data/level one.json', Buffer.from('{"name":"Level one"}')],
    ['game/help/index.html', Buffer.from('<!doctype html><title>Smoke help</title><p>How to play.</p>')],
    ['notes/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Smoke notes</title></head><body><p>Notes</p></body></html>')],
  ])
}

const toolCtx = (events: unknown[] = []): ClientToolContext => ({
  chatId: 'smoke-packs-chat',
  companionId: 'shared',
  isPrivate: false,
  isRoutine: false,
  signal: new AbortController().signal,
  emit: (event) => void events.push(event),
  ask: async () => {
    throw new Error('Pack tools never ask.')
  },
})

const js = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

function need(): NonNullable<ReturnType<typeof packsRuntime>> {
  const running = packsRuntime()
  assert(running, 'packs are not running')
  return running
}

function cleanup(): void {
  const running = packsRuntime()
  if (!running) return
  for (const id of [ID, APP_ID, CONSUMER_ID, PROVIDER_ID, SITE_ID, DEV_ID, WINTER_ID, DINER_ID, KIT_ID, NET_ID, PLACE_ID, ORG_ID]) if (running.store.get(id)) running.service.remove(id)
  for (const p of running.store.all()) if (p.manifest.id.startsWith(`world-${TOWN}-`)) running.service.remove(p.manifest.id)
  running.store.setPolicy(NO_POLICY)
  running.runtime.ownWorlds.remove(TOWN)
  for (const id of [DRAFT, ID, STARTER_2D, STARTER_3D, CREATOR_DRAFT]) if (running.store.hasDraft(id)) running.store.removeDraft(id)
}

async function openFixture(ctx: SmokeContext): Promise<Tab> {
  ctx.server.page('/packs/page', PAGE)
  const tab = ctx.tabs.create(`${ctx.server.http}/packs/page`, { activate: true })
  await waitForPage(tab.view.webContents, 'the pack fixture page', 10_000, (at) => at.includes('/packs/page'))
  await waitFor(() => js<boolean>(tab.view.webContents, 'document.readyState === "complete"').catch(() => false), 8000, 'the pack fixture to load')
  return tab
}

async function installs(ctx: SmokeContext): Promise<void> {
  cleanup()
  const { service, store } = need()
  const host = new URL(ctx.server.http).hostname
  const files = fixture(host)
  // An author key of its own, as someone else's pack would have.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const author = new AuthorKey(mkdtempSync(join(tmpdir(), 'apex-smoke-author-')), { encrypt: (b) => b, decrypt: (b) => b })
  const review = service.reviewArchive(encodeArchive(files, author.sign(packHash(files))), { kind: 'file' })
  assert(review.problems.length === 0, `the fixture pack has problems: ${review.problems.join('; ')}`)
  assert(review.signature === 'signed', 'the fixture pack did not read as signed')
  assert(review.permissions.some((l) => l.kind === 'exfil' && l.level === 'danger'), 'reading a site and sending to a host was not flagged as serious')
  assert(!store.get(ID), 'the pack installed before Install was pressed')
  service.confirmInstall(review.token)
  assert(store.isActive(ID), 'the pack is not on after install')
  await waitFor(async () => (await ctx.chrome.invoke<Array<{ name: string; source: string }>>('skills', 'list')).some((s) => s.name === 'smoke-hi' && s.source === 'pack'), 5000, 'the pack skill in the skill list')
  // The sidebar row and the new tab card.
  assert(need().runtime.sidebar().some((e) => e.packId === ID && e.kind === 'panel' && e.itemId === 'main'), 'the pack panel is not in the sidebar')
  const cards = await need().runtime.cards()
  const card = cards.find((c) => c.packId === ID)
  assert(card && card.error === null && card.lines.join('|') === 'First line|Second line', `the new tab card: ${JSON.stringify(card)}`)
  await ctx.chrome.until('return Boolean(document.querySelector(".side-apps .side-row"))', 5000, 'the pack app in the sidebar')
  // The Packs page: its card says what it is (a panel makes it an app), and the card opens its sheet.
  ctx.tabs.openInternal('apex://packs')
  await ctx.chrome.until(
    `const tile = [...document.querySelectorAll('.pk-grid .pk-tile')].find((t) => t.textContent.includes('Smoke pack'))
     return tile && tile.dataset.kind === 'app' && tile.querySelector('.pk-tile__line').textContent.startsWith('App')`,
    10_000,
    'the pack’s card on the Packs page',
  )
  assert(!(await ctx.chrome.js<boolean>('const s = document.querySelector(".sp-main"); return Boolean(s) && s.scrollWidth > s.clientWidth + 1')), 'apex://packs scrolls sideways')
  await ctx.shot('packs-yours')
  await ctx.chrome.js(`[...document.querySelectorAll('.pk-tile')].find((t) => t.textContent.includes('Smoke pack'))?.querySelector('.pk-tile__main')?.click(); return true`)
  await ctx.chrome.until(`const sheet = document.querySelector('.pk-sheet'); return sheet && sheet.querySelector('.pk-hero') && sheet.textContent.includes('What’s inside')`, 10_000, 'the pack’s sheet')
  await ctx.shot('packs-sheet')
  await ctx.chrome.escape()
  const groups = await omnibox.query('smoke panel', { windowId: 1, signal: new AbortController().signal })
  assert(groups.some((g) => g.group === 'packs' && g.rows.some((r) => r.action.kind === 'pack')), 'the pack command is not in the command bar')
  const tab = await openFixture(ctx)
  try {
    await waitFor(async () => (await js<string>(tab.view.webContents, 'getComputedStyle(document.getElementById("promo")).display')) === 'none', 5000, 'the pack tweak to hide #promo')
    const section = pageMenuSections().find((sec) => sec.id === 'packs')
    assert(section, 'the packs page menu section is missing')
    const items = section.build({ selectionText: '', linkURL: '' } as Electron.ContextMenuParams, tab, null as never)
    assert(items.some((i) => i.label === 'Smoke hi'), 'the pack menu item is not in the page menu')
  } finally {
    ctx.tabs.close(tab.id)
  }
}

async function toolRuns(ctx: SmokeContext): Promise<void> {
  const tab = await openFixture(ctx)
  try {
    ctx.server.route('/packs/api', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('api says hello')
    })
    const tool = clientTool(packToolName(ID, 'probe'))
    assert(tool, 'the pack tool is not registered')
    const result = await tool.run({ allowed: `${ctx.server.http}/packs/api` }, toolCtx())
    assert(!result.isError, `the pack tool failed: ${result.content}`)
    const wrapped = /^<pack_tool_result pack="smoke-pack" tool="probe">\n([\s\S]*)\n<\/pack_tool_result>\n/.exec(result.content)
    assert(wrapped, `the pack tool's result isn't marked as the pack's own output: ${result.content.slice(0, 120)}`)
    const out = JSON.parse(wrapped[1] as string) as { host: string; text: string; heads: string[]; allowed: string; refused: string; direct: string; node: string }
    assert(out.text.includes('Pack fixture page') && out.heads[0] === 'Pack fixture page', `the tool didn't read the page: ${result.content.slice(0, 200)}`)
    assert(out.allowed === 'api says hello', `apex.fetch to a listed host failed: ${out.allowed}`)
    assert(/not in this pack’s network/.test(out.refused), `apex.fetch to an unlisted host was not refused: ${out.refused}`)
    assert(out.direct === 'blocked', 'pack code reached the network without the bridge')
    assert(out.node === 'undefined/undefined', `pack code can see Node: ${out.node}`)
    assert(need().store.storage(ID).runs === 1, 'apex.storage did not keep the run count')
  } finally {
    ctx.tabs.close(tab.id)
  }
}

async function panelStays(ctx: SmokeContext): Promise<void> {
  const { runtime } = need()
  runtime.openPanel(ID, 'main')
  const url = packUrl(ID, 'panel.html')
  let tab: Tab | undefined
  await waitFor(() => {
    tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
    return Boolean(tab)
  }, 5000, 'the panel tab')
  const wc = (tab as Tab).view.webContents
  try {
    await waitForPage(wc, 'the pack panel', 10_000, (at) => at.startsWith('apex-pack://'))
    await waitFor(() => js<boolean>(wc, 'Boolean(window.apex && window.apex.pack.id === "smoke-pack")').catch(() => false), 5000, 'window.apex in the panel')
    assert((await js<string>(wc, 'apex.storage.set("panel", 7).then(() => apex.storage.get("panel"))')) === (7 as unknown as string), 'apex.storage from the panel')
    await js(wc, 'location.href = "https://example.com/"').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 500))
    assert(wc.getURL().startsWith('apex-pack://smoke-pack/'), `the panel navigated away to ${wc.getURL()}`)
    const blocked = await js<string>(wc, `fetch(${JSON.stringify(`${ctx.server.http}/packs/api`)}).then(() => 'reached', () => 'blocked')`)
    assert(blocked === 'blocked', 'a panel reached the network directly')
    assert((await js<string>(wc, 'typeof RTCPeerConnection')) === 'undefined', 'a pack page can still make WebRTC connections')
    const inline = await js<string>(wc, `new Promise((resolve) => { window.__inline = 'blocked'; const s = document.createElement('script'); s.textContent = 'window.__inline = "ran"'; document.body.append(s); setTimeout(() => resolve(window.__inline), 100) })`)
    assert(inline === 'blocked', 'a pack page ran an inline script')
  } finally {
    if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
  }
}

async function offTakesAway(ctx: SmokeContext): Promise<void> {
  const { service } = need()
  service.setEnabled(ID, false)
  await waitFor(() => !clientTool(packToolName(ID, 'probe')), 3000, 'the tool to go when the pack is off')
  const skills = await ctx.chrome.invoke<Array<{ name: string }>>('skills', 'list')
  assert(!skills.some((s) => s.name === 'smoke-hi'), 'the pack skill stayed after turning it off')
  const tab = await openFixture(ctx)
  try {
    assert((await js<string>(tab.view.webContents, 'getComputedStyle(document.getElementById("promo")).display')) !== 'none', 'the tweak stayed after turning the pack off')
  } finally {
    ctx.tabs.close(tab.id)
  }
  let refused = false
  try {
    need().runtime.openPanel(ID, 'main')
  } catch {
    refused = true
  }
  assert(refused, 'a panel opened from a pack that is off')
  service.setEnabled(ID, true)
}

async function builds(ctx: SmokeContext): Promise<void> {
  const create = clientTool('create_pack')
  const write = clientTool('write_pack_file')
  const test = clientTool('test_pack')
  const propose = clientTool('propose_pack')
  assert(create && write && test && propose, 'the builder tools are not registered')
  const made = await create.run({ id: DRAFT, name: 'Smoke draft', description: 'A draft from the smoke test.' }, toolCtx())
  assert(!made.isError && made.content.includes('"guide"'), `create_pack failed: ${made.content.slice(0, 200)}`)
  const host = new URL(ctx.server.http).hostname
  const manifest = {
    format: 'apex-pack',
    manifestVersion: 1,
    id: DRAFT,
    name: 'Smoke draft',
    version: '1.0.0',
    description: 'A draft from the smoke test.',
    contributes: {
      tools: [
        { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object' }, module: 'add.js' },
        { name: 'peek', description: 'Reads the page.', inputSchema: { type: 'object' }, module: 'peek.js' },
      ],
    },
    permissions: { sites: [host] },
  }
  await write.run({ id: DRAFT, path: PACK_MANIFEST_FILE, content: JSON.stringify(manifest) }, toolCtx())
  await write.run({ id: DRAFT, path: 'add.js', content: 'export async function run(input) { return { sum: input.a + input.b } }\n' }, toolCtx())
  await write.run({ id: DRAFT, path: 'peek.js', content: 'export async function run() { return apex.page.text() }\n' }, toolCtx())
  // A cookie in your own session; the test page must not carry it.
  const { session } = await import('electron')
  await session.defaultSession.cookies.set({ url: ctx.server.http, name: 'apexsmoke', value: 'signed-in-secret' })
  ctx.server.route('/packs/whoami', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><p>cookie:${req.headers.cookie ?? 'none'}</p>`)
  })
  const tested = await test.run({ id: DRAFT, tests: [{ tool: 'add', input: { a: 2, b: 3 } }, { tool: 'peek', input: {}, url: `${ctx.server.http}/packs/whoami` }] }, toolCtx())
  const report = JSON.parse(tested.content) as { ok: boolean; results: Array<{ tool: string; ok: boolean; result?: string; error?: string }>; log?: string[] }
  // A failure names the test that failed and the draft's log, not the report's opening lines.
  const failed = report.results.filter((r) => !r.ok)
  assert(report.ok && report.results[0]?.result === '{"sum":5}', `test_pack: ${failed.length ? JSON.stringify(failed) : tested.content.slice(0, 400)}; log ${JSON.stringify(report.log ?? [])}`)
  assert(report.results[1]?.result === 'cookie:none', `a test page carried your cookies: ${report.results[1]?.result}`)
  await session.defaultSession.cookies.remove(ctx.server.http, 'apexsmoke')
  assert(!clientTool(packToolName(DRAFT, 'add')), 'a tested draft left its tool registered')
  assert(!need().store.get(DRAFT), 'test_pack installed the draft')
  const events: unknown[] = []
  const proposed = await propose.run({ id: DRAFT, note: 'Adds numbers.' }, toolCtx(events))
  assert(!proposed.isError && (events[0] as { type?: string } | undefined)?.type === 'pack-proposed', 'propose_pack did not post its card')
  assert(!need().store.get(DRAFT), 'propose_pack installed the draft')

  // The review opens from the card's address.
  ctx.tabs.openInternal(`apex://packs?draft=${DRAFT}&review=1`)
  await ctx.chrome.until('return Boolean(document.querySelector(".pk-review"))', 10_000, 'the review sheet for the draft')
  const overflow = await ctx.chrome.js<boolean>('const s = document.querySelector(".sp-main"); return Boolean(s) && s.scrollWidth > s.clientWidth + 1')
  assert(!overflow, 'apex://packs scrolls sideways')
  await ctx.shot('packs-review')
  await ctx.chrome.escape()
}

async function appRuns(ctx: SmokeContext): Promise<void> {
  const { service, store, runtime } = need()
  const files = appFixture(ctx.server.http)
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const author = new AuthorKey(mkdtempSync(join(tmpdir(), 'apex-smoke-author-')), { encrypt: (b) => b, decrypt: (b) => b })
  const review = service.reviewArchive(encodeArchive(files, author.sign(packHash(files))), { kind: 'file' })
  assert(review.problems.length === 0, `the app pack has problems: ${review.problems.join('; ')}`)
  assert(review.permissions.some((l) => l.kind === 'apps') && review.permissions.some((l) => l.kind === 'bundled'), 'the review does not list the apps and the built code')
  assert(!review.code.some((c) => c.path.startsWith('game/')), 'the review shows a bundled app’s code')
  service.confirmInstall(review.token)
  assert(store.isActive(APP_ID), 'the app pack is not on after install')
  assert(store.file(APP_ID, 'game/main.js') === null && store.diskPath(APP_ID, 'game/main.js') !== null, 'the app’s files are held in memory')
  assert(runtime.sidebar().some((e) => e.packId === APP_ID && e.kind === 'app' && e.itemId === 'main'), 'the game is not in the sidebar')

  const open = async (appId: string, entry: string): Promise<Tab> => {
    runtime.openApp(APP_ID, appId)
    const url = packUrl(APP_ID, entry)
    let tab: Tab | undefined
    await waitFor(() => {
      tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
      return Boolean(tab)
    }, 5000, `the ${appId} tab`)
    await waitForPage((tab as Tab).view.webContents, `the ${appId} app`, 10_000, (at) => at.startsWith(`apex-pack://${APP_ID}/`))
    return tab as Tab
  }

  const game = await open('main', 'game/index.html')
  const wc = game.view.webContents
  try {
    try {
      await waitFor(() => js<boolean>(wc, 'document.title === "ready"').catch(() => false), 15_000, 'the game to load its own files')
    } catch (err) {
      // Which step it stopped at, so a slow machine and a real failure read differently.
      const partial = await js<unknown>(wc, 'JSON.stringify(window.__out || null)').catch(() => 'no page')
      throw new Error(`${err instanceof Error ? err.message : String(err)} So far: ${String(partial)}`)
    }
    const out = await js<Record<string, unknown>>(wc, 'window.__out')
    assert(out.worker === 42, `a worker from the app’s own file: ${String(out.worker)}`)
    assert(out.wasm === 5, `WebAssembly from the app’s own file: ${String(out.wasm)}`)
    assert(out.image === 1, `the app’s own image: ${String(out.image)}`)
    assert(out.range === '206:RIFF', `a byte range of the app’s own sound: ${String(out.range)}`)
    assert(out.spaced === 'Level one', `a file with a space in its name: ${String(out.spaced)}`)
    assert(out.frame === 'Smoke help', `a frame of the app’s own page: ${String(out.frame)}`)
    assert(out.net === 'blocked', 'the app reached the network')
    assert(out.node === 'undefined/undefined', `the app can see Node: ${String(out.node)}`)
    assert(out.apex === true, 'window.apex is missing in the app')
    const inline = await js<string>(wc, `new Promise((resolve) => { window.__inline = 'blocked'; const s = document.createElement('script'); s.textContent = 'window.__inline = "ran"'; document.body.append(s); setTimeout(() => resolve(window.__inline), 100) })`)
    assert(inline === 'blocked', 'an app page ran an inline script')
    // Granting is the page's request being let through (Electron's enter-html-full-screen). macOS may never finish
    // the full-screen animation on a screen nobody is at (CI, a locked Mac), so a request still pending after
    // three seconds counts when Electron saw it entered; a refused one fails at once.
    const entered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      wc.once('enter-html-full-screen', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    const full = await js<string>(wc, 'new Promise((resolve) => { let done = false; document.documentElement.requestFullscreen().then(() => { done = true; resolve("granted") }, (err) => { done = true; resolve("refused: " + err.message) }); setTimeout(() => { if (!done) resolve("pending") }, 3000) })')
    assert(full === 'granted' || (full === 'pending' && (await entered)), `the game may not go full screen: ${full}`)
    // Leaving can hang the same way, so it gets two seconds.
    await js(wc, 'new Promise((resolve) => { if (!document.fullscreenElement) return resolve(null); document.exitFullscreen().then(resolve, resolve); setTimeout(resolve, 2000) })').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 800))
    await js(wc, 'location.href = "https://example.com/"').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 500))
    assert(wc.getURL().startsWith(`apex-pack://${APP_ID}/`), `the game navigated away to ${wc.getURL()}`)
    await ctx.shot('packs-app')
  } finally {
    if (ctx.tabs.find(game.id)) ctx.tabs.close(game.id)
  }

  // Share…: a still drawn off-screen, then the note and picture come back on the review.
  const still = await runtime.appStill(APP_ID, 'main')
  assert(typeof still === 'string' && still.startsWith('data:image/png;base64,'), 'the game’s still was not drawn')
  const image = Buffer.from((still as string).slice((still as string).indexOf(',') + 1), 'base64')
  const shared = service.exportArchive(APP_ID, 'installed', { note: 'Play the smoke game.', image })
  assert(shared.name.endsWith('.apexapp'), `an app pack exported as ${shared.name}`)
  const again = service.reviewArchive(shared.data, { kind: 'file' })
  assert(again.shared.note === 'Play the smoke game.' && Boolean(again.shared.image?.startsWith('data:image/png;base64,')), 'the review does not show what Share… added')
  service.cancelReview(again.token)

  const notes = await open('notes', 'notes/index.html')
  try {
    // A refused request may never settle; what counts is that the page didn't go full screen.
    const full = await js<string>(notes.view.webContents, 'new Promise((resolve) => { let done = false; document.documentElement.requestFullscreen().then(() => { done = true; resolve("granted") }, () => { done = true; resolve("refused") }); setTimeout(() => { if (!done) resolve(document.fullscreenElement ? "granted" : "refused") }, 2000) })')
    assert(full === 'refused', 'a tool app went full screen without asking')
  } finally {
    if (ctx.tabs.find(notes.id)) ctx.tabs.close(notes.id)
  }
}

/** A one-app pack laid out the way a Vite or Next build is: an inline bootstrap, root paths, page files and client routes. */
function siteFixture(): PackFiles {
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: SITE_ID,
    name: 'Smoke site',
    version: '1.0.0',
    description: 'A build tool’s output for the smoke test.',
    contributes: { apps: [{ id: 'main', name: 'Smoke site', root: 'dist', entry: 'index.html', build: 'bundled', kind: 'tool', isolated: true }] },
    permissions: { ...NO_PACK_PERMISSIONS },
  }
  const page = (title: string): string =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><script>window.__boot = ${JSON.stringify(title)}</script><script type="module" src="/assets/app.js"></script></head><body><p>${title}</p></body></html>`
  return new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2))],
    ['dist/index.html', Buffer.from(page('Home'))],
    ['dist/about.html', Buffer.from(page('About'))],
    ['dist/assets/app.js', Buffer.from('window.__ran = { boot: window.__boot, isolated: self.crossOriginIsolated, shared: typeof SharedArrayBuffer }\ndocument.title = document.title + " ready"\n')],
  ])
}

async function buildOutputRuns(ctx: SmokeContext): Promise<void> {
  const { service, runtime } = need()
  const review = service.reviewArchive(encodeArchive(siteFixture(), null), { kind: 'file' })
  assert(review.problems.length === 0, `the site pack has problems: ${review.problems.join('; ')}`)
  service.confirmInstall(review.token)
  runtime.openApp(SITE_ID, 'main')
  const url = packUrl(SITE_ID, 'dist/index.html')
  let tab: Tab | undefined
  await waitFor(() => {
    tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
    return Boolean(tab)
  }, 5000, 'the site tab')
  const wc = (tab as Tab).view.webContents
  try {
    await waitFor(() => js<boolean>(wc, 'document.title === "Home ready"').catch(() => false), 10_000, 'the site’s inline bootstrap and root-path module to run')
    const ran = await js<{ boot: string; isolated: boolean; shared: string }>(wc, 'window.__ran')
    assert(ran.boot === 'Home', 'the page’s own inline script did not run')
    assert(ran.isolated === true && ran.shared === 'function', `an isolated app is not cross-origin isolated: ${JSON.stringify(ran)}`)
    const injected = await js<string>(wc, `new Promise((resolve) => { window.__inline = 'blocked'; const s = document.createElement('script'); s.textContent = 'window.__inline = "ran"'; document.head.append(s); setTimeout(() => resolve(window.__inline), 100) })`)
    assert(injected === 'blocked', 'a script injected after load ran in an app page')
    await js(wc, `location.href = ${JSON.stringify(`apex-pack://${SITE_ID}/about`)}`).catch(() => undefined)
    await waitFor(() => js<boolean>(wc, 'document.title === "About ready"').catch(() => false), 10_000, '/about to serve about.html')
    await js(wc, `location.href = ${JSON.stringify(`apex-pack://${SITE_ID}/shop/item/42`)}`).catch(() => undefined)
    await waitFor(() => js<boolean>(wc, 'document.title === "Home ready" && location.pathname === "/shop/item/42"').catch(() => false), 10_000, 'a client route to serve the entry page')
  } finally {
    if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
  }
}

/** Developer mode: a folder linked through the Packs page reloads its open app when a file changes, and unlinking leaves it alone. */
async function devFolderReloads(ctx: SmokeContext): Promise<void> {
  const { service, runtime } = need()
  const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const folder = mkdtempSync(join(tmpdir(), 'apex-smoke-dev-'))
  mkdirSync(join(folder, 'app'))
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: DEV_ID,
    name: 'Smoke dev',
    version: '0.0.1',
    description: 'A folder in developer mode.',
    contributes: { apps: [{ id: 'main', name: 'Smoke dev', root: 'app', entry: 'index.html', build: 'kit', kind: 'tool' }] },
    permissions: { ...NO_PACK_PERMISSIONS },
    env: { SERVER: 'https://api.smoke-dev.example' },
  }
  // A developer's .env: one name the manifest declares, and one (the server's own) it doesn't.
  writeFileSync(join(folder, '.env'), 'SERVER=http://127.0.0.1:8787\nDATABASE_URL=postgres://never-shown\n')
  const page = (v: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>start</title><script>document.title = ${JSON.stringify(v)}</script></head><body>${v}</body></html>`
  writeFileSync(join(folder, PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  writeFileSync(join(folder, 'app', 'index.html'), page('v1'))
  process.env.APEX_SMOKE_PACK_FOLDER = folder
  let tab: Tab | undefined
  try {
    const review = await ctx.chrome.invoke<{ token: string; problems: string[]; source: { kind: string } }>('packs', 'loadFolder')
    assert(review && review.problems.length === 0 && review.source.kind === 'dev', `the folder’s review: ${JSON.stringify(review?.problems)}`)
    service.confirmInstall(review.token)
    runtime.openApp(DEV_ID, 'main')
    const url = packUrl(DEV_ID, 'app/index.html')
    await waitFor(() => {
      tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
      return Boolean(tab)
    }, 5000, 'the linked app’s tab')
    const wc = (tab as Tab).view.webContents
    await waitFor(() => js<boolean>(wc, 'document.title === "v1"').catch(() => false), 10_000, 'the linked app to load')
    const env = await js<string>(wc, 'JSON.stringify(apex.env)')
    assert(env === '{"SERVER":"http://127.0.0.1:8787"}', `a linked folder’s .env did not fill apex.env for the declared name only: ${env}`)
    const served = await js<number>(wc, "fetch('/.env').then((r) => r.status)")
    assert(served === 404, `the folder’s .env is served to the pack: ${served}`)
    const local = await js<string>(wc, `fetch(${JSON.stringify(`${ctx.server.http}/`)}, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`)
    assert(local === 'reached', 'a linked folder’s app can’t reach this computer while you develop')
    writeFileSync(join(folder, 'app', 'index.html'), page('v2'))
    await waitFor(() => js<boolean>(wc, 'document.title === "v2"').catch(() => false), 10_000, 'the linked app to reload after its file changed')
  } finally {
    delete process.env.APEX_SMOKE_PACK_FOLDER
    if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
    if (need().store.get(DEV_ID)) service.remove(DEV_ID)
  }
  assert(existsSync(join(folder, 'app', 'index.html')), 'unlinking a folder deleted it')
}

const NET_KEY = 'smoke-key-0123456789'

/** The app's own server: CORS for the pack's origin, a preflight, a redirect to another host, an image and a WebSocket echo. */
async function startNetServer(): Promise<{ port: number; preflights: () => number; close(): void }> {
  const { createServer } = await import('node:http')
  const { createHash } = await import('node:crypto')
  let preflights = 0
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const server = createServer((req, res) => {
    const origin = String(req.headers.origin ?? '')
    const cors = { 'access-control-allow-origin': origin || '*', 'access-control-allow-headers': 'authorization, content-type, x-app', 'access-control-allow-methods': 'GET, POST' }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const port = (server.address() as { port: number }).port
    const facts = (): string => JSON.stringify({ origin, auth: req.headers.authorization === `Bearer ${NET_KEY}`, method: req.method, host: String(req.headers.host ?? '').split(':')[0] })
    if (req.method === 'OPTIONS') {
      preflights++
      res.writeHead(204, cors).end()
    } else if (url.pathname === '/hello') res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(facts())
    else if (url.pathname === '/nocors') res.writeHead(200, { 'content-type': 'application/json' }).end(facts())
    else if (url.pathname === '/to-localhost') res.writeHead(302, { ...cors, location: `http://localhost:${port}/hello` }).end()
    else if (url.pathname === '/pic.png') res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
    else res.writeHead(404).end()
  })
  // A WebSocket that echoes one short text frame with what its handshake carried.
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    const auth = req.headers.authorization === `Bearer ${NET_KEY}`
    socket.on('error', () => undefined)
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
    socket.on('data', (frame: Buffer) => {
      if (((frame[0] ?? 0) & 0x0f) === 8) return void socket.end()
      const length = (frame[1] ?? 0) & 0x7f
      const mask = frame.subarray(2, 6)
      const text = Buffer.from(frame.subarray(6, 6 + length).map((b, i) => b ^ (mask[i % 4] ?? 0))).toString('utf8')
      const reply = Buffer.from(`echo:${text}|auth:${auth}|origin:${String(req.headers.origin ?? '')}`)
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, preflights: () => preflights, close: () => server.close() }
}

/**
 * An app talks to its own server (docs/apps.md › Your own servers): fetch,
 * a preflight, an image and a WebSocket to the host it lists, with normal
 * CORS; nothing to hosts it doesn't (until one is granted, and again once
 * that's taken back); and the key the person entered goes on requests to its
 * host only, never to the page and never on through a redirect.
 */
async function serversWork(ctx: SmokeContext): Promise<void> {
  const { service, runtime } = need()
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const net = await startNetServer()
  const near = `http://127.0.0.1:${net.port}`
  const granted = `http://localhost:${net.port}`
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: NET_ID,
    name: 'Smoke net',
    version: '1.0.0',
    description: 'An app that talks to its own server.',
    contributes: { apps: [{ id: 'main', name: 'Smoke net', root: 'app', entry: 'index.html', build: 'bundled', kind: 'tool' }] },
    permissions: { ...NO_PACK_PERMISSIONS, network: ['127.0.0.1'] },
    optionalPermissions: { network: ['localhost'] },
    secrets: [{ id: 'NET_KEY', name: 'Smoke key', description: 'Any text will do.', hosts: ['127.0.0.1'], header: 'Authorization', prefix: 'Bearer ' }],
    env: { GREETING: 'hello' },
  }
  const files: PackFiles = new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest))],
    ['app/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>net</title></head><body>net</body></html>')],
  ])
  const author = new AuthorKey(mkdtempSync(join(tmpdir(), 'apex-smoke-author-')), { encrypt: (b) => b, decrypt: (b) => b })
  let tab: Tab | undefined
  let keyTab: Tab | undefined
  try {
    const review = service.reviewArchive(encodeArchive(files, author.sign(packHash(files))), { kind: 'file' })
    assert(review.problems.length === 0, `the server app has problems: ${review.problems.join('; ')}`)
    assert(review.permissions.some((l) => l.kind === 'secrets' && String(l.vars.hosts) === '127.0.0.1'), 'the review does not say which key goes where')
    service.confirmInstall(review.token)
    const summary = service.setSecret(NET_ID, 'NET_KEY', NET_KEY)
    assert(summary.secrets[0]?.state === 'set' && !JSON.stringify(summary).includes(NET_KEY), 'the pack’s page got the key back')

    runtime.openApp(NET_ID, 'main')
    const url = packUrl(NET_ID, 'app/index.html')
    await waitFor(() => {
      tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
      return Boolean(tab)
    }, 5000, 'the server app’s tab')
    const wc = (tab as Tab).view.webContents
    await waitForPage(wc, 'the server app', 10_000, (at) => at.startsWith(`apex-pack://${NET_ID}/`))
    type Got = { status: number; body: { origin: string; auth: boolean; method: string; host: string } } | string
    const get = (address: string, init = '{}'): Promise<Got> => js<Got>(wc, `fetch(${JSON.stringify(address)}, ${init}).then(async (r) => ({ status: r.status, body: await r.json() }), (err) => 'blocked: ' + err.message)`)
    const body = (got: Got, what: string): Exclude<Got, string>['body'] => {
      assert(typeof got === 'object', `${what}: ${String(got)}`)
      return (got as Exclude<Got, string>).body
    }

    const hello = body(await get(`${near}/hello`), 'the app could not reach its own server')
    assert(hello.origin === `apex-pack://${NET_ID}`, `the server saw the origin ${hello.origin}`)
    assert(hello.auth, 'the key the person entered was not on the request to its host')
    const posted = body(await get(`${near}/hello`, `{ method: 'POST', headers: { 'X-App': '1', 'Content-Type': 'application/json' }, body: '{"n":1}' }`), 'a POST with its own header failed')
    assert(posted.method === 'POST' && posted.auth && net.preflights() > 0, `the preflighted POST: ${JSON.stringify(posted)}, ${net.preflights()} preflights`)
    const noCors = await get(`${near}/nocors`)
    assert(typeof noCors === 'string', 'the page read a response its server did not allow (CORS)')
    const ws = await js<string>(wc, `new Promise((resolve) => { const s = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${net.port}/ws`)}); s.onopen = () => s.send('hi'); s.onmessage = (e) => { resolve(String(e.data)); s.close() }; s.onerror = () => resolve('error'); setTimeout(() => resolve('timeout'), 5000) })`)
    assert(ws === `echo:hi|auth:true|origin:apex-pack://${NET_ID}`, `the app’s WebSocket: ${ws}`)
    const image = await js<number>(wc, `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i.naturalWidth); i.onerror = () => resolve(-1); i.src = ${JSON.stringify(`${near}/pic.png`)} })`)
    assert(image === 1, `an image from the app’s server: ${image}`)
    assert(typeof (await get(`${granted}/hello`)) === 'string', 'the app reached a host it may only ask for')
    assert(typeof (await get('https://example.com/')) === 'string', 'the app reached a host it doesn’t list')

    const env = await js<string>(wc, 'JSON.stringify(apex.env)')
    assert(env === '{"GREETING":"hello"}', `apex.env: ${env}`)
    const status = await js<Record<string, boolean>>(wc, 'apex.secrets.status()')
    assert(status.NET_KEY === true, `apex.secrets.status: ${JSON.stringify(status)}`)
    const viaMain = await js<{ auth: boolean }>(wc, `apex.fetch(${JSON.stringify(`${near}/nocors`)}).then((r) => r.json())`)
    assert(viaMain.auth === true, 'apex.fetch did not carry the key to its host')

    // Granted later: the host works at once, without the key; a redirect to it leaves the key behind.
    const realPrompt = runtime.permissionPrompt
    runtime.permissionPrompt = async () => true
    try {
      const asked = await js<{ granted: boolean }>(wc, "apex.permissions.request({ network: ['localhost'] })")
      assert(asked.granted, 'asking for the optional host was refused')
    } finally {
      runtime.permissionPrompt = realPrompt
    }
    await waitFor(async () => typeof (await get(`${granted}/hello`)) === 'object', 5000, 'a granted host to work without a reload')
    assert(!body(await get(`${granted}/hello`), 'the granted host').auth, 'the key went to a host it isn’t for')
    const moved = body(await get(`${near}/to-localhost`), 'the redirect to the granted host')
    assert(moved.host === 'localhost' && !moved.auth, `a redirect carried the key on: ${JSON.stringify(moved)}`)
    service.revokeGranted(NET_ID)
    await waitFor(async () => typeof (await get(`${granted}/hello`)) === 'string', 5000, 'a host taken back to be blocked again')

    // No key: requests go without one, and apex.secrets.request opens the pack's page and hears the save.
    service.clearSecret(NET_ID, 'NET_KEY')
    assert(!body(await get(`${near}/hello`), 'the server after the key was removed').auth, 'a removed key was still sent')
    const asking = js<{ set: boolean }>(wc, "apex.secrets.request('NET_KEY')")
    await waitFor(() => {
      keyTab = ctx.tabs.all().find((t) => [t.internalUrl ?? '', t.requestedUrl].some((u) => u.includes(`pack=${NET_ID}`) && u.includes('key=NET_KEY')))
      return Boolean(keyTab)
    }, 5000, 'the pack’s page at the key it asked for')
    await ctx.shot('packs-keys')
    service.setSecret(NET_ID, 'NET_KEY', NET_KEY)
    const answer = await asking
    assert(answer.set === true, 'the app did not hear that the key was saved')
    assert(body(await get(`${near}/hello`), 'the server with the key back').auth, 'the saved key was not sent')
  } finally {
    if (keyTab && ctx.tabs.find(keyTab.id)) ctx.tabs.close(keyTab.id)
    if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
    if (need().store.get(NET_ID)) service.remove(NET_ID)
    net.close()
  }
  assert(need().store.secrets.get(NET_ID, 'NET_KEY') === null, 'a removed pack’s key was kept')
}

/** An app with an art slot and an asset pack that replaces part of it: the person picks, the app reloads, missing files come from the app. */
async function assetPacksWork(ctx: SmokeContext): Promise<void> {
  const { service, runtime } = need()
  const diner: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: DINER_ID,
    name: 'Smoke diner',
    version: '1.0.0',
    description: 'An app whose art an asset pack can change.',
    contributes: { apps: [{ id: 'main', name: 'Smoke diner', root: 'app', entry: 'index.html', build: 'kit', kind: 'tool', assets: [{ id: 'art', name: 'Art', description: 'The sign and the menu.', layout: 'app/art' }] }] },
    permissions: { ...NO_PACK_PERMISSIONS },
  }
  const winter: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: WINTER_ID,
    name: 'Smoke winter',
    version: '1.0.0',
    description: 'A winter sign for the smoke diner.',
    contributes: { assets: [{ id: 'winter', name: 'Winter', for: { pack: DINER_ID, app: 'main', slot: 'art' }, root: 'winter' }] },
    permissions: { ...NO_PACK_PERMISSIONS },
  }
  const install = (files: PackFiles): void => {
    const review = service.reviewArchive(encodeArchive(files, null), { kind: 'file' })
    assert(review.problems.length === 0, `an asset fixture has problems: ${review.problems.join('; ')}`)
    service.confirmInstall(review.token)
  }
  install(
    new Map([
      [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(diner))],
      ['app/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>diner</title><script type="module" src="./main.js"></script></head><body></body></html>')],
      [
        'app/main.js',
        Buffer.from(
          "const read = async (p) => (await fetch(apex.assets.url('art', p))).text()\nwindow.__assets = { sign: await read('sign.txt'), menu: await read('the menu.txt'), active: await apex.assets.active('art') }\ndocument.title = 'assets ' + (window.__assets.active ? window.__assets.active.set : 'own')\n",
        ),
      ],
      ['app/art/sign.txt', Buffer.from('own sign')],
      ['app/art/the menu.txt', Buffer.from('own menu')],
    ]),
  )
  install(new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(winter))], ['winter/sign.txt', Buffer.from('winter sign')]]))
  const options = service.stateNow().packs.find((p) => p.id === DINER_ID)?.assetSlots[0]?.options ?? []
  assert(options.some((o) => o.value === `${WINTER_ID}/winter`), `the diner’s art slot doesn’t offer the winter set: ${JSON.stringify(options)}`)

  runtime.openApp(DINER_ID, 'main')
  const url = packUrl(DINER_ID, 'app/index.html')
  let tab: Tab | undefined
  await waitFor(() => {
    tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
    return Boolean(tab)
  }, 5000, 'the diner tab')
  const wc = (tab as Tab).view.webContents
  try {
    await waitFor(() => js<boolean>(wc, 'document.title === "assets own"').catch(() => false), 10_000, 'the diner with its own art')
    const own = await js<{ sign: string; menu: string }>(wc, 'window.__assets')
    assert(own.sign === 'own sign' && own.menu === 'own menu', `the app’s own art: ${JSON.stringify(own)}`)
    service.chooseAssets(DINER_ID, 'main', 'art', `${WINTER_ID}/winter`)
    await waitFor(() => js<boolean>(wc, 'document.title === "assets winter"').catch(() => false), 10_000, 'the diner to reload with the winter set')
    const chosen = await js<{ sign: string; menu: string; active: { setName: string } }>(wc, 'window.__assets')
    assert(chosen.sign === 'winter sign', `the asset pack’s file: ${chosen.sign}`)
    assert(chosen.menu === 'own menu', `a file the asset pack lacks comes from the app: ${chosen.menu}`)
    assert(chosen.active.setName === 'Winter', 'apex.assets.active does not name the chosen set')
  } finally {
    if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
  }
}

/** A kit app (docs/apps.md › The kit): bare imports of three and apex-kit resolve, and a companion stands in its own scene. */
async function kitAppRuns(ctx: SmokeContext): Promise<void> {
  const { service, runtime } = need()
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: KIT_ID,
    name: 'Smoke kit',
    version: '1.0.0',
    description: 'A companion in an app’s own scene.',
    contributes: { apps: [{ id: 'main', name: 'Smoke kit', root: 'app', entry: 'index.html', build: 'kit', kind: 'game', kit: 1, cast: { min: 1, max: 2 } }] },
    permissions: { ...NO_PACK_PERMISSIONS, model: true, speak: true },
  }
  const script = [
    "import * as THREE from 'three'",
    "import { character } from 'apex-kit/character.js'",
    'const [me] = await apex.cast.members()',
    'const look = me.look',
    'const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })',
    'renderer.setSize(256, 256)',
    'document.body.append(renderer.domElement)',
    'const scene = new THREE.Scene()',
    'scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2))',
    'const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50)',
    'camera.position.set(0, 0.7, 3.4)',
    "const pip = await character(look, { mood: 'happy' })",
    'scene.add(pip.object3d)',
    'pip.update(0.016)',
    'renderer.render(scene, camera)',
    'let meshes = 0',
    'pip.object3d.traverse((o) => { if (o.isMesh) meshes++ })',
    'window.__kit = { revision: THREE.REVISION, meshes, member: { ref: me.ref, name: me.name } }',
    "const { guide } = await import('apex-kit/guide.js')",
    'const g = await guide({ size: 140 })',
    "g.say('Welcome to the smoke test!', { mood: 'happy' })",
    "window.__guide = { name: g.name, bubble: document.querySelector('[data-apex-guide] [role=status]').textContent, canvas: Boolean(document.querySelector('[data-apex-guide] canvas')) }",
    "document.title = 'kit ready'",
  ].join('\n')
  const files: PackFiles = new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest))],
    ['app/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>kit</title><script type="module" src="./main.js"></script></head><body></body></html>')],
    ['app/main.js', Buffer.from(`${script}\n`)],
  ])
  const review = service.reviewArchive(encodeArchive(files, null), { kind: 'file' })
  assert(review.problems.length === 0, `the kit app has problems: ${review.problems.join('; ')}`)
  service.confirmInstall(review.token)
  runtime.openApp(KIT_ID, 'main')
  const url = packUrl(KIT_ID, 'app/index.html')
  let tab: Tab | undefined
  await waitFor(() => {
    tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
    return Boolean(tab)
  }, 5000, 'the kit app’s tab')
  const wc = (tab as Tab).view.webContents
  try {
    await waitFor(() => js<boolean>(wc, 'document.title === "kit ready"').catch(() => false), 20_000, 'the kit app to build a companion')
    const kit = await js<{ revision: string; meshes: number; member: { ref: string; name: string } }>(wc, 'window.__kit')
    assert(kit.revision === '186', `three from the kit: ${kit.revision}`)
    assert(kit.meshes >= 5, `the companion from apex-kit/character.js has ${kit.meshes} meshes`)
    assert(/^[0-9a-f]{16}$/.test(kit.member.ref) && kit.member.name.length > 0, `apex.cast.members: ${JSON.stringify(kit.member)}`)
    const guided = await js<{ name: string; bubble: string; canvas: boolean }>(wc, 'window.__guide')
    assert(guided.bubble === 'Welcome to the smoke test!' && guided.canvas && guided.name === kit.member.name, `apex-kit/guide.js: ${JSON.stringify(guided)}`)
    // The person picks who plays (the smoke run answers the chooser), and a member says a line in character.
    const realPrompt = runtime.castPrompt
    let asked = 0
    runtime.castPrompt = async () => (asked++ === 0 ? 0 : null)
    try {
      const picked = await js<Array<{ ref: string }>>(wc, 'apex.cast.pick({ max: 2 })')
      assert(picked.length === 1 && asked === 2, `apex.cast.pick: ${JSON.stringify(picked)} after ${asked} questions`)
    } finally {
      runtime.castPrompt = realPrompt
    }
    const line = await js<string>(wc, `apex.cast.speak(${JSON.stringify(kit.member.ref)}, { situation: 'won a long rally 11-9', mood: 'proud' })`)
    assert(typeof line === 'string' && line.length > 0, `apex.cast.speak: ${line}`)
    const stranger = await js<string>(wc, "apex.cast.speak('0000000000000000', { situation: 'x' }).then(() => 'spoke', (err) => err.message)")
    assert(/No companion in this app’s cast/.test(stranger), `a ref from nowhere: ${stranger}`)
    await ctx.shot('packs-kit')
  } finally {
    if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
  }
}

/** A companion starts apps from starters and playtests them: it gets frames as images, frame times and the state the app reports. */
async function startersPlay(): Promise<void> {
  const create = clientTool('create_pack')
  const test = clientTool('test_pack')
  assert(create && test, 'the builder tools are not registered')
  for (const [id, starter] of [
    [STARTER_2D, 'game-2d'],
    [STARTER_3D, 'game-3d'],
  ] as const) {
    const made = await create.run({ id, name: `Smoke ${starter}`, description: 'A starter in the smoke test.', starter }, toolCtx())
    assert(!made.isError && made.content.includes('app/main.js'), `create_pack with the ${starter} starter: ${made.content.slice(0, 200)}`)
    const played = await test.run({ id, playtest: { width: 800, height: 600, steps: [{ capture: 'start' }, { key: 'ArrowRight', holdMs: 600 }, { capture: 'after moving right' }] } }, toolCtx())
    const report = JSON.parse(played.content) as { ok: boolean; playtest?: { ok: boolean; errors: string[]; frames: { average: number } | null; state: { x?: number } | null; captures: string[] } }
    const p = report.playtest
    assert(p && p.ok, `the ${starter} playtest: ${played.content.slice(0, 600)}`)
    assert(p.errors.length === 0, `the ${starter} starter logged errors: ${p.errors.join(' | ')}`)
    assert((played.images?.length ?? 0) === 2 && p.captures.length === 2, `the ${starter} playtest returned ${played.images?.length ?? 0} images`)
    assert(p.frames !== null && p.frames.average > 0, `the ${starter} playtest measured no frames`)
    assert(typeof p.state?.x === 'number' && p.state.x > (starter === 'game-2d' ? 100 : 0), `holding the right arrow didn’t move the ${starter} player: ${JSON.stringify(p.state)}`)
  }
}

/** A companion builds a world and test_pack shows it to them: a still drawn from the world's camera, not a blank frame. */
async function worldStillShows(): Promise<void> {
  const create = clientTool('create_pack')
  const write = clientTool('write_pack_file')
  const test = clientTool('test_pack')
  assert(create && write && test, 'the builder tools are not registered')
  const { default: town } = await import('../../firstParty/worlds/worlds/harbour-town.json?raw')
  const made = await create.run({ id: STILL_DRAFT, name: 'Smoke world still', description: 'A world in the smoke test.' }, toolCtx())
  assert(!made.isError, `create_pack: ${made.content.slice(0, 200)}`)
  const manifest: PackManifest = { format: 'apex-pack', manifestVersion: 2, id: STILL_DRAFT, name: 'Smoke world still', version: '0.0.1', description: 'A world in the smoke test.', contributes: { worlds: ['worlds/town.json'] }, permissions: { ...NO_PACK_PERMISSIONS } }
  for (const [path, content] of [[PACK_MANIFEST_FILE, JSON.stringify(manifest, null, 2)], ['worlds/town.json', town]] as const) {
    const wrote = await write.run({ id: STILL_DRAFT, path, content }, toolCtx())
    assert(!wrote.isError, `write_pack_file ${path}: ${wrote.content.slice(0, 200)}`)
  }
  const tested = await test.run({ id: STILL_DRAFT }, toolCtx())
  const report = JSON.parse(tested.content) as { ok: boolean; worlds?: Array<{ world: string; ok: boolean; error?: string }> }
  assert(report.worlds?.[0]?.ok === true, `the world still: ${tested.content.slice(0, 600)}`)
  const image = tested.images?.[0]
  assert(image, 'test_pack returned no still of the world')
  const { nativeImage } = await import('electron')
  const bitmap = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64')).toBitmap()
  const colours = new Set<number>()
  for (let i = 0; i < bitmap.length && colours.size < 50; i += 4 * 97) colours.add(((bitmap[i] ?? 0) << 16) | ((bitmap[i + 1] ?? 0) << 8) | (bitmap[i + 2] ?? 0))
  assert(colours.size >= 20, `the still looks blank (${colours.size} colours)`)
}

function providerFixture(): PackFiles {
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: PROVIDER_ID,
    name: 'Smoke scores',
    version: '1.0.0',
    description: 'Keeps scores for the smoke test.',
    contributes: { apps: [{ id: 'main', name: 'Smoke scores', root: 'app', entry: 'index.html', build: 'kit', kind: 'tool', sidebar: true }] },
    permissions: { ...NO_PACK_PERMISSIONS },
    provides: [
      {
        service: 'smoke-scores',
        description: 'The best scores.',
        module: 'svc/scores.js',
        agent: true,
        methods: { top: { input: { type: 'object' } }, add: { input: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } },
      },
    ],
    events: { emits: ['scored'] },
  }
  return new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2))],
    ['svc/scores.js', Buffer.from("export async function top() { return ['module'] }\nexport async function add(input) { return input.n * 2 }\n")],
    ['app/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Scores</title></head><body><p>Scores</p><script type="module" src="./main.js"></script></body></html>')],
    [
      'app/main.js',
      Buffer.from(
        "await apex.services.provide('smoke-scores', { top: async () => ['page'], add: async (input) => input.n * 3 })\nawait apex.status.set({ text: '7 points', badge: 7 })\nwindow.score = () => apex.events.emit('scored', { points: 7 })\ndocument.title = 'serving'\n",
      ),
    ],
  ])
}

function consumerFixture(host: string): PackFiles {
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: CONSUMER_ID,
    name: 'Smoke board',
    version: '1.0.0',
    description: 'Shows the smoke scores.',
    contributes: { panels: [{ id: 'board', title: 'Smoke board', html: 'board.html' }] },
    permissions: { ...NO_PACK_PERMISSIONS, model: true, files: true, notifications: true },
    uses: ['smoke-scores'],
    events: { on: ['smoke-scores/scored'] },
    optionalPermissions: { network: [host], sites: [host] },
  }
  return new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2))],
    ['board.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Board</title></head><body><p>Board</p><script type="module" src="board.js"></script></body></html>')],
    ['board.js', Buffer.from("window.__heard = []\napex.events.on('smoke-scores/scored', (data) => window.__heard.push(data))\ndocument.title = 'listening'\n")],
  ])
}

async function pluginsWork(ctx: SmokeContext): Promise<void> {
  const { service, runtime } = need()
  const install = (files: PackFiles): void => {
    const review = service.reviewArchive(encodeArchive(files, null), { kind: 'file' })
    assert(review.problems.length === 0, `a plugin fixture has problems: ${review.problems.join('; ')}`)
    service.confirmInstall(review.token)
  }
  const host = new URL(ctx.server.http).hostname
  ctx.server.route('/packs/optional', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('asked and allowed')
  })
  install(consumerFixture(host))
  assert(!runtime.isRunning(CONSUMER_ID), 'the board runs without the service it uses')
  const waiting = service.stateNow().packs.find((p) => p.id === CONSUMER_ID)?.waiting ?? []
  assert(waiting.some((w) => w.includes('smoke-scores')), `the board doesn’t say what it waits for: ${JSON.stringify(waiting)}`)
  install(providerFixture())
  await waitFor(() => runtime.isRunning(CONSUMER_ID) && runtime.isRunning(PROVIDER_ID), 5000, 'both packs to run once the service is there')

  // A companion reads the live catalog, then uses the service the scores pack offers it.
  const inspect = clientTool('apex_inspect')
  const useApp = clientTool('use_app')
  assert(inspect && useApp, 'apex_inspect and use_app are not registered')
  const catalog = JSON.parse((await inspect.run({ what: ['services', 'events'] }, toolCtx())).content) as { services: { packs: Array<{ service: string }> }; events: { packs: string[] } }
  assert(catalog.services.packs.some((s) => s.service === 'smoke-scores') && catalog.events.packs.includes('smoke-scores/scored'), 'apex_inspect does not list the running pack’s service and event')
  const used = await useApp.run({ action: 'call', service: 'smoke-scores', method: 'add', input: { n: 5 } }, toolCtx())
  assert(!used.isError && /<pack_tool_result pack="smoke-scores"[^>]*>\s*10\s*</.test(used.content), `use_app did not reach the service: ${used.content.slice(0, 200)}`)

  const openTab = async (open: () => void, url: string, title: string): Promise<Tab> => {
    open()
    let tab: Tab | undefined
    await waitFor(() => {
      tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
      return Boolean(tab)
    }, 5000, `the ${title} tab`)
    await waitFor(() => js<boolean>((tab as Tab).view.webContents, `document.title === ${JSON.stringify(title)}`).catch(() => false), 10_000, `the ${title} page`)
    return tab as Tab
  }
  const board = await openTab(() => runtime.openPanel(CONSUMER_ID, 'board'), packUrl(CONSUMER_ID, 'board.html'), 'listening')
  let app: Tab | null = null
  try {
    const bw = board.view.webContents
    assert((await js<number>(bw, "apex.services.call('smoke-scores', 'add', { n: 21 })")) === 42, 'the service’s module did not answer')
    const misfit = await js<string>(bw, "apex.services.call('smoke-scores', 'add', {}).then(() => 'accepted', (err) => err.message)")
    assert(/doesn't fit/.test(misfit), `an input that doesn’t fit the schema: ${misfit}`)
    const stranger = await js<string>(bw, "apex.services.call('other-service', 'top', {}).then(() => 'accepted', (err) => err.message)")
    assert(/not in this pack's uses/.test(stranger), `a service the board doesn’t use: ${stranger}`)

    // apex.ai on the person's engine (the smoke run's offline stand-in answers): a reply, a stream and JSON that fits a schema.
    const asked0 = await js<string>(bw, "apex.ai.ask('ping the model', { tier: 'fast' })")
    assert(/ping the model/.test(asked0), `apex.ai.ask: ${asked0}`)
    const streamed = await js<{ all: string; pieces: number }>(bw, "(async () => { let pieces = 0; const all = await apex.ai.stream('stream me', { onText: () => pieces++ }); return { all, pieces } })()")
    assert(/stream me/.test(streamed.all) && streamed.pieces >= 1, `apex.ai.stream: ${JSON.stringify(streamed)}`)
    const shaped = await js<{ title?: string }>(bw, "apex.ai.json('Summarise the meeting as JSON', { schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } })")
    assert(typeof shaped.title === 'string' && shaped.title.length > 0, `apex.ai.json: ${JSON.stringify(shaped)}`)

    // apex.files: what the picker gives, a folder it may read and write (never outside it), and files of the person's own it keeps.
    const { mkdtempSync, mkdirSync: mkdir, readFileSync: readFile, writeFileSync: writeFile } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const place = mkdtempSync(join(tmpdir(), 'apex-smoke-files-'))
    writeFile(join(place, 'picked.txt'), 'picked text')
    mkdir(join(place, 'game data'))
    writeFile(join(place, 'game data', 'level one.json'), '{"name":"from the player"}')
    const realPickers = { ...runtime.pickers }
    runtime.pickers.open = async (_c, o) => (o.folder ? [o.title.includes('read and write') ? place : join(place, 'game data')] : [join(place, 'picked.txt')])
    runtime.pickers.save = async () => join(place, 'saved.txt')
    try {
      const opened = await js<Array<{ name: string; text: string }>>(bw, '(async () => (await apex.files.open({})).map((f) => ({ name: f.name, text: new TextDecoder().decode(f.data) })))()')
      assert(opened[0]?.name === 'picked.txt' && opened[0].text === 'picked text', `apex.files.open: ${JSON.stringify(opened)}`)
      const saved = await js<{ saved: boolean }>(bw, "apex.files.save('notes.txt', 'saved by the board')")
      assert(saved.saved && readFile(join(place, 'saved.txt'), 'utf8') === 'saved by the board', 'apex.files.save did not write the file')
      await js(bw, 'apex.files.folder()')
      await js(bw, "apex.files.write('chapters/one.md', 'Chapter one')")
      const listed = await js<Array<{ name: string }>>(bw, "apex.files.list('chapters')")
      assert(listed.some((f) => f.name === 'one.md') && readFile(join(place, 'chapters', 'one.md'), 'utf8') === 'Chapter one', 'apex.files.write and list in the folder')
      const escaped = await js<string>(bw, "apex.files.read('../outside.txt').then(() => 'read', (err) => err.message)")
      assert(/isn’t inside the folder/.test(escaped), `a path outside the folder: ${escaped}`)
      const own = await js<{ files: string[] }>(bw, "apex.files.own({ folder: true, note: 'Choose your game data' })")
      assert(own.files.includes('level one.json'), `apex.files.own: ${JSON.stringify(own)}`)
      const ownText = await js<string>(bw, "fetch(apex.files.ownUrl('level one.json')).then((r) => r.text())")
      assert(ownText === '{"name":"from the player"}', `the person's own file, read back: ${ownText}`)
      service.revokeGranted(CONSUMER_ID)
      const afterRevoke = await js<string>(bw, "apex.files.read('chapters/one.md').then(() => 'read', (err) => err.message)")
      assert(/apex.files.folder\(\) first/.test(afterRevoke), `the folder after Take back: ${afterRevoke}`)
    } finally {
      Object.assign(runtime.pickers, realPickers)
    }

    // Scheduled notifications: one fires on time, a cancelled one never does.
    await js(bw, "apex.notifications.schedule({ id: 'soon', at: Date.now() + 1500, title: 'Dishes ready' })")
    await js(bw, "apex.notifications.schedule({ id: 'never', at: Date.now() + 2000, title: 'Not this one' })")
    await js(bw, "apex.notifications.cancel('never')")
    const pending = await js<Array<{ id: string }>>(bw, 'apex.notifications.list()')
    assert(pending.length === 1 && pending[0]?.id === 'soon', `apex.notifications.list: ${JSON.stringify(pending)}`)
    await waitFor(() => runtime.firedForSmoke.some((f) => f.packId === CONSUMER_ID && f.id === 'soon'), 6000, 'the scheduled notification to fire')
    await new Promise((r) => setTimeout(r, 800))
    assert(!runtime.firedForSmoke.some((f) => f.id === 'never'), 'a cancelled notification fired')

    // Asking for more while it runs: refused before, allowed once the person says yes, gone when taken back.
    const optionalUrl = JSON.stringify(`${ctx.server.http}/packs/optional`)
    const before = await js<string>(bw, `apex.fetch(${optionalUrl}).then((r) => r.text(), (err) => 'refused: ' + err.message)`)
    assert(before.startsWith('refused'), `apex.fetch reached a host it only may ask for: ${before}`)
    const realPrompt = runtime.permissionPrompt
    runtime.permissionPrompt = async () => true
    const asked = await js<{ granted: boolean }>(bw, `apex.permissions.request({ network: [${JSON.stringify(host)}] })`)
    assert(asked.granted === true, 'an allowed request was not granted')
    const after = await js<string>(bw, `apex.fetch(${optionalUrl}).then((r) => r.text(), (err) => 'refused: ' + err.message)`)
    assert(after === 'asked and allowed', `apex.fetch after the grant: ${after}`)
    runtime.permissionPrompt = async () => false
    const no = await js<{ granted: boolean }>(bw, `apex.permissions.request({ sites: [${JSON.stringify(host)}] })`)
    assert(no.granted === false, 'a refused request was granted')
    const outside = await js<string>(bw, "apex.permissions.request({ clipboard: true }).then(() => 'asked', (err) => err.message)")
    assert(/optionalPermissions/.test(outside), `a request outside optionalPermissions: ${outside}`)
    runtime.permissionPrompt = realPrompt
    service.revokeGranted(CONSUMER_ID)
    const revoked = await js<string>(bw, `apex.fetch(${optionalUrl}).then((r) => r.text(), (err) => 'refused: ' + err.message)`)
    assert(revoked.startsWith('refused'), `apex.fetch still works after Take back: ${revoked}`)

    app = await openTab(() => runtime.openApp(PROVIDER_ID, 'main'), packUrl(PROVIDER_ID, 'app/index.html'), 'serving')
    const top = await js<string[]>(bw, "apex.services.call('smoke-scores', 'top')")
    assert(top[0] === 'page', `an open page that serves the service is not preferred: ${JSON.stringify(top)}`)
    await js(app.view.webContents, 'window.score()')
    await waitFor(() => js<boolean>(bw, 'window.__heard.length === 1 && window.__heard[0].points === 7').catch(() => false), 5000, 'the board to hear the scores’ event')
    const row = runtime.sidebar().find((e) => e.packId === PROVIDER_ID && e.kind === 'app')
    assert(row?.status?.text === '7 points' && row.status.badge === 7, `the app’s status on its sidebar row: ${JSON.stringify(row?.status)}`)
  } finally {
    if (ctx.tabs.find(board.id)) ctx.tabs.close(board.id)
    if (app && ctx.tabs.find(app.id)) ctx.tabs.close(app.id)
  }

  service.setEnabled(PROVIDER_ID, false)
  await waitFor(() => !runtime.isRunning(CONSUMER_ID), 5000, 'the board to wait again when the scores pack is off')
}

/**
 * Worlds (docs/apps.md › Worlds): the first-party viewer shows a world of
 * yours with a guest and one of your companions; the guest talks; stepping
 * into a place opens its app, which reads where it came from and finds the
 * residents there as its cast (the guest speaks from it too); Share… saves an
 * .apexworld that reviews and installs as a pack; the editor opens.
 */
async function worldsWork(ctx: SmokeContext): Promise<void> {
  const { service, store, runtime } = need()
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // Worlds comes off, so the browser is as before until someone wants it.
  assert(!store.get('apex-worlds')?.entry.enabled, 'the Worlds pack is on in a new profile')
  store.setEnabled('apex-worlds', true)
  assert(runtime.isRunning('apex-worlds'), 'the Worlds pack did not turn on')
  assert(runtime.worldList().some((w) => w.ref === 'pack:apex-worlds/worlds/harbour-town.json'), 'Harbour town is not among the worlds')

  // The app a place opens: it may cast the person's companions and have them (and guests) speak.
  const placeManifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: PLACE_ID,
    name: 'Smoke place',
    version: '1.0.0',
    description: 'An app a world’s place opens.',
    contributes: { apps: [{ id: 'main', name: 'Smoke hall', root: 'app', entry: 'index.html', build: 'bundled', kind: 'game', cast: { min: 0, max: 8 } }] },
    permissions: { ...NO_PACK_PERMISSIONS, model: true, speak: true },
  }
  const placeFiles: PackFiles = new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(placeManifest))],
    ['app/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>hall</title></head><body>hall</body></html>')],
  ])
  const author = new AuthorKey(mkdtempSync(join(tmpdir(), 'apex-smoke-author-')), { encrypt: (b) => b, decrypt: (b) => b })
  const placeReview = service.reviewArchive(encodeArchive(placeFiles, author.sign(packHash(placeFiles))), { kind: 'file' })
  assert(placeReview.problems.length === 0, `the place app: ${placeReview.problems.join('; ')}`)
  service.confirmInstall(placeReview.token)

  const look = { rig: 'A', parts: { head: 'head-round', ears: null, hair: 'hair-tuft', hat: null, eyeAccessory: null, earAccessory: null, prop: null }, face: { eyes: 'eyes-round', brows: 'brows-soft', mouth: 'mouth-smile' }, colors: { skin: '#ffd2a8', hair: '#c0583c', accent: '#fff3c4', outfit: '#e0705a' } }
  runtime.worldSave(
    {
      format: 'apex-world',
      version: 1,
      id: TOWN,
      name: 'Smoke town',
      palette: 'seaside',
      sky: 'midday',
      size: [24, 16],
      ground: { base: 'grass', paint: [{ type: 'path', area: [0, 7, 23, 8] }] },
      props: [{ kit: 'table-tennis-table', at: [16.5, 0, 4] }, { kit: 'tree', at: [3, 0, 3] }],
      places: [{ id: 'hall', name: 'Smoke hall', area: [13, 1, 20, 6], opens: { pack: PLACE_ID, app: 'main' } }],
      residents: [
        { id: 'tilly', home: 'hall', at: [15, 5], role: 'Coaches table tennis', guest: { name: 'Tilly', look, personality: 'Cheerful and competitive.' } },
        { id: 'mine', home: 'hall', at: [18, 5], companion: 'local' },
      ],
      spawn: [12, 10],
    },
    false,
  )
  const ref = `own:${TOWN}`
  let viewer: Tab | undefined
  let hall: Tab | undefined
  try {
    runtime.openApp('apex-worlds', 'main', null, `world=${encodeURIComponent(ref)}`)
    const viewerUrl = packUrl('apex-worlds', 'app/index.html')
    await waitFor(() => {
      viewer = ctx.tabs.all().find((t) => t.requestedUrl.startsWith(viewerUrl))
      return Boolean(viewer)
    }, 5000, 'the Worlds tab')
    const wc = (viewer as Tab).view.webContents
    const pageErrors: string[] = []
    wc.on('console-message', (event) => {
      if (event.level === 'error' && pageErrors.length < 5) pageErrors.push(event.message.slice(0, 200))
    })
    await waitForPage(wc, 'the world viewer', 10_000, (at) => at.startsWith('apex-pack://apex-worlds/'))
    // Tilly is a guest; the open spot gets one of your other companions if you have one, never the one you walk as.
    // The world's first frames compile its shadowed scene's shaders while three companions load; where WebGL is
    // software (a CI machine without a GPU) that takes a while, so the wait is long and says where it stopped.
    await waitFor(() => js<boolean>(wc, `Boolean(window.__worlds && window.__worlds.screen === 'visit' && window.__worlds.stage.people.some((p) => p.name === 'Tilly'))`).catch(() => false), 45_000, 'the world with its residents').catch(async (err: unknown) => {
      const at = await js<unknown>(wc, `window.__worlds ? { screen: window.__worlds.screen, opening: window.__worlds.opening, world: window.__worlds.current?.world.id ?? null, people: window.__worlds.stage.people.map((p) => p.name), notes: [document.getElementById('home-note')?.textContent, document.getElementById('stage-note')?.textContent].filter(Boolean) } : 'no viewer'`).catch(() => 'no page')
      throw new Error(`${err instanceof Error ? err.message : String(err)} So far: ${JSON.stringify(at)}${pageErrors.length ? `; page errors: ${pageErrors.join(' | ')}` : ''}`)
    })
    const shown = await js<{ world: string; people: string[]; me: string | null; scene: number }>(wc, `(async () => ({ world: window.__worlds.stage.world.id, people: window.__worlds.stage.people.map((p) => p.name), me: (await apex.cast.members())[0]?.name ?? null, scene: window.__worlds.stage.scene.children.length }))()`)
    assert(shown.world === TOWN && shown.scene > 2, `the viewer shows ${JSON.stringify(shown)}`)
    assert(shown.me !== null && !shown.people.includes(shown.me), `the companion you walk as also lives in the world: ${JSON.stringify(shown)}`)
    const line = await js<string>(wc, `apex.worlds.speak(${JSON.stringify(ref)}, 'tilly', { situation: 'Someone walks up to say hello.' })`)
    assert(typeof line === 'string' && line.length > 0, 'the guest said nothing')

    // Stepping in: the place's app opens, knows where it came from, and has the residents as its cast.
    const entered = await js<{ opened: boolean }>(wc, `apex.worlds.enter(${JSON.stringify(ref)}, 'hall')`)
    assert(entered.opened, 'stepping into the hall opened nothing')
    const hallUrl = packUrl(PLACE_ID, 'app/index.html')
    await waitFor(() => {
      hall = ctx.tabs.all().find((t) => t.requestedUrl === hallUrl)
      return Boolean(hall)
    }, 5000, 'the hall’s app')
    const hwc = (hall as Tab).view.webContents
    await waitForPage(hwc, 'the hall’s app', 10_000, (at) => at.startsWith(`apex-pack://${PLACE_ID}/`))
    const context = await js<{ world: { name: string }; place: { id: string }; cast: Array<{ ref: string; name: string; guest: boolean }> } | null>(hwc, 'apex.world.context()')
    assert(context?.world.name === 'Smoke town' && context.place.id === 'hall', `the app’s world context: ${JSON.stringify(context)}`)
    // You first (the companion you walked in as), then whoever lives there.
    assert(context.cast[0]?.name === shown.me && !context.cast[0]?.guest && context.cast.some((c) => c.guest && c.name === 'Tilly'), `the hall’s cast: ${JSON.stringify(context.cast)}`)
    const guest = context.cast.find((c) => c.guest) as { ref: string }
    const said = await js<string>(hwc, `apex.cast.speak(${JSON.stringify(guest.ref)}, { situation: 'You won a point.' })`)
    assert(typeof said === 'string' && said.length > 0, 'the guest said nothing in the hall’s app')

    // Share…: an .apexworld that reviews as a pack holding just the world, and installs.
    const saved = await js<string | null>(wc, `apex.worlds.share(${JSON.stringify(ref)})`)
    assert(typeof saved === 'string' && saved.endsWith('.apexworld'), `Share… saved ${String(saved)}`)
    const review = service.reviewArchive(readFileSync(saved as string), { kind: 'file' })
    assert(review.problems.length === 0 && review.permissions.some((l) => l.kind === 'worlds'), `the shared world’s review: ${review.problems.join('; ')}`)
    service.confirmInstall(review.token)
    // The shared pack's id carries your key, so two people's copies of a world never collide.
    assert(review.id.startsWith(`world-${TOWN}-`), `the shared world’s pack id: ${review.id}`)
    assert(store.isActive(review.id) && runtime.worldList().some((w) => w.ref === `pack:${review.id}/worlds/${TOWN}.json`), 'the shared world did not install as a world')

    // The editor.
    await js(wc, `location.hash = 'edit=' + encodeURIComponent(${JSON.stringify(ref)})`)
    await waitFor(() => js<boolean>(wc, `window.__worlds.screen === 'edit' && !document.getElementById('tools').hidden && document.querySelectorAll('#tools button').length > 5`).catch(() => false), 10_000, 'the editor and its tools')
    await ctx.shot('packs-worlds')
  } finally {
    for (const tab of [hall, viewer]) if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
    store.setEnabled('apex-worlds', false)
  }
}

/**
 * Browse (docs/apps.md › The community index): an index lists an app with its
 * picture and shelf and withdraws another; Browse never offers the withdrawn
 * one, main fetches the picture, and Browse opens at one pack (what a world's
 * place does when its app is missing) with that pack's card and picture.
 */
async function browseShowsApps(ctx: SmokeContext): Promise<void> {
  const { service, store } = need()
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  ctx.server.route('/packs/card.png', (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })
  const sha = 'a'.repeat(64)
  const index = {
    format: 'apex-pack-index',
    name: 'Smoke index',
    packs: [
      { id: 'smoke-browse-app', name: 'Smoke arcade', description: 'A game in the smoke index.', version: '1.0.0', url: `${ctx.server.http}/packs/none.apexapp`, sha256: sha, kind: 'app', category: 'games', size: 1_200_000, color: '#ff8a5c', image: `${ctx.server.http}/packs/card.png` },
      { id: 'smoke-gone', name: 'Withdrawn', description: 'Never offered.', version: '1.0.0', url: `${ctx.server.http}/packs/gone.apexpack`, sha256: sha },
    ],
    withdrawn: [{ id: 'smoke-gone', reason: 'Smoke test.' }],
  }
  ctx.server.route('/packs/index.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(index))
  })
  const url = `${ctx.server.http}/packs/index.json`
  store.saveIndex({ url, name: 'Smoke index', addedAt: Date.now(), lastError: null })
  try {
    const listed = await service.browse()
    const app = listed.find((e) => e.id === 'smoke-browse-app')
    assert(app?.kind === 'app' && app.hasImage && app.category === 'games', `the index’s app: ${JSON.stringify(app)}`)
    assert(!listed.some((e) => e.id === 'smoke-gone'), 'Browse offers a withdrawn id')
    const image = await service.browseImage(url, 'smoke-browse-app')
    assert(typeof image === 'string' && image.startsWith('data:image/png;base64,'), 'main did not fetch the picture')

    ctx.tabs.openInternal('apex://packs?tab=browse&find=smoke-browse-app')
    await ctx.chrome.until(
      `const cards = [...document.querySelectorAll('.pk-browse__card')]
       const search = document.querySelector('.sp-dest-toolbar input[type="search"]')
       return cards.length === 1 && cards[0].textContent.includes('Smoke arcade') && Boolean(cards[0].querySelector('img[src^="data:image/png"]')) && search && search.value === 'smoke-browse-app'`,
      10_000,
      'Browse at the arcade, with its picture',
    )
    await ctx.shot('packs-browse')
  } finally {
    store.removeIndex(url)
  }
}

/**
 * An organisation's policy (docs/apps.md › Apps for organisations): its env
 * values and key reach an app's pages and its requests, the Packs page says
 * what is managed and offers no install from a file, a sideloaded pack is
 * refused in its review, and a pack it blocks stops running.
 */
async function policyApplies(ctx: SmokeContext): Promise<void> {
  const { service, store, runtime } = need()
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  ctx.server.route('/packs/org', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': String(req.headers.origin ?? '*'), 'access-control-allow-headers': 'authorization' })
    res.end(JSON.stringify({ auth: req.headers.authorization ?? null }))
  })
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: ORG_ID,
    name: 'Smoke org',
    version: '1.0.0',
    description: 'A company tool whose server and key the organisation sets.',
    contributes: { apps: [{ id: 'main', name: 'Smoke org', root: 'app', entry: 'index.html', build: 'bundled', kind: 'tool' }] },
    permissions: { ...NO_PACK_PERMISSIONS, network: ['127.0.0.1'] },
    env: { SERVER: 'https://example.invalid' },
    secrets: [{ id: 'ORG_KEY', name: 'Company key', hosts: ['127.0.0.1'], header: 'Authorization', prefix: 'Bearer ' }],
  }
  const files: PackFiles = new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest))],
    ['app/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>org</title></head><body>org</body></html>')],
  ])
  const author = new AuthorKey(mkdtempSync(join(tmpdir(), 'apex-smoke-author-')), { encrypt: (b) => b, decrypt: (b) => b })
  const archive = encodeArchive(files, author.sign(packHash(files)))
  service.confirmInstall(service.reviewArchive(archive, { kind: 'file' }).token)
  const { policy, problems } = parsePolicy({ PackSideloading: false, AppConfig: { [ORG_ID]: { env: { SERVER: ctx.server.http }, secrets: { ORG_KEY: 'org-key-123456789' } } } }, 'smoke')
  assert(problems.length === 0, `the smoke policy: ${problems.join('; ')}`)
  store.setPolicy(policy)
  let tab: Tab | undefined
  try {
    runtime.openApp(ORG_ID, 'main')
    const url = packUrl(ORG_ID, 'app/index.html')
    await waitFor(() => {
      tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
      return Boolean(tab)
    }, 5000, 'the company tool’s tab')
    const wc = (tab as Tab).view.webContents
    await waitForPage(wc, 'the company tool', 10_000, (at) => at.startsWith(`apex-pack://${ORG_ID}/`))
    const env = await js<string>(wc, 'apex.env.SERVER')
    assert(env === ctx.server.http, `the organisation’s SERVER did not reach apex.env: ${env}`)
    const status = await js<Record<string, boolean>>(wc, 'apex.secrets.status()')
    assert(status.ORG_KEY === true, 'the organisation’s key does not count as set')
    const got = await js<{ auth: string | null }>(wc, `fetch(apex.env.SERVER + '/packs/org').then((r) => r.json())`)
    assert(got.auth === 'Bearer org-key-123456789', `the organisation’s key was not on the request: ${JSON.stringify(got)}`)
    assert(service.summary(ORG_ID).secrets[0]?.state === 'policy', 'the pack’s page does not say the organisation set the key')

    // A file install is refused, and the Packs page says why instead of offering it.
    const refused = service.reviewArchive(archive, { kind: 'file' })
    assert(refused.problems.some((p) => /only from its indexes/.test(p)), `a sideloaded review: ${refused.problems.join('; ')}`)
    ctx.tabs.openInternal('apex://packs')
    await ctx.chrome.until(
      `const text = document.body.innerText
       return text.includes('Your organisation lets packs in only from Browse.') && ![...document.querySelectorAll('button')].some((b) => /Install from file|From a file|^Add$/i.test((b.textContent || '').trim()))`,
      10_000,
      'the Packs page under the policy',
    )

    // Blocked: it stops running.
    store.setPolicy(parsePolicy({ PackBlocklist: [ORG_ID] }, 'smoke').policy)
    assert(!runtime.isRunning(ORG_ID), 'a blocked pack still runs')
  } finally {
    store.setPolicy(NO_POLICY)
    if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
    if (store.get(ORG_ID)) service.remove(ORG_ID)
  }
}

/**
 * The company's identity provider and API, on this computer: OpenID discovery,
 * an authorization page that sends the browser straight back (as a provider
 * you are already signed in to does), a token endpoint that checks PKCE and the
 * client, and an API that says what Authorization it got. It also serves the
 * dashboard's archive for the policy to force-install.
 */
async function startCompany(archive: Buffer): Promise<{ base: string; signIns: () => number; gatewayCalls: string[]; close(): void }> {
  const { createServer } = await import('node:http')
  const { createHash } = await import('node:crypto')
  let base = ''
  let challenge = ''
  let signIns = 0
  const gatewayCalls: string[] = []
  const idToken = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ email: 'ana@contoso.example' })).toString('base64url'), 'sig'].join('.')
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (status: number, body: unknown, extra: Record<string, string> = {}): void => void res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(body))
    if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] })
    if (url.pathname === '/authorize') {
      if (url.searchParams.get('client_id') !== 'smoke-company') return void res.writeHead(400).end('unknown client')
      challenge = url.searchParams.get('code_challenge') ?? ''
      const back = new URL(url.searchParams.get('redirect_uri') ?? '')
      back.searchParams.set('code', 'company-code')
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      return void res.writeHead(302, { location: back.href }).end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = ''
      req.on('data', (d: Buffer) => (raw += d.toString('utf8')))
      req.on('end', () => {
        const body = new URLSearchParams(raw)
        const verified = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') === challenge
        if (body.get('code') !== 'company-code' || !verified || body.get('client_id') !== 'smoke-company') return json(400, { error: 'invalid_grant' })
        signIns++
        json(200, { access_token: 'company-token-1', refresh_token: 'company-refresh-1', expires_in: 3600, id_token: idToken, token_type: 'Bearer' })
      })
      return
    }
    if (url.pathname === '/api/me') return json(200, { auth: req.headers.authorization ?? null }, { 'access-control-allow-origin': String(req.headers.origin ?? '*') })
    // The company's model gateway: Anthropic's Messages API, behind the organisation's token, with its own model names.
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      let raw = ''
      req.on('data', (d: Buffer) => (raw += d.toString('utf8')))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { model?: string }
        if (req.headers.authorization !== 'Bearer gateway-token') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'no token' } })
        gatewayCalls.push(String(body.model))
        json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'From the Contoso gateway.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 5 } })
      })
      return
    }
    if (url.pathname === '/dashboard.apexapp') return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(archive)
    // The company's private index: only for someone signed in.
    if (url.pathname === '/index.json') {
      if (req.headers.authorization !== 'Bearer company-token-1') return void res.writeHead(401).end()
      const sha = createHash('sha256').update(archive).digest('hex')
      return json(200, { format: 'apex-pack-index', name: 'Contoso apps', packs: [{ id: 'smoke-dashboard', name: 'Smoke dashboard', description: 'The team’s numbers.', version: '1.0.0', url: `${base}/dashboard.apexapp`, sha256: sha, kind: 'app' }] })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { base, signIns: () => signIns, gatewayCalls, close: () => server.close() }
}

/**
 * A company's app (docs/apps.md › Apps for organisations): the policy
 * force-installs the dashboard from the company's address and points its
 * sign-in at the company's own identity provider and client (AppConfig); the
 * app signs in through Apex in a tab, its requests to the company's API carry
 * the token (the app never sees it), it reads one of the person's connectors
 * (a tool set to ask asks them), the audit log notes where it all went, and
 * signing out takes the token off.
 */
async function companyAppWorks(ctx: SmokeContext): Promise<void> {
  const { service, store, runtime } = need()
  const { createHash } = await import('node:crypto')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id: DASH_ID,
    name: 'Smoke dashboard',
    version: '1.0.0',
    description: 'The team’s numbers, from the company’s API.',
    contributes: { apps: [{ id: 'main', name: 'Smoke dashboard', root: 'app', entry: 'index.html', build: 'bundled', kind: 'tool' }] },
    permissions: { ...NO_PACK_PERMISSIONS, network: ['127.0.0.1'], connectors: [NOTES_CONNECTOR], model: true },
    env: { API: 'https://api.contoso.example' },
    // The author's defaults; the organisation's AppConfig names its own provider and client.
    auth: [{ id: 'corp', name: 'Contoso account', issuer: 'https://login.contoso.example', clientId: 'dashboard', scopes: ['openid', 'email'], hosts: ['127.0.0.1'] }],
  }
  const files: PackFiles = new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest))],
    ['app/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>dashboard</title></head><body>dashboard</body></html>')],
  ])
  const author = new AuthorKey(mkdtempSync(join(tmpdir(), 'apex-smoke-author-')), { encrypt: (b) => b, decrypt: (b) => b })
  const archive = encodeArchive(files, author.sign(packHash(files)))
  const company = await startCompany(archive)
  const address = `${company.base}/dashboard.apexapp`
  // The person's notes connector: the MCP fixture as a local server they approved, run by the Node that runs the smoke.
  const { appRoot } = await import('../resources')
  const notes = await ctx.chrome.invoke<{ id: string }>('connectors', 'save', {
    name: NOTES_CONNECTOR,
    displayName: 'Smoke notes',
    // A packaged run has no tests/ inside its asar: smoke-packaged.mjs points APEX_SMOKE_FIXTURES at the repo's.
    transport: { kind: 'local', command: 'node', args: [join(process.env.APEX_SMOKE_FIXTURES ?? join(appRoot(), 'tests', 'fixtures'), 'mcp', 'echo-server.mjs')], env: [], cwd: null },
    auth: 'none',
    enabled: true,
  })
  let tab: Tab | undefined
  const realPrompt = runtime.permissionPrompt
  try {
    await ctx.chrome.invoke('connectors', 'approveLocalStart', notes.id)
    const checked = await ctx.chrome.invoke<{ tools: Array<{ name: string; policy: string }> }>('connectors', 'check', notes.id)
    assert(checked.tools.some((t) => t.name === 'echo' && t.policy === 'allow') && checked.tools.some((t) => t.name === 'create_note' && t.policy === 'ask'), `the notes connector’s tools: ${JSON.stringify(checked.tools)}`)
    // http on this computer stands in for the company's https address (the policy file itself takes https only).
    store.setPolicy({
      ...NO_POLICY,
      managed: true,
      source: 'smoke',
      audit: true,
      forceInstall: [{ url: address, sha256: createHash('sha256').update(archive).digest('hex') }],
      appConfig: { [DASH_ID]: { env: { API: company.base }, auth: { corp: { issuer: company.base, clientId: 'smoke-company' } } } },
      aiProvider: { url: company.base, key: null, token: 'gateway-token', models: { fast: 'contoso-fast' } },
    })
    const problems = await service.applyPolicy()
    assert(problems.length === 0, `force-installing the dashboard: ${problems.join('; ')}`)
    assert(store.isForced(DASH_ID) && runtime.isRunning(DASH_ID), 'the policy did not install and turn on the dashboard')
    const before = service.summary(DASH_ID).signIns[0]
    assert(before?.managed === true && before.signedIn === false && before.issuer === new URL(company.base).host, `the pack’s page before signing in: ${JSON.stringify(before)}`)

    runtime.openApp(DASH_ID, 'main')
    const url = packUrl(DASH_ID, 'app/index.html')
    await waitFor(() => {
      tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
      return Boolean(tab)
    }, 5000, 'the dashboard’s tab')
    const wc = (tab as Tab).view.webContents
    await waitForPage(wc, 'the dashboard', 10_000, (at) => at.startsWith(`apex-pack://${DASH_ID}/`))
    const me = (): Promise<{ auth: string | null }> => js<{ auth: string | null }>(wc, `fetch(apex.env.API + '/api/me').then((r) => r.json())`)
    const signedOut = await js<Record<string, { signedIn: boolean }>>(wc, 'apex.auth.status()')
    assert(signedOut.corp?.signedIn === false, `apex.auth.status before signing in: ${JSON.stringify(signedOut)}`)
    assert((await me()).auth === null, 'a request carried a sign-in before anyone signed in')

    const tabsBefore = ctx.tabs.all().length
    const signedIn = await js<{ signedIn: boolean; user: string | null }>(wc, "apex.auth.signIn('corp')")
    assert(signedIn.signedIn && signedIn.user === 'ana@contoso.example', `apex.auth.signIn: ${JSON.stringify(signedIn)}`)
    assert(company.signIns() === 1, 'the company’s provider did not hand out a token')
    await waitFor(() => ctx.tabs.all().length === tabsBefore && ctx.tabs.active()?.id === (tab as Tab).id, 5000, 'the sign-in tab to close and the dashboard to come back')
    const got = await me()
    assert(got.auth === 'Bearer company-token-1', `the company’s API did not get the sign-in: ${JSON.stringify(got)}`)
    const page = await js<string>(wc, 'JSON.stringify(Object.keys(apex.auth)) + JSON.stringify(apex.env)')
    assert(!page.includes('company-token-1'), 'the app can read the token')
    const after = service.summary(DASH_ID).signIns[0]
    assert(after?.signedIn === true && after.user === 'ana@contoso.example' && !JSON.stringify(service.summary(DASH_ID)).includes('company-token'), `the pack’s page after signing in: ${JSON.stringify(after)}`)
    const audit = store.logLines(DASH_ID).filter((l) => l.source === 'audit').map((l) => l.message)
    assert(audit.some((m) => m.startsWith('signed in to')) && audit.some((m) => m.startsWith('sign-in sent to 127.0.0.1:')), `the audit log: ${audit.join(' | ')}`)

    // One of the person's connectors: a read-only tool runs; one set to ask asks them, and a no stops it.
    const linked = await js<Record<string, { connected: boolean; name: string | null }>>(wc, 'apex.connectors.status()')
    assert(linked[NOTES_CONNECTOR]?.connected === true && linked[NOTES_CONNECTOR]?.name === 'Smoke notes', `apex.connectors.status: ${JSON.stringify(linked)}`)
    const tools = await js<Array<{ name: string }>>(wc, `apex.connectors.tools(${JSON.stringify(NOTES_CONNECTOR)})`)
    assert(tools.some((t) => t.name === 'echo'), `apex.connectors.tools: ${JSON.stringify(tools)}`)
    const echoed = await js<{ text: string; isError: boolean }>(wc, `apex.connectors.call(${JSON.stringify(NOTES_CONNECTOR)}, 'echo', { text: 'quarterly numbers' })`)
    assert(echoed.text === 'quarterly numbers' && !echoed.isError, `apex.connectors.call echo: ${JSON.stringify(echoed)}`)
    const asked: string[] = []
    runtime.permissionPrompt = async ({ lines }) => (asked.push(...lines), false)
    const declined = await js<string>(wc, `apex.connectors.call(${JSON.stringify(NOTES_CONNECTOR)}, 'create_note', { title: 'Q3' }).then(() => 'ran', (err) => err.message)`)
    assert(declined !== 'ran' && asked.some((l) => l.includes('Smoke notes')), `a tool set to ask ran without asking: ${declined} (${asked.join(' | ')})`)
    runtime.permissionPrompt = async () => true
    const saved = await js<{ text: string }>(wc, `apex.connectors.call(${JSON.stringify(NOTES_CONNECTOR)}, 'create_note', { title: 'Q3' })`)
    assert(saved.text.startsWith('saved') && saved.text.includes('Q3'), `create_note once allowed: ${JSON.stringify(saved)}`)
    const elsewhere = await js<string>(wc, "apex.connectors.call('github', 'search', {}).then(() => 'ran', (err) => err.message)")
    assert(elsewhere !== 'ran', 'an app used a connector it doesn’t name')
    const used = service.summary(DASH_ID).connectorsUsed[0]
    assert(used?.connected === true && used.name === 'Smoke notes', `the pack’s page: ${JSON.stringify(used)}`)
    const calls = store.logLines(DASH_ID).filter((l) => l.source === 'audit').map((l) => l.message)
    assert(calls.includes(`connectors.call ${NOTES_CONNECTOR} echo`), `the audit log for connectors: ${calls.join(' | ')}`)

    // The organisation's model gateway answers apex.ai, under its own token and model name.
    const answer = await js<string>(wc, "apex.ai.ask('How did the quarter go?', { tier: 'fast' })")
    assert(answer === 'From the Contoso gateway.' && company.gatewayCalls.includes('contoso-fast'), `apex.ai under the organisation’s gateway: ${answer} (${company.gatewayCalls.join(', ')})`)
    assert(service.stateNow().policy.aiProvider, 'the Packs page does not say apps use the organisation’s AI service')

    await js(wc, "apex.auth.signOut('corp')")
    assert((await me()).auth === null, 'a request still carried the sign-in after signing out')

    // The company's private index: Browse asks to sign in first, then lists what it offers.
    const indexUrl = `${company.base}/index.json`
    store.setPolicy({ ...store.policy, indexes: [indexUrl], indexAuth: { [indexUrl]: { name: 'Contoso apps', issuer: company.base, clientId: 'smoke-company', scopes: [] } } })
    assert((await service.browse()).length === 0, 'Browse read the private index before anyone signed in')
    ctx.tabs.openInternal('apex://packs?tab=browse')
    await ctx.chrome.until(
      `return document.body.innerText.includes('Contoso apps is your organisation’s.') && [...document.querySelectorAll('.sp-notice button')].some((b) => /Sign in/.test(b.textContent || ''))`,
      10_000,
      'Browse offering Sign in for the private index',
    )
    await ctx.chrome.invoke('packs', 'signInIndex', indexUrl)
    const listed = await service.browse()
    assert(listed.some((e) => e.id === DASH_ID && e.indexUrl === indexUrl), `the private index after signing in: ${JSON.stringify(listed.map((e) => e.id))}`)
    ctx.tabs.openInternal(`apex://packs?tab=browse&find=${DASH_ID}`)
    await ctx.chrome.until(
      `return !document.body.innerText.includes('Contoso apps is your organisation’s.') && [...document.querySelectorAll('.pk-browse__card')].some((c) => c.textContent.includes('Smoke dashboard'))`,
      10_000,
      'Browse showing the private index’s app',
    )
  } finally {
    runtime.permissionPrompt = realPrompt
    await ctx.chrome.invoke('connectors', 'remove', notes.id).catch(() => undefined)
    store.setPolicy(NO_POLICY)
    if (tab && ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
    if (store.get(DASH_ID)) service.remove(DASH_ID)
    company.close()
  }
  assert(need().store.signInFile.get(DASH_ID, 'corp') === null, 'a removed pack’s sign-in was kept')
}

/**
 * Creator mode (docs/apps.md › Creator mode): a chat has the switch and not the
 * builder; once its companion turns the mode on, the builder tools join the
 * chat at the next step of the same turn and the companion builds with them.
 */
async function creatorModeJoins(ctx: SmokeContext): Promise<void> {
  const plain = ctx.host.start('smoke-creator: hello')
  await waitFor(() => !ctx.host.isRunning(plain), 15_000, 'a plain chat to answer')
  const before = ctx.host.systemPromptView({ chatId: plain }).tools
  assert(before.includes('creator_mode') && !before.includes('create_pack'), `a plain chat’s tools: ${before.filter((t) => /pack|creator|inspect/.test(t)).join(', ')}`)

  const id = ctx.host.start('smoke-creator: make me a counter')
  await waitFor(() => !ctx.host.isRunning(id), 20_000, 'the Creator chat to finish')
  const tools = ctx.host.systemPromptView({ chatId: id }).tools
  assert(tools.includes('create_pack') && tools.includes('test_pack') && tools.includes('apex_inspect'), `the builder did not join the chat: ${tools.join(', ')}`)
  assert(need().store.hasDraft(CREATOR_DRAFT), 'create_pack, called after creator_mode in the same turn, made no draft')
}

export const packsSmoke: SmokeGroup = {
  group: 'PACKS',
  checks: [
    { name: 'a signed pack installs only after its review, and its skill, command and tweak appear', run: installs },
    { name: 'a pack tool reads only its sites, fetches only its hosts, and has no network or Node of its own', run: toolRuns },
    { name: 'a pack panel opens in its own sandboxed tab and can’t leave it', run: panelStays },
    { name: 'turning a pack off takes its skill, tool, tweak and panel away', run: offTakesAway },
    { name: 'an app pack’s game runs its own module, worker, WebAssembly, image, sound and data in its own tab, with no network, and only the game goes full screen', run: appRuns },
    { name: 'a build tool’s output runs as it is: its inline bootstrap, root paths, page files, client routes and cross-origin isolation', run: buildOutputRuns },
    { name: 'developer mode: a linked folder reloads its open app when a file changes, its .env fills apex.env and is never served, and unlinking keeps the folder', run: devFolderReloads },
    { name: 'an app reaches its own server (fetch, preflight, image, WebSocket) with normal CORS and nothing else; the key the person enters goes to its host only', run: serversWork },
    {
      name: 'an app’s own web server (phones as controllers): its folder and routes on this computer and over TLS on the Wi-Fi, a phone’s frames reach the page in order, a wrong token gets nothing, Apex’s bar sits over the app with Stop, no Wi-Fi without lan, and closing the app stops it',
      run: serverWorks,
    },
    { name: 'a kit app imports three and apex-kit by name and builds a companion in its own scene', run: kitAppRuns },
    { name: 'a companion starts apps from the 2D and 3D starters and playtests them: frames as images, frame times and the state it reports', run: async () => startersPlay() },
    { name: 'a companion builds a world and test_pack shows it a still from the world’s camera', run: async () => worldStillShows() },
    {
      name: 'worlds: the viewer shows a world with a guest and your companion, places open their app with the residents as its cast, and Share… makes an .apexworld that installs',
      run: async (ctx) => {
        try {
          await worldsWork(ctx)
        } finally {
          cleanup()
        }
      },
    },
    { name: 'Browse lists apps with their picture and shelf, never a withdrawn id, and opens at one pack', run: browseShowsApps },
    { name: 'an organisation’s policy: its values and key reach an app, the Packs page says what is managed, sideloads are refused, blocked packs stop', run: policyApplies },
    { name: 'a company’s app: the policy force-installs it with the company’s own sign-in; it signs in through Apex, its API gets the token and the app never does, it reads the person’s connector as they set it, its model calls go to the organisation’s gateway, and the audit log says where it went', run: companyAppWorks },
    {
      name: 'Creator mode: a chat has the switch, not the builder; once on, the builder joins the chat mid-turn and the companion builds with it',
      run: async (ctx) => {
        try {
          await creatorModeJoins(ctx)
        } finally {
          cleanup()
        }
      },
    },
    {
      name: 'an asset pack fills an app’s art slot when the person picks it; files it lacks come from the app',
      run: async (ctx) => {
        try {
          await assetPacksWork(ctx)
        } finally {
          cleanup()
        }
      },
    },
    {
      name: 'a pack waits for the service it uses, calls it through the provider’s module and open page, hears its events and sees its status',
      run: async (ctx) => {
        try {
          await pluginsWork(ctx)
        } finally {
          cleanup()
        }
      },
    },
    {
      name: 'a companion’s draft is tested in a throwaway sandbox and proposed with a card that opens the review',
      run: async (ctx) => {
        try {
          await builds(ctx)
        } finally {
          cleanup()
        }
      },
    },
  ],
  shots: [],
}
