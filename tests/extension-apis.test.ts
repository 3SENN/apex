/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Session, WebContents } from 'electron'
import { afterAll, describe, expect, it } from 'vitest'
import { EXT_LISTEN_EVENTS, EXT_SHIM_OPS } from '@shared/extensionShim'
import { classifyCompat } from '../src/main/extensions/compat'
import { afterClick, clickData, createItem, removeItem, targetContexts, updateItem, visibleTree, menuTitle, type MenuTarget } from '../src/main/extensions/contextMenus'
import { addRules, removeRules, rulesShowAction, urlFilterMatches } from '../src/main/extensions/declarativeContent'
import { ExtensionsHost, matchPattern, type HostWindow, type ShimCaller } from '../src/main/extensions/host'
import { readManifest } from '../src/main/extensions/manifest'
import { settingDetails, winningHold } from '../src/main/extensions/privacySettings'
import { runShimOp } from '../src/main/extensions/shim'
import { allFrames, findFrame, frameIdOf, inPageKind, parentFrameIdOf, watchNavigation, type NavContents, type NavFrame } from '../src/main/extensions/webNavigation'
import { fakeAdapter } from './fixtures/extensions/fakeAdapter'

// the APIs a password manager such as Apple's iCloud Passwords needs
// beyond Electron's own: chrome.privacy (password saving held by the
// extension; address and card autofill not controllable), webNavigation
// (Chromium's frame ids, events), windows events, declarativeContent and
// contextMenus. Everything runs against fakes; nothing touches Electron.

