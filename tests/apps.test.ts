/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({}) },
  BrowserWindow: Object.assign(vi.fn(), { getFocusedWindow: () => null, getAllWindows: () => [] }),
  dialog: {},
}))

import { ATELIER_APP_PARTITION_PREFIX, APP_CSP, APP_HTML_MAX, APP_VERSIONS_MAX, appIdOf, appVersionUrl, parseAppUrl, validateAppHtml } from '../src/shared/apps'
import { appRunUrl } from '../src/shared/url'
import type { AgentEvent } from '../src/shared/ipc'
import { buildBrief } from '../src/main/apps/brief'
import { appRequestAllowed, appResponseHeaders, serveApp } from '../src/main/apps/protocol'
import { createAppsService } from '../src/main/apps/service'
import { AppStore } from '../src/main/apps/store'
import { registerAppTools } from '../src/main/apps/tools'
import { clientTool, resetClientToolsForTests, type ClientToolContext, type ToolSetup } from '../src/main/agent/tools/registry'
import { bindWorkspace, trashAdapter } from '../src/main/workspace/adapters'

// Agent-built apps, their HTML rules, the
// atelier-app:// sandbox's responses and paths, versions, and build_app.

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const page = (body = '<p>Hi</p>'): string => `<!doctype html><html><head><style>p{color:red}</style></head><body>${body}<script>document.title='x'</script></body></html>`

describe('validateAppHtml', () => {
  it('accepts a self-contained page with inline code and data URLs', () => {
    expect(validateAppHtml(page('<img src="data:image/png;base64,AAAA" alt=""><a href="#top">Top</a>'))).toEqual({ ok: true })
    expect(validateAppHtml(page('<div style="background:url(data:image/svg+xml;utf8,x)"></div>'))).toEqual({ ok: true })
    expect(validateAppHtml(page('<svg><use href="#icon"/></svg>'))).toEqual({ ok: true })
  })

  it('refuses anything the app would fetch', () => {
    const bad = [
      '<script src="https://cdn.example/x.js"></script>',
      '<script type="module" src=x.js></script>',
      '<link rel="stylesheet" href="a.css">',
      '<iframe srcdoc="x"></iframe>',
      '<object data="x"></object>',
      '<embed src="x">',
      '<base href="https://example.com/">',
      '<meta http-equiv="refresh" content="0;url=https://example.com">',
      '<style>@import "x.css";</style>',
      '<div style="background:url(https://example.com/a.png)"></div>',
      '<img src="https://example.com/a.png">',
      '<img srcset="a.png 2x">',
      '<video poster="p.jpg"></video>',
      '<form action="https://example.com"></form>',
      '<svg><image href="https://example.com/a.png"/></svg>',
    ]
    for (const html of bad) expect(validateAppHtml(page(html)).ok, html).toBe(false)
  })

  it('refuses an empty page and one over 2 MB', () => {
    expect(validateAppHtml('  ')).toEqual({ ok: false, reason: 'The app is empty.' })
    expect(validateAppHtml('a'.repeat(APP_HTML_MAX + 1))).toMatchObject({ ok: false })
  })
})

describe('atelier-app addresses', () => {
  it('parses an app and a version, and nothing else', () => {
    expect(parseAppUrl(`atelier-app://${ID}/`)).toEqual({ appId: ID, versionId: null })
    expect(parseAppUrl(appVersionUrl(ID, 'v-1'))).toEqual({ appId: ID, versionId: 'v-1' })
    expect(appIdOf(appRunUrl(ID))).toBe(ID)
    for (const bad of [
      `atelier-app://${ID}/other.html`,
      `atelier-app://${ID}/../x`,
      `atelier-app://${ID}/%2e%2e/secret`,
      `atelier-app://${ID}/?version=../../etc`,
      `atelier-app://not-an-id/`,
      `atelier-app://user:pw@${ID}/`,
      `https://${ID}/`,
      'atelier-app://',
      'garbage',
    ])
      expect(parseAppUrl(bad), bad).toBeNull()
  })

  it('names each partition after its app', () => {
    expect(`${ATELIER_APP_PARTITION_PREFIX}${ID}`).toBe(`persist:atelier-app-${ID}`)
  })
})

