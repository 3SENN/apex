/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Companions as builders (docs/packs.md › Companions as builders): the client
// tools a companion builds packs with, on both engines. They work on drafts
// in packs/dev/ only. test_pack runs a draft's tools in a throwaway, in-memory
// sandbox and loads its panels off-screen to catch errors; propose_pack puts
// a card in the chat. Nothing here installs, enables or grants anything: the
// person does that from the review, and pack code can't reach these tools.
import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, session as electronSession, type WebContents } from 'electron'
import { z } from 'zod'
import { KIT_MAJORS, PACK_ID_PATTERN, PACK_MANIFEST_FILE, describePackPermissions, packAppEntryPath, packToolName, packUrl, type PackApp, type PackManifest, type PackPermissionLine } from '@shared/packs'
import { isFlagOn } from '@shared/flags'
import { registerClientTool, type ClientTool, type ToolSetup } from '../agent/tools/registry'
import type { AppContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { validatePack, type PackFiles } from './manifest'
import { checkWorldFile } from './worlds'
import type { PacksRuntime } from './runtime'
import { BUILD_CONTEXT } from './service'
import { STARTERS, starterFiles } from './starters'
import type { PackStore } from './store'

export interface BuilderDeps {
  store: PackStore
  runtime: PacksRuntime
  app: AppContext
  companionName(id: string): string | null
  /** Whether an installed pack is yours (signed with your author key, or installed from a draft). */
  isOwn(id: string): boolean
}

const id = z.string().regex(PACK_ID_PATTERN)
/** The builder tools are on in Creator chats only (docs/apps.md › Creator mode); creator_mode turns a chat into one. */
const enabled = (setup: ToolSetup): boolean => !setup.private && !setup.routine && setup.creator === true && isFlagOn(setup.flags, 'pack-builder')
const json = (value: unknown): string => JSON.stringify(value, null, 2)
const lineText = (l: PackPermissionLine): string => `[${l.level}] ${mainT(l.key, l.vars)}`

const PANEL_SETTLE_MS = 1_500
const PAGE_LOAD_MS = 15_000

/** Loads each panel off-screen in the draft's test sandbox and reports what went wrong. */
async function checkPanels(runtime: PacksRuntime, packId: string, manifest: PackManifest): Promise<Array<{ panel: string; ok: boolean; errors: string[] }>> {
  const out: Array<{ panel: string; ok: boolean; errors: string[] }> = []
  for (const panel of manifest.contributes.panels ?? []) {
    const errors: string[] = []
    const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { ...runtime.sandbox.viewPreferences(packId, 'test'), offscreen: true } })
    runtime.sandbox.harden(win.webContents, packId)
    win.webContents.setAudioMuted(true)
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message.slice(0, 500))
    })
    try {
      await Promise.race([win.loadURL(packUrl(packId, panel.html)), new Promise((_, reject) => setTimeout(() => reject(new Error('did not load in time')), PAGE_LOAD_MS))])
      await new Promise((r) => setTimeout(r, PANEL_SETTLE_MS))
    } catch (err) {
      errors.push(`Load failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
    out.push({ panel: panel.id, ok: errors.length === 0, errors: errors.slice(0, 10) })
  }
  return out
}

type PlayStep = { wait: number } | { key: string; holdMs?: number } | { click: [number, number] } | { type: string } | { capture: string }

const PLAY_CAPTURES = 8
const PLAY_SETTLE_MS = 1_200

/** Electron's key codes for the names a companion writes. */
function keyCode(key: string): string {
  const named: Record<string, string> = { arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down', enter: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space', ' ': 'Space', tab: 'Tab', backspace: 'Backspace' }
  return named[key.toLowerCase()] ?? key
}

/** Where a world's still is drawn during a test: a page of the kit the draft never ships (its id can't be a pack's own). */
const STILL_APP = 'apex-world-still'
const STILL_ROOT = '__still'
const STILL_SIZE = { width: 960, height: 540 }
const STILL_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>drawing</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block;width:100vw;height:100vh}</style><script type="module" src="./main.js"></script></head><body><canvas></canvas></body></html>'

/** The still's script: the world as the editor frames it (its camera, else over the whole of it), drawn once. */
function stillScript(world: unknown): string {
  return `import * as THREE from 'three'
import { createWorldView } from 'apex-kit/world.js'
const doc = ${JSON.stringify(world)}
try {
  const canvas = document.querySelector('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(${STILL_SIZE.width}, ${STILL_SIZE.height}, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  const view = createWorldView(doc, { labels: true })
  scene.add(view.root, view.lights)
  scene.background = view.sky
  scene.fog = new THREE.Fog(view.sky, view.fog.near, view.fog.far)
  const [w, d] = doc.size
  const camera = new THREE.PerspectiveCamera(42, ${STILL_SIZE.width} / ${STILL_SIZE.height}, 0.1, 600)
  camera.position.set(...(doc.camera?.at ?? [w / 2, Math.max(w, d) * 0.8, d * 1.15]))
  camera.lookAt(...(doc.camera?.lookAt ?? [w / 2, 0, d / 2]))
  renderer.render(scene, camera)
  requestAnimationFrame(() => {
    renderer.render(scene, camera)
    document.title = 'ready'
  })
} catch (err) {
  document.title = 'failed: ' + (err && err.message ? err.message : String(err))
}
`
}

/**
 * Stills of a draft's worlds (docs/apps.md › Worlds), so the companion that
 * built one sees it: each drawn off-screen in the test sandbox from the
 * world's own camera, by a kit page added to the test run only.
 */
async function worldStills(runtime: PacksRuntime, packId: string, manifest: PackManifest, files: PackFiles): Promise<{ report: Array<{ world: string; ok: boolean; error?: string }>; images: Array<{ mediaType: 'image/jpeg'; data: string }> }> {
  const report: Array<{ world: string; ok: boolean; error?: string }> = []
  const images: Array<{ mediaType: 'image/jpeg'; data: string }> = []
  for (const path of (manifest.contributes.worlds ?? []).slice(0, 2)) {
    const data = files.get(path)
    const check = data ? checkWorldFile(data) : null
    if (!check?.ok) {
      report.push({ world: path, ok: false, error: 'The world file has problems; fix them first.' })
      continue
    }
    const still: PackApp = { id: STILL_APP, name: 'World still', root: STILL_ROOT, entry: 'index.html', build: 'kit', kit: KIT_MAJORS[KIT_MAJORS.length - 1], kind: 'tool' }
    const withStill = new Map(files)
    withStill.set(`${STILL_ROOT}/index.html`, Buffer.from(STILL_PAGE))
    withStill.set(`${STILL_ROOT}/main.js`, Buffer.from(stillScript(check.world)))
    runtime.setTestRun(packId, { ...manifest, contributes: { ...manifest.contributes, apps: [...(manifest.contributes.apps ?? []), still] } }, withStill)
    const win = new BrowserWindow({ show: false, ...STILL_SIZE, useContentSize: true, webPreferences: { ...runtime.sandbox.viewPreferences(packId, 'test'), offscreen: true } })
    runtime.sandbox.harden(win.webContents, packId)
    try {
      await Promise.race([win.loadURL(packUrl(packId, `${STILL_ROOT}/index.html`)), new Promise((_, reject) => setTimeout(() => reject(new Error('did not load in time')), PAGE_LOAD_MS))])
      let title = ''
      for (let waited = 0; waited < 10_000 && !win.isDestroyed(); waited += 100) {
        title = win.webContents.getTitle()
        if (title === 'ready' || title.startsWith('failed:')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      if (title !== 'ready') {
        report.push({ world: path, ok: false, error: title.startsWith('failed:') ? title.slice(8).trim() : 'The world did not draw in time.' })
        continue
      }
      const image = await win.webContents.capturePage()
      if (image.isEmpty()) report.push({ world: path, ok: false, error: 'The still came out empty.' })
      else {
        images.push({ mediaType: 'image/jpeg', data: image.toJPEG(78).toString('base64') })
        report.push({ world: path, ok: true })
      }
    } catch (err) {
      report.push({ world: path, ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (!win.isDestroyed()) win.destroy()
      runtime.setTestRun(packId, manifest, files)
    }
  }
  return { report, images }
}

/**
 * test_pack's playtest (docs/apps.md › Companions as builders): an app played
 * off-screen in the draft's test sandbox, with the frames a companion looks
 * at, its console errors, its frame times and what it reported with
 * apex.test.ready. The sandbox is the test one: nothing it stores is kept.
 */
async function playtest(runtime: PacksRuntime, packId: string, manifest: PackManifest, o: { app?: string; width?: number; height?: number; steps?: PlayStep[] }, signal: AbortSignal): Promise<{ report: Record<string, unknown> & { ok: boolean }; images: Array<{ mediaType: 'image/jpeg'; data: string }> }> {
  const app = (manifest.contributes.apps ?? []).find((a) => !o.app || a.id === o.app)
  if (!app) return { report: { ok: false, error: o.app ? `There is no app called ${o.app}.` : 'This draft has no app to play.' }, images: [] }
  const width = o.width ?? 1280
  const height = o.height ?? 720
  const errors: string[] = []
  const captures: Array<{ label: string; data: string }> = []
  const win = new BrowserWindow({ show: false, width, height, useContentSize: true, webPreferences: { ...runtime.sandbox.viewPreferences(packId, 'test'), offscreen: true } })
  runtime.sandbox.harden(win.webContents, packId)
  win.webContents.setAudioMuted(true)
  win.webContents.setFrameRate(60)
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && errors.length < 20) errors.push(event.message.slice(0, 500))
  })
  win.webContents.on('render-process-gone', () => errors.push('The app’s page crashed.'))
  const wc = win.webContents
  const capture = async (label: string): Promise<void> => {
    if (captures.length >= PLAY_CAPTURES || wc.isDestroyed()) return
    const image = await wc.capturePage()
    if (image.isEmpty()) return
    const small = image.getSize().width > 960 ? image.resize({ width: 960 }) : image
    captures.push({ label, data: small.toJPEG(78).toString('base64') })
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let loaded = true
  try {
    await Promise.race([win.loadURL(packUrl(packId, packAppEntryPath(app))), sleep(PAGE_LOAD_MS).then(() => Promise.reject(new Error('did not load in time')))])
    await sleep(PLAY_SETTLE_MS)
  } catch (err) {
    loaded = false
    errors.push(`Load failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const steps = o.steps ?? []
  const explicit = steps.some((s) => 'capture' in s)
  if (loaded) {
    if (!explicit) await capture('start')
    for (const s of steps) {
      if (signal.aborted || wc.isDestroyed()) break
      if ('wait' in s) await sleep(s.wait)
      else if ('capture' in s) await capture(s.capture)
      else if ('type' in s) await wc.insertText(s.type)
      else if ('key' in s) {
        const code = keyCode(s.key)
        wc.sendInputEvent({ type: 'keyDown', keyCode: code })
        if (code.length === 1) wc.sendInputEvent({ type: 'char', keyCode: code })
        await sleep(s.holdMs ?? 60)
        wc.sendInputEvent({ type: 'keyUp', keyCode: code })
      } else if ('click' in s) {
        const [x, y] = s.click
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        await sleep(50)
      }
    }
  }
  let frames: { average: number; p95: number; count: number } | null = null
  if (loaded && !wc.isDestroyed()) {
    // Frame times measured in the page: sixty frames, average and the slow end.
    frames = (await Promise.race([
      wc.executeJavaScript('new Promise((resolve) => { const t = []; let last = performance.now(); const tick = (now) => { t.push(now - last); last = now; if (t.length < 60) requestAnimationFrame(tick); else { const s = [...t].sort((a, b) => a - b); resolve({ average: Math.round((t.reduce((a, b) => a + b, 0) / t.length) * 10) / 10, p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10, count: t.length }) } }; requestAnimationFrame(tick) })'),
      sleep(4_000).then(() => null),
    ])) as typeof frames
    if (!explicit) await capture('end')
  }
  const state = runtime.testStates.get(wc.id) ?? null
  runtime.testStates.delete(wc.id)
  if (!win.isDestroyed()) win.destroy()
  const report = {
    ok: loaded && errors.length === 0,
    app: app.id,
    size: [width, height],
    errors,
    frames,
    state,
    captures: captures.map((c, i) => `image ${i + 1}: ${c.label}`),
    ...(state === null ? { hint: 'The app never called apex.test.ready(state); report its state there so the playtest can see what happened.' } : {}),
  }
  return { report, images: captures.map((c) => ({ mediaType: 'image/jpeg' as const, data: c.data })) }
}

/**
 * Opens a page for a test in a background tab of a normal window, in a fresh
 * in-memory partition with no cookies, sign-ins or permissions: a draft under
 * test never sees your signed-in pages, whatever address a companion picks.
 */
async function openTestPage(app: AppContext, url: string): Promise<{ contents: WebContents; close(): void } | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const front = app.windows.focused()
  const win = front && front.kind === 'normal' ? front : app.windows.all().find((w) => w.kind === 'normal')
  if (!win) return null
  const ses = electronSession.fromPartition(`apex-pack-testpage-${randomUUID()}`)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event, item) => {
    event.preventDefault()
    item.cancel()
  })
  const tab = win.tabs.create(url, { activate: false, sandbox: { session: ses } })
  const wc = tab.view.webContents
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PAGE_LOAD_MS)
    wc.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })
    wc.once('did-fail-load', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  return {
    contents: wc,
    close: () => {
      if (win.tabs.find(tab.id)) win.tabs.close(tab.id)
      void ses.clearStorageData().catch(() => undefined)
    },
  }
}