const PM = join(__dirname, 'fixtures/extensions/password-manager')
const NOTES = join(__dirname, 'fixtures/extensions/mv3-basic')
const dir = mkdtempSync(join(tmpdir(), 'atelier-ext-apis-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Sent = { id: string; args: unknown[] }

async function setup(opts: { contents?: Map<number, WebContents>; session?: Session } = {}) {
  const atelier = { passwordSaving: true, addresses: true, cards: true }
  const sent: Sent[] = []
  let report: ((e: { versionId: number; runningStatus: string }) => void) | null = null
  const scopes = new Map<number, string>()
  const session =
    opts.session ??
    ({
      serviceWorkers: {
        on: (_n: string, fn: typeof report) => void (report = fn),
        getWorkerFromVersionID: (v: number) => {
          const scope = scopes.get(v)
          if (!scope) return undefined
          const id = scope.slice('chrome-extension://'.length, -1)
          return { scope, isDestroyed: () => false, send: (_ch: string, ...args: unknown[]) => void sent.push({ id, args }) }
        },
      },
      clearStorageData: async () => {},
    } as unknown as Session)
  const win = { id: 1, profileId: 'default', focused: true, window: { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) }, tabs: () => [] } as unknown as HostWindow
  const host = new ExtensionsHost({
    adapter: fakeAdapter(),
    preloads: null,
    extensionsDir: (p) => join(dir, `${p}-${Math.random().toString(36).slice(2)}`, 'Extensions'),
    nativeHostDirs: [],
    windows: () => [win],
    openTab: () => null,
    changed: () => {},
    askInstall: async () => false,
    askNative: async () => 'deny',
    toast: () => {},
    registerShortcut: () => ({ ok: true, dispose: () => {} }),
    clashesWith: () => null,
    chromeVersion: '156.0.0.0',
    contents: (id) => opts.contents?.get(id) ?? null,
    browserSetting: (_p, key) => (key === 'services.passwordSavingEnabled' ? atelier.passwordSaving : key === 'services.autofillAddressEnabled' ? atelier.addresses : atelier.cards),
  })
  host.attach(session, 'default')
  const pm = await host.loadUnpacked('default', PM)
  const notes = await host.loadUnpacked('default', NOTES)
  ;[pm, notes].forEach((id, i) => {
    scopes.set(i + 1, `chrome-extension://${id}/`)
    report?.({ versionId: i + 1, runningStatus: 'running' })
  })
  const worker = (extensionId: string): ShimCaller => ({ extensionId, send: () => {}, webContents: null, keepAlive: () => () => {} })
  const op = (extensionId: string, name: string, payload: unknown): Promise<unknown> => runShimOp(host, 'default', worker(extensionId), name, payload)
  return { host, pm, notes, sent, worker, op, atelier, session, events: (id: string) => sent.filter((s) => s.id === id).map((s) => s.args) }
}

describe('a password manager’s manifest', () => {
  it('runs in Atelier: privacy, declarativeContent, webNavigation, contextMenus and native messaging are all there', () => {
    expect(classifyCompat(readManifest(PM)!)).toEqual({ supported: true, reason: null, missing: [] })
    for (const op of ['privacy.get', 'privacy.set', 'privacy.clear', 'webNavigation.getFrame', 'webNavigation.getAllFrames', 'declarativeContent.addRules', 'contextMenus.create']) expect(EXT_SHIM_OPS).toContain(op)
    for (const e of ['webNavigation.onBeforeNavigate', 'webNavigation.onCompleted', 'windows.onFocusChanged', 'privacy.onChange', 'contextMenus.onClicked']) expect(EXT_LISTEN_EVENTS).toContain(e)
  })
})

describe('chrome.privacy', () => {
  it('lets the extension hold password saving, and reports address and card autofill as not controllable', async () => {
    const s = await setup()
    expect(await s.op(s.pm, 'privacy.get', { key: 'services.passwordSavingEnabled', details: {} })).toEqual({ value: true, levelOfControl: 'controllable_by_this_extension' })
    expect(await s.op(s.pm, 'privacy.get', { key: 'services.autofillCreditCardEnabled', details: {} })).toEqual({ value: true, levelOfControl: 'not_controllable' })
    expect(await s.op(s.pm, 'privacy.get', { key: 'services.autofillAddressEnabled', details: {} })).toEqual({ value: true, levelOfControl: 'not_controllable' })
    await expect(s.op(s.pm, 'privacy.set', { key: 'services.autofillAddressEnabled', details: { value: false } })).rejects.toThrow(/cannot control/)

    expect(s.host.passwordSavingHeldOff('default')).toBeNull()
    await s.op(s.pm, 'privacy.set', { key: 'services.passwordSavingEnabled', details: { value: false } })
    expect(await s.op(s.pm, 'privacy.get', { key: 'services.passwordSavingEnabled', details: {} })).toEqual({ value: false, levelOfControl: 'controlled_by_this_extension' })
    expect(s.host.passwordSavingHeldOff('default')).toEqual({ extensionId: s.pm, name: 'Fixture Password Manager' })

    // Turned off, its hold stops applying; back on, it applies again (Chrome keeps the value).
    await s.host.setEnabled('default', s.pm, false)
    expect(s.host.passwordSavingHeldOff('default')).toBeNull()
    await s.host.setEnabled('default', s.pm, true)
    expect(s.host.passwordSavingHeldOff('default')?.extensionId).toBe(s.pm)

    await s.op(s.pm, 'privacy.clear', { key: 'services.passwordSavingEnabled', details: {} })
    expect(s.host.passwordSavingHeldOff('default')).toBeNull()
    s.host.dispose()
  })

  it('refuses incognito scopes, a non-boolean value and an extension without the permission', async () => {
    const s = await setup()
    await expect(s.op(s.pm, 'privacy.set', { key: 'services.passwordSavingEnabled', details: { value: false, scope: 'incognito_persistent' } })).rejects.toThrow(/regular scope/)
    await expect(s.op(s.pm, 'privacy.set', { key: 'services.passwordSavingEnabled', details: { value: 'off' } })).rejects.toThrow(/boolean/)
    await expect(s.op(s.notes, 'privacy.get', { key: 'services.passwordSavingEnabled', details: {} })).rejects.toThrow(/"privacy" permission/)
    s.host.dispose()
  })

  it('tells listening extensions when a setting changes', async () => {
    const s = await setup()
    s.host.listenTabs('default', s.worker(s.pm), 'privacy.onChange')
    await s.op(s.pm, 'privacy.set', { key: 'services.passwordSavingEnabled', details: { value: false } })
    expect(s.events(s.pm).at(-1)).toEqual(['privacy.onChange', 'services.passwordSavingEnabled', { value: false, levelOfControl: 'controlled_by_this_extension' }])
    s.host.dispose()
  })

  it('follows Chrome’s precedence: the most recently installed holder wins', () => {
    const holds = [
      { extensionId: 'a'.repeat(32), installedAt: 1, value: false },
      { extensionId: 'b'.repeat(32), installedAt: 2, value: true },
    ]
    expect(winningHold(holds)?.extensionId).toBe('b'.repeat(32))
    expect(settingDetails('services.passwordSavingEnabled', true, holds, { id: 'a'.repeat(32), installedAt: 1 })).toEqual({ value: true, levelOfControl: 'controlled_by_other_extensions' })
    expect(settingDetails('services.passwordSavingEnabled', true, holds, { id: 'c'.repeat(32), installedAt: 3 })).toEqual({ value: true, levelOfControl: 'controllable_by_this_extension' })
  })
})

// ── webNavigation ──

function frame(id: number, url: string, parent: NavFrame | null, pid = 4, rid = id): NavFrame {
  const f: NavFrame = { frameTreeNodeId: id, processId: pid, routingId: rid, url, parent, framesInSubtree: [] }
  return f
}

function fakeTab(id: number, session: Session): { wc: NavContents & EventEmitter; main: NavFrame; login: NavFrame } {
  const main = frame(1, 'https://shop.example/checkout', null)
  const login = frame(7, 'https://id.example/login', main, 5, 9)
  main.framesInSubtree = [main, login]
  const wc = Object.assign(new EventEmitter(), { id, mainFrame: main, session, isDestroyed: () => false })
  return { wc: wc as unknown as NavContents & EventEmitter, main, login }
}

describe('chrome.webNavigation', () => {
  it('uses Chromium’s extension frame ids: 0 for the main frame, the frame-tree node id for others', () => {
    const session = {} as Session
    const { wc, main, login } = fakeTab(3, session)
    expect(frameIdOf(main)).toBe(0)
    expect(frameIdOf(login)).toBe(7)
    expect(parentFrameIdOf(main)).toBe(-1)
    expect(parentFrameIdOf(login)).toBe(0)
    expect(allFrames(wc)).toEqual([
      { frameId: 0, parentFrameId: -1, processId: 4, url: 'https://shop.example/checkout', errorOccurred: false, frameType: 'outermost_frame', documentLifecycle: 'active' },
      { frameId: 7, parentFrameId: 0, processId: 5, url: 'https://id.example/login', errorOccurred: false, frameType: 'sub_frame', documentLifecycle: 'active' },
    ])
    expect(findFrame(wc, 7)).toBe(login)
    expect(findFrame(wc, 1)).toBeNull()
  })

  it('answers getFrame and getAllFrames for the profile’s own tabs only', async () => {
    const session = {
      serviceWorkers: { on: () => {} },
      clearStorageData: async () => {},
    } as unknown as Session
    const mine = fakeTab(3, session)
    const other = fakeTab(4, {} as Session)
    const s = await setup({ contents: new Map([[3, mine.wc as unknown as WebContents], [4, other.wc as unknown as WebContents]]), session })
    expect(await s.op(s.pm, 'webNavigation.getAllFrames', { tabId: 3 })).toHaveLength(2)
    expect(await s.op(s.pm, 'webNavigation.getFrame', { tabId: 3, frameId: 7 })).toMatchObject({ url: 'https://id.example/login', parentFrameId: 0, errorOccurred: false })
    expect(await s.op(s.pm, 'webNavigation.getFrame', { tabId: 3, frameId: 99 })).toBeNull()
    expect(await s.op(s.pm, 'webNavigation.getAllFrames', { tabId: 4 })).toBeNull()
    await expect(s.op(s.notes, 'webNavigation.getAllFrames', { tabId: 3 })).rejects.toThrow(/"webNavigation" permission/)
    s.host.dispose()
  })

  it('turns frame events into onBeforeNavigate, onCommitted, onDOMContentLoaded, onCompleted and in-page updates', () => {
    const { wc, main, login } = fakeTab(3, {} as Session)
    const got: Array<[string, Record<string, unknown>]> = []
    const byIds = (pid: number, rid: number): NavFrame | null => (pid === 5 && rid === 9 ? login : pid === 4 && rid === 1 ? main : null)
    const unwatch = watchNavigation(wc, (e, d) => void got.push([e, d]), byIds, () => 1000)
    wc.emit('did-start-navigation', { url: 'https://id.example/login', isSameDocument: false, frame: login })
    wc.emit('did-frame-navigate', {}, 'https://id.example/login', 200, 'OK', false, 5, 9)
    wc.emit('did-frame-finish-load', {}, false, 5, 9)
    wc.emit('dom-ready')
    wc.emit('did-frame-finish-load', {}, true, 4, 1)
    wc.emit('did-navigate-in-page', {}, 'https://id.example/login#step2', false, 5, 9)
    wc.emit('did-navigate-in-page', {}, 'https://id.example/password', false, 5, 9)
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://id.example/x', false, 5, 9)
    expect(got.map(([e]) => e)).toEqual([
      'webNavigation.onBeforeNavigate',
      'webNavigation.onCommitted',
      'webNavigation.onDOMContentLoaded',
      'webNavigation.onCompleted',
      'webNavigation.onDOMContentLoaded',
      'webNavigation.onCompleted',
      'webNavigation.onReferenceFragmentUpdated',
      'webNavigation.onHistoryStateUpdated',
      'webNavigation.onErrorOccurred',
    ])
    expect(got[0]?.[1]).toMatchObject({ tabId: 3, frameId: 7, parentFrameId: 0, processId: -1, url: 'https://id.example/login', timeStamp: 1000 })
    expect(got[1]?.[1]).toMatchObject({ frameId: 7, transitionType: 'auto_subframe' })
    expect(got[5]?.[1]).toMatchObject({ frameId: 0 })
    expect(got[8]?.[1]).toMatchObject({ error: 'net::ERR_NAME_NOT_RESOLVED' })
    unwatch()
    expect(wc.listenerCount('did-frame-navigate')).toBe(0)
    expect(inPageKind(null, 'https://a.test/#x')).toBe('history')
  })

  it('sends webNavigation events only to extensions with the permission that listen', async () => {
    const session = { serviceWorkers: { on: () => {} }, clearStorageData: async () => {} } as unknown as Session
    const tab = fakeTab(3, session)
    const s = await setup({ contents: new Map([[3, tab.wc as unknown as WebContents]]), session })
    const pages: Array<{ id: string; args: unknown[] }> = []
    const page = (extensionId: string): ShimCaller => ({ extensionId, send: (...args) => void pages.push({ id: extensionId, args }), webContents: { isDestroyed: () => false, once: () => {} } as unknown as WebContents, keepAlive: () => () => {} })
    const pmPage = page(s.pm)
    const notesPage = { ...page(s.notes), webContents: { isDestroyed: () => false, once: () => {} } as unknown as WebContents }
    s.host.listenTabs('default', pmPage, 'webNavigation.onCompleted')
    s.host.listenTabs('default', notesPage, 'webNavigation.onCompleted')
    s.host.watchContents('default', tab.wc as unknown as WebContents)
    tab.wc.emit('did-frame-finish-load', {}, true, 4, 1)
    expect(pages.map((p) => [p.id, p.args[0]])).toEqual([[s.pm, 'webNavigation.onCompleted']])
    s.host.tabReplaced('default', 3, 8)
    s.host.dispose()
  })
})

describe('chrome.windows events', () => {
  it('sends focus changes (and WINDOW_ID_NONE) to listening contexts', async () => {
    const s = await setup()
    const got: unknown[][] = []
    const page: ShimCaller = { extensionId: s.pm, send: (...a) => void got.push(a), webContents: { isDestroyed: () => false, once: () => {} } as unknown as WebContents, keepAlive: () => () => {} }
    s.host.listenTabs('default', page, 'windows.onFocusChanged')
    s.host.windowEvent('default', 'windows.onFocusChanged', 1)
    s.host.windowEvent('default', 'windows.onFocusChanged', -1)
    s.host.windowEvent('default', 'windows.onCreated', 1)
    expect(got).toEqual([
      ['windows.onFocusChanged', 1],
      ['windows.onFocusChanged', -1],
    ])
    s.host.dispose()
  })
})

describe('chrome.declarativeContent', () => {
  const show = { instanceType: 'declarativeContent.ShowAction' }
  const httpOnly = { instanceType: 'declarativeContent.PageStateMatcher', pageUrl: { schemes: ['https', 'http'] } }

  it('keeps rules with generated ids and refuses duplicates, as Chrome does', () => {
    const one = addRules([], [{ conditions: [httpOnly], actions: [show] }])
    expect(one[0]?.id).toBe('_0_')
    expect(() => addRules(one, [{ id: '_0_', conditions: [httpOnly], actions: [show] }])).toThrow(/Duplicate rule ID/)
    expect(() => addRules([], [{ conditions: [], actions: [show] }])).toThrow(/condition/)
    expect(removeRules(one)).toEqual([])
  })

  it('matches page URLs with Chrome’s UrlFilter and never claims a css condition', () => {
    expect(urlFilterMatches({ hostSuffix: 'example.com', schemes: ['https'] }, 'https://login.example.com/a')).toBe(true)
    expect(urlFilterMatches({ hostContains: '.login' }, 'https://login.example.com/')).toBe(true)
    expect(urlFilterMatches({ pathPrefix: '/account', ports: [443, [8000, 8100]] }, 'https://x.test:8080/account/1')).toBe(true)
    expect(urlFilterMatches({ urlMatches: '^https://[a-z]+\\.test/' }, 'http://a.test/')).toBe(false)
    const rules = addRules([], [{ conditions: [httpOnly], actions: [show] }])
    expect(rulesShowAction(rules, 'https://site.test/')).toBe(true)
    expect(rulesShowAction(rules, 'file:///tmp/x.html')).toBe(false)
    const css = addRules([], [{ conditions: [{ instanceType: 'declarativeContent.PageStateMatcher', css: ['input[type=password]'] }], actions: [show] }])
    expect(rulesShowAction(css, 'https://site.test/')).toBe(false)
  })

  it('stores rules per extension through the shim, and they turn a disabled action on where they match', async () => {
    const s = await setup()
    const added = (await s.op(s.pm, 'declarativeContent.addRules', { rules: [{ conditions: [httpOnly], actions: [{ instanceType: 'declarativeContent.ShowPageAction' }] }] })) as Array<{ id: string }>
    expect(added.map((r) => r.id)).toEqual(['_0_'])
    expect(await s.op(s.pm, 'declarativeContent.getRules', {})).toHaveLength(1)
    await s.op(s.pm, 'declarativeContent.removeRules', { ids: ['_0_'] })
    expect(await s.op(s.pm, 'declarativeContent.getRules', {})).toEqual([])
    await expect(s.op(s.notes, 'declarativeContent.getRules', {})).rejects.toThrow(/"declarativeContent" permission/)
    s.host.dispose()
  })
})

describe('chrome.contextMenus', () => {
  const target = (over: Partial<MenuTarget> = {}): MenuTarget => ({ pageUrl: 'https://site.test/', frameUrl: null, frameId: 0, linkUrl: null, srcUrl: null, mediaType: null, selectionText: '', editable: false, ...over })

  it('creates, updates and removes items with Chrome’s checks', () => {
    let items = createItem([], { id: 'totp', title: 'Set up verification code', contexts: ['all'] })
    expect(() => createItem(items, { id: 'totp', title: 'Again' })).toThrow(/duplicate id totp/)
    expect(() => createItem(items, { id: 'x', title: 'Orphan', parentId: 'nope' })).toThrow(/Cannot find menu item/)
    expect(() => createItem(items, { title: 'No id' })).toThrow(/must pass an id/)
    items = createItem(items, { id: 'child', title: 'Child', parentId: 'totp' })
    items = updateItem(items, 'totp', { title: 'Verify %s' })
    expect(items[0]?.title).toBe('Verify %s')
    expect(() => updateItem(items, 'totp', { parentId: 'child' })).toThrow(/Cannot find/)
    expect(removeItem(items, 'totp')).toEqual([])
  })

  it('shows the items whose contexts and URL patterns fit the click, with %s filled in', () => {
    let items = createItem([], { id: 'all', title: 'Everywhere', contexts: ['all'] })
    items = createItem(items, { id: 'sel', title: 'Look up “%s”', contexts: ['selection'] })
    items = createItem(items, { id: 'edit', title: 'Fill', contexts: ['editable'], documentUrlPatterns: ['https://login.test/*'] })
    const match = (p: string, u: string): boolean => matchPattern(p).test(u)
    expect(visibleTree(items, target(), match).map((n) => n.item.id)).toEqual(['all'])
    expect(visibleTree(items, target({ selectionText: 'word' }), match).map((n) => n.title)).toEqual(['Everywhere', 'Look up “word”'])
    expect(visibleTree(items, target({ editable: true, pageUrl: 'https://login.test/a' }), match).map((n) => n.item.id)).toEqual(['all', 'edit'])
    expect(targetContexts(target({ editable: true }))).not.toContain('page')
    expect(menuTitle('%s', 'x'.repeat(40))).toHaveLength(33)
  })

  it('reports clicks with OnClickData, flipping checkboxes', () => {
    let items = createItem([], { id: 1, title: 'Numbered', contexts: ['page'] })
    items = createItem(items, { id: 'box', title: 'Box', type: 'checkbox', checked: false })
    expect(clickData(items[0]!, target(), false)).toEqual({ menuItemId: 1, editable: false, pageUrl: 'https://site.test/', frameId: 0 })
    expect(clickData(items[1]!, target({ frameId: 7, frameUrl: 'https://id.test/' }), false)).toMatchObject({ menuItemId: 'box', checked: true, wasChecked: false, frameId: 7, frameUrl: 'https://id.test/' })
    expect(afterClick(items, 'box')[1]?.checked).toBe(true)
  })

  it('keeps an extension’s items, lists them for the page menu, and sends onClicked to it', async () => {
    const s = await setup()
    await s.op(s.pm, 'contextMenus.create', { props: { id: 'totp', title: 'Set up verification code', contexts: ['all'] } })
    await expect(s.op(s.pm, 'contextMenus.create', { props: { id: 'totp', title: 'Again' } })).rejects.toThrow(/duplicate/)
    const menu = s.host.pageMenu('default', target())
    expect(menu).toHaveLength(1)
    expect(menu[0]).toMatchObject({ extensionId: s.pm, name: 'Fixture Password Manager' })
    s.host.menuClicked('default', s.pm, 'totp', target(), null)
    expect(s.events(s.pm).at(-1)).toEqual(['contextMenus.onClicked', { menuItemId: 'totp', editable: false, pageUrl: 'https://site.test/', frameId: 0 }, undefined])
    await s.op(s.pm, 'contextMenus.removeAll', {})
    expect(s.host.pageMenu('default', target())).toEqual([])
    s.host.dispose()
  })
})