describe('the sandbox responses', () => {
  let dir: string
  let store: AppStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-apps-'))
    store = new AppStore(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sends the strict CSP and no-network headers', () => {
    expect(APP_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    )
    const headers = appResponseHeaders()
    expect(headers['content-security-policy']).toBe(APP_CSP)
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['cache-control']).toBe('no-store')
  })

  it('serves only its own app, and 404s other apps and paths', async () => {
    const { app, versionId } = store.create({ name: 'Timer', description: 'A timer', owner: 'shared', createdBy: 'c1', html: page() })
    const ok = serveApp(store, app.id, appVersionUrl(app.id, versionId))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-security-policy')).toBe(APP_CSP)
    expect(await ok.text()).toContain('<p>Hi</p>')
    // Before the first save the draft runs.
    expect(serveApp(store, app.id, appRunUrl(app.id)).status).toBe(200)
    expect(serveApp(store, ID, appRunUrl(app.id)).status).toBe(404)
    expect(serveApp(store, app.id, `atelier-app://${app.id}/x.js`).status).toBe(404)
    expect(serveApp(store, app.id, appVersionUrl(app.id, 'missing')).status).toBe(404)
  })

  it('lets only its own address, data: and blob: load', () => {
    expect(appRequestAllowed(ID, appRunUrl(ID))).toBe(true)
    expect(appRequestAllowed(ID, 'data:image/png;base64,AA')).toBe(true)
    expect(appRequestAllowed(ID, 'https://example.com/')).toBe(false)
    expect(appRequestAllowed(ID, appRunUrl('1f8fad5b-d9cb-469f-a165-70867728950e'))).toBe(false)
  })
})

describe('versions', () => {
  let dir: string
  let store: AppStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-apps-'))
    store = new AppStore(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps drafts separate until saved, and restores an older version forward', () => {
    const { app, versionId: v1 } = store.create({ name: 'Notes', description: 'd', owner: 'shared', createdBy: 'c1', html: page('<p>one</p>') })
    expect(existsSync(join(dir, 'apps', app.id, 'versions', `${v1}.html`))).toBe(true)
    expect(store.get(app.id)).toMatchObject({ currentVersionId: null, draftVersionId: v1 })
    store.saveDraft(app.id, v1)
    const v2 = store.addDraft(app.id, page('<p>two</p>'))
    // The saved version keeps running while a draft waits.
    expect(store.html(app.id)).toContain('one')
    expect(store.html(app.id, v2)).toContain('two')
    store.saveDraft(app.id, v2)
    expect(store.html(app.id)).toContain('two')
    const restored = store.restoreVersion(app.id, v1)
    expect(store.html(app.id)).toContain('one')
    const versions = store.get(app.id).versions
    expect(versions.map((v) => v.label).sort()).toEqual(['restored', 'saved', 'saved'])
    expect(restored.currentVersionId).toBe(versions.find((v) => v.label === 'restored')?.id)
  })

  it('refuses invalid HTML and unknown versions', () => {
    const { app } = store.create({ name: 'A', description: '', owner: 'shared', createdBy: 'c1', html: page() })
    expect(() => store.addDraft(app.id, page('<script src="x.js"></script>'))).toThrow(/inline/)
    expect(() => store.saveDraft(app.id, 'nope')).toThrow(/no longer exists/)
    expect(() => store.html(app.id, '../../x')).toThrow()
    expect(() => store.get('../etc')).toThrow()
  })

  it(`keeps at most ${APP_VERSIONS_MAX} versions, never dropping the current one`, () => {
    const { app, versionId } = store.create({ name: 'A', description: '', owner: 'shared', createdBy: 'c1', html: page() })
    store.saveDraft(app.id, versionId)
    for (let i = 0; i < APP_VERSIONS_MAX + 3; i++) store.addDraft(app.id, page(`<p>${i}</p>`))
    const after = store.get(app.id)
    expect(after.versions).toHaveLength(APP_VERSIONS_MAX)
    expect(after.versions.some((v) => v.id === versionId)).toBe(true)
  })
})