export function registerPackBuilderTools(deps: BuilderDeps): void {
  const { store, runtime } = deps

  const create = z.object({ id, name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(500), starter: z.enum(STARTERS).optional() }).strict()
  registerClientTool({
    name: 'create_pack',
    group: 'packs',
    description:
      `Starts a draft ${BRAND_NAME} pack (skills, routine templates, site tweaks, themes, companions, connectors, sandboxed panels, commands, page menu items and agent tools in plain JavaScript) in a folder you then fill with write_pack_file. Its result explains the format and the window.apex API. To change an installed pack, use its id: the draft starts from its files and replaces it when the person installs it. A pack's skills go to every companion; to give yourself a skill of your own, use draft_skill instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The pack id: 2 to 32 lowercase letters, digits and dashes.' },
        name: { type: 'string', description: 'A short name, up to 80 characters.' },
        description: { type: 'string', description: 'One or two sentences on what it does.' },
        starter: { type: 'string', enum: [...STARTERS], description: `Start an app from a working example on the ${BRAND_NAME} kit: game-3d (three.js with the person’s companion), game-2d (canvas), tool (apex.ai.stream), story (apex.ai.session with a tool, and the companion’s lines), phone-controller (apex.server on the Wi-Fi: phones scan a QR code and send motion and buttons over a socket) or sorter (apex.ai.decide: typed quick decisions with probabilities, acting only when sure).` },
      },
      required: ['id', 'name', 'description'],
      additionalProperties: false,
    },
    parse: create,
    enabled,
    async run(args, ctx) {
      const installed = store.get(args.id)
      if (installed?.firstParty) return { content: `That id belongs to a pack that comes with ${BRAND_NAME}. Pick another id.`, isError: true }
      store.noteDraftChat(args.id, ctx.chatId)
      if (store.hasDraft(args.id)) return { content: `A draft called ${args.id} already exists: keep working on it with write_pack_file, or pick another id.`, isError: true }
      // Someone else's pack can't be replaced by a draft of yours (it would be signed by another author): it becomes a remix.
      if (installed && !deps.isOwn(args.id)) {
        return { content: `${args.id} is someone else's pack. A draft of yours can't replace it; call create_pack again with a new id such as "${args.id.slice(0, 25)}-remix", then copy what you need with read_pack_file.`, isError: true }
      }
      if (installed) {
        // Start from the installed pack's files, one version up.
        const files = new Map(store.allFiles(args.id))
        const next = { ...installed.manifest, version: installed.manifest.version.replace(/(\d+)$/, (n) => String(Number(n) + 1)) }
        files.set(PACK_MANIFEST_FILE, Buffer.from(`${JSON.stringify(next, null, 2)}\n`))
        store.writeDraft(args.id, files)
        return { content: json({ ok: true, id: args.id, startedFrom: `the installed ${installed.manifest.version}`, files: [...files.keys()], guide: BUILD_CONTEXT }) }
      }
      if (args.starter) {
        const files = starterFiles(args.starter, { id: args.id, name: args.name, description: args.description, ...(deps.companionName(ctx.companionId) ? { builtBy: deps.companionName(ctx.companionId) as string } : {}) })
        store.writeDraft(args.id, files)
        return {
          content: json({
            ok: true,
            id: args.id,
            starter: args.starter,
            files: [...files.keys()],
            guide: BUILD_CONTEXT,
            next: 'Read app/main.js, change it into what the person asked for, then test_pack with a playtest and look at the frames before you propose it.',
          }),
        }
      }
      store.createDraft({ id: args.id, name: args.name, description: args.description, builtBy: deps.companionName(ctx.companionId) ?? undefined })
      return { content: json({ ok: true, id: args.id, files: [PACK_MANIFEST_FILE], guide: BUILD_CONTEXT, next: 'Write the manifest and files with write_pack_file, then test_pack.' }) }
    },
  } satisfies ClientTool<z.infer<typeof create>>)

  const write = z.object({ id, path: z.string().min(1).max(300), content: z.string().max(2 * 1024 * 1024) }).strict()
  registerClientTool({
    name: 'write_pack_file',
    group: 'packs',
    description: 'Writes one file in a draft pack (creating folders as needed), replacing it if it exists. Paths are relative and use letters, digits, dot, dash and underscore, such as "tools/read-price.js" or "apex-pack.json". Drafts only; an installed pack never changes.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, path: { type: 'string' }, content: { type: 'string', description: 'The whole file.' } },
      required: ['id', 'path', 'content'],
      additionalProperties: false,
    },
    parse: write,
    enabled,
    async run(args) {
      store.writeDraftFile(args.id, args.path, args.content)
      return { content: json({ ok: true, path: args.path, bytes: Buffer.byteLength(args.content) }) }
    },
  } satisfies ClientTool<z.infer<typeof write>>)

  const read = z.object({ id, path: z.string().max(300) }).strict()
  registerClientTool({
    name: 'read_pack_file',
    group: 'packs',
    description: 'Reads one file of a draft, or of an installed pack when there is no draft with that id (the example pack included). An empty path lists the files.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' } }, required: ['id', 'path'], additionalProperties: false },
    parse: read,
    enabled,
    async run(args) {
      const files = store.hasDraft(args.id) ? store.draft(args.id).files : (store.get(args.id)?.files ?? null)
      if (!files) return { content: `There is no draft or installed pack called ${args.id}.`, isError: true }
      if (!args.path || args.path === '.') return { content: json({ id: args.id, from: store.hasDraft(args.id) ? 'draft' : 'installed', files: [...files].map(([p, d]) => ({ path: p, bytes: d.length })) }) }
      const data = files.get(args.path)
      if (!data) return { content: `${args.path} is not in ${args.id}.`, isError: true }
      return { content: data.toString('utf8') }
    },
  } satisfies ClientTool<z.infer<typeof read>>)

  const step = z.union([
    z.object({ wait: z.number().int().min(0).max(10_000) }).strict(),
    z.object({ key: z.string().min(1).max(20), holdMs: z.number().int().min(0).max(5_000).optional() }).strict(),
    z.object({ click: z.tuple([z.number().min(0).max(4000), z.number().min(0).max(4000)]) }).strict(),
    z.object({ type: z.string().max(500) }).strict(),
    z.object({ capture: z.string().max(60) }).strict(),
  ])
  const test = z
    .object({
      id,
      tests: z.array(z.object({ tool: z.string().min(1).max(24), input: z.record(z.string(), z.unknown()).default({}), url: z.string().max(4096).optional() }).strict()).max(10).optional(),
      playtest: z
        .object({
          app: z.string().max(32).optional(),
          width: z.number().int().min(320).max(1920).optional(),
          height: z.number().int().min(240).max(1200).optional(),
          steps: z.array(step).max(40).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
  registerClientTool({
    name: 'test_pack',
    group: 'packs',
    description:
      'Checks a draft pack: validates the manifest and files (every problem is listed with where it is), shows the permission lines the person will see, loads each panel off-screen to catch errors, and runs the tool calls you give in a throwaway sandbox (nothing it stores is kept; notifications and new tabs are skipped). Give url to run a tool against that page, opened in a background tab. Returns the results and the draft\'s recent log.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        tests: {
          type: 'array',
          items: {
            type: 'object',
            properties: { tool: { type: 'string', description: 'The tool name as in the manifest.' }, input: { type: 'object' }, url: { type: 'string', description: 'A page to run it on.' } },
            required: ['tool'],
            additionalProperties: false,
          },
        },
        playtest: {
          type: 'object',
          description:
            'Plays an app off-screen in the test sandbox and shows you frames: steps run in order. { wait: ms }, { key: "ArrowRight", holdMs }, { click: [x, y] }, { type: "text" }, { capture: "label" } (at most 8 captures; one is taken at the start and the end without any). Returns console errors, frame times, the states the app reported with apex.test.ready, and the frames as images.',
          properties: {
            app: { type: 'string', description: 'The app id (default: the first app).' },
            width: { type: 'number' },
            height: { type: 'number' },
            steps: { type: 'array', items: { type: 'object' } },
          },
          additionalProperties: false,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    parse: test,
    enabled,
    async run(args, ctx) {
      if (!store.hasDraft(args.id)) return { content: `There is no draft called ${args.id}. Call create_pack first.`, isError: true }
      const draft = store.draft(args.id)
      const check = draft.files ? validatePack(draft.files) : null
      if (!draft.files || !check || !check.ok) return { content: json({ ok: false, problems: check && !check.ok ? check.problems : draft.problems }), isError: true }
      const manifest = check.pack.manifest
      runtime.setTestRun(args.id, manifest, draft.files)
      const startedAt = Date.now()
      try {
        const panels = await checkPanels(runtime, args.id, manifest)
        const play = args.playtest ? await playtest(runtime, args.id, manifest, args.playtest, ctx.signal) : null
        const worlds = (manifest.contributes.worlds?.length ?? 0) > 0 ? await worldStills(runtime, args.id, manifest, draft.files) : null
        const results: unknown[] = []
        for (const t of args.tests ?? []) {
          ctx.signal.throwIfAborted()
          const page = t.url ? await openTestPage(deps.app, t.url) : null
          if (t.url && !page) {
            results.push({ tool: t.tool, ok: false, error: 'A test page must be an http or https address, and a normal window must be open.' })
            continue
          }
          try {
            const outcome = await runtime.callTool(args.id, 'test', t.tool, t.input, { chatId: ctx.chatId, companionId: ctx.companionId, target: page?.contents ?? null, signal: ctx.signal })
            const value = outcome.ok ? (typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value)) : null
            results.push(outcome.ok ? { tool: t.tool, ok: true, result: value && value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value } : { tool: t.tool, ok: false, error: outcome.error })
          } finally {
            page?.close()
          }
        }
        const log = store
          .logLines(args.id)
          .filter((l) => l.at >= startedAt)
          .slice(-30)
          .map((l) => `${l.level} ${l.source}: ${l.message}`)
        const ok = panels.every((p) => p.ok) && results.every((r) => (r as { ok: boolean }).ok) && (!play || play.report.ok)
        return {
          content: json({
            ok,
            problems: [],
            permissions: describePackPermissions(manifest).map(lineText),
            tools: (manifest.contributes.tools ?? []).map((tool) => ({ name: tool.name, agentName: packToolName(args.id, tool.name) })),
            panels,
            results,
            ...(play ? { playtest: play.report } : {}),
            ...(worlds ? { worlds: worlds.report } : {}),
            log,
            next: ok ? (play || worlds?.images.length ? 'Look at the images: if it looks (and plays) the way the person asked, call propose_pack.' : 'If it does what the person asked, call propose_pack.') : 'Fix what failed, then run test_pack again.',
          }),
          ...((play?.images.length ?? 0) + (worlds?.images.length ?? 0) > 0 ? { images: [...(play?.images ?? []), ...(worlds?.images ?? [])] } : {}),
        }
      } finally {
        runtime.endTestRun(args.id)
      }
    },
  } satisfies ClientTool<z.infer<typeof test>>)

  const propose = z.object({ id, note: z.string().trim().max(1_000).default('') }).strict()
  registerClientTool({
    name: 'propose_pack',
    group: 'packs',
    description: 'Puts a card in the chat for the person to review a draft pack (its permissions in plain words, its code) and install it. Run test_pack first: a draft with problems can\'t be proposed. You can\'t install it yourself.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: 'One or two sentences for the person.' } }, required: ['id'], additionalProperties: false },
    parse: propose,
    enabled,
    async run(args, ctx) {
      if (!store.hasDraft(args.id)) return { content: `There is no draft called ${args.id}.`, isError: true }
      const draft = store.draft(args.id)
      if (!draft.manifest || draft.problems.length > 0) return { content: json({ ok: false, problems: draft.problems }), isError: true }
      const m = draft.manifest
      ctx.emit({ type: 'pack-proposed', id: randomUUID(), packId: m.id, name: m.name, version: m.version, note: args.note, permissions: describePackPermissions(m) })
      return { content: json({ ok: true, note: 'The card is in the chat. The person reviews and installs it there; you can keep changing the draft until then.' }) }
    },
  } satisfies ClientTool<z.infer<typeof propose>>)

  const list = z.object({}).strict()
  registerClientTool({
    name: 'list_packs',
    group: 'packs',
    description: 'Lists the installed packs (on or off, with their tools as you see them and any problems) and the drafts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    parse: list,
    enabled,
    async run() {
      return {
        content: json({
          installed: store.all().map((p) => ({
            id: p.manifest.id,
            name: p.manifest.name,
            version: p.manifest.version,
            on: p.entry.enabled,
            comesWithApex: p.firstParty,
            tools: (p.manifest.contributes.tools ?? []).map((t) => packToolName(p.manifest.id, t.name)),
            problems: [...p.problems, ...runtime.problems(p.manifest.id)],
          })),
          drafts: store.drafts().map((d) => ({ id: d.id, name: d.manifest?.name ?? d.id, version: d.manifest?.version ?? null, problems: d.problems.length })),
        }),
      }
    },
  } satisfies ClientTool<z.infer<typeof list>>)
}