describe('the apps service and build_app', () => {
  let dir: string
  let store: AppStore
  const opened: string[] = []
  const chats: Array<{ text: string; context: string }> = []
  const events: AgentEvent[] = []
  let service: ReturnType<typeof createAppsService>

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-apps-svc-'))
    store = new AppStore(dir)
    service = createAppsService({
      store,
      sandbox: { session: () => ({}) as never, preferencesFor: () => null, harden: () => undefined, isAppSession: () => false },
      broadcast: () => undefined,
      openTab: (url) => opened.push(url),
      startChat: (text, options) => {
        chats.push({ text, context: options.context })
        return 'chat-9'
      },
      activeCompanion: () => 'c1',
      savePath: (name) => join(dir, `${name}.html`),
    })
    // Recently Deleted, faked: snapshot then let the adapter restore.
    const trashed = new Map<string, { payload: unknown; files: string[] }>()
    bindWorkspace({
      snapshot: () => undefined,
      put: (kind, id) => {
        const snap = trashAdapter(kind)!.snapshot(id)
        const moved = (snap.files ?? []).map((f) => `${f}.trashed`)
        ;(snap.files ?? []).forEach((f, i) => renameSync(f, moved[i] as string))
        trashed.set(id, { payload: snap.payload, files: moved })
        return { id, kind, title: '', deletedAt: 0, expiresAt: 0, size: 0 } as never
      },
      projectPrompt: () => null,
      folderFor: () => null,
    })
    ;(globalThis as { __trashed?: typeof trashed }).__trashed = trashed
    resetClientToolsForTests()
    registerAppTools({ store, changed: service.changed })
  })
  afterAll(() => {
    bindWorkspace(null)
    resetClientToolsForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const ctx: ClientToolContext = {
    chatId: 'chat-1',
    companionId: 'c1',
    isPrivate: false,
    isRoutine: false,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    ask: async () => {
      throw new Error('build_app never asks')
    },
  }

  it('is offered only with the apps flag, outside private windows', () => {
    const tool = clientTool('build_app')!
    const setup = (flags: Record<string, string>, priv = false): ToolSetup => ({ private: priv, flags, workspace: { apps: true } } as unknown as ToolSetup)
    expect(tool.enabled(setup({ apps: 'on' }))).toBe(true)
    expect(tool.enabled(setup({ apps: 'on' }, true))).toBe(false)
  })

  it('stores a draft, emits app-built, and saves from the card', async () => {
    const result = await clientTool('build_app')!.run({ name: 'Dice', description: 'Rolls dice', html: page() }, ctx)
    expect(result.isError).toBeFalsy()
    const { appId, versionId } = JSON.parse(result.content) as { appId: string; versionId: string }
    expect(events.at(-1)).toMatchObject({ type: 'app-built', appId, versionId, name: 'Dice' })
    expect(service.get(appId)).toMatchObject({ draftVersionId: versionId, currentVersionId: null, createdBy: 'c1', owner: 'c1' })
    expect(service.saveDraft(appId, versionId).currentVersionId).toBe(versionId)
    // A second build with the appId adds a version.
    const again = await clientTool('build_app')!.run({ name: 'Dice 2', description: 'Rolls two', html: page('<p>2</p>'), appId }, ctx)
    expect(JSON.parse(again.content)).toMatchObject({ appId })
    expect(service.get(appId).versions).toHaveLength(2)
  })

  it('refuses invalid HTML with a reason the model can fix', async () => {
    const bad = await clientTool('build_app')!.run({ name: 'Bad', description: '', html: page('<link rel="stylesheet" href="x.css">') }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.content).toMatch(/<link>/)
    const unknown = await clientTool('build_app')!.run({ name: 'X', description: '', html: page(), appId: ID }, ctx)
    expect(unknown.isError).toBe(true)
  })

  it('opens in a tab, exports HTML, starts a build chat with the brief', async () => {
    const app = service.list()[0]!
    service.open(app.id)
    expect(opened.at(-1)).toBe(appRunUrl(app.id))
    const path = await service.exportHtml(app.id)
    expect(path && readFileSync(path, 'utf8')).toContain('<p>Hi</p>')
    expect(service.startBuild('  a habit tracker ')).toBe('chat-9')
    expect(chats.at(-1)?.text).toBe('Build me an app: a habit tracker')
    expect(chats.at(-1)?.context).toBe(buildBrief('a habit tracker').context)
    expect(buildBrief('x').context).toMatch(/no network/)
  })

  it('deletes to Recently Deleted and restores', () => {
    const app = service.list()[0]!
    service.remove(app.id)
    expect(store.has(app.id)).toBe(false)
    const trashed = (globalThis as { __trashed?: Map<string, { payload: unknown; files: string[] }> }).__trashed!.get(app.id)!
    expect(trashAdapter('app')!.restore(trashed.payload, trashed.files)).toBe(app.name)
    expect(store.has(app.id)).toBe(true)
  })
})
