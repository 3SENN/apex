/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import { afterAll, describe, expect, it } from 'vitest'
import { EXT_SHIM_EVENTS, EXT_SHIM_OPS, EXT_TAB_EVENTS } from '@shared/extensionShim'
import { ExtensionsHost, tabChange, type HostTab, type HostWindow, type ShimCaller } from '../src/main/extensions/host'
import { fakeAdapter } from './fixtures/extensions/fakeAdapter'

// Extensions that track tabs hear chrome.tabs.onCreated, onActivated,
// onUpdated and onRemoved. Main diffs the profile's tabs on each change and
// sends each event only to a worker or page that listens for it; address and
// title reach only an extension with the tabs permission or that site.

const WITH_TABS = join(__dirname, 'fixtures/extensions/mv3-basic')
const NO_TABS = join(__dirname, 'fixtures/extensions/localized')
const dir = mkdtempSync(join(tmpdir(), 'atelier-tab-events-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const tab = (id: number, over: Partial<HostTab> = {}): HostTab => ({
  id,
  windowId: 1,
  index: 0,
  url: 'https://news.example.com/',
  title: 'News',
  active: false,
  pinned: false,
  audible: false,
  muted: false,
  loading: false,
  favicon: null,
  ...over,
})

async function setup() {
  let tabs: HostTab[] = [tab(10, { active: true })]
  let open = true
  const win = { id: 1, profileId: 'default', focused: true, tabs: () => tabs } as unknown as HostWindow
  const host = new ExtensionsHost({
    adapter: fakeAdapter(),
    preloads: null,
    extensionsDir: (p) => join(dir, p, 'Extensions'),
    nativeHostDirs: [],
    windows: () => (open ? [win] : []),
    openTab: () => null,
    changed: () => {},
    askInstall: async () => false,
    askNative: async () => 'deny',
    toast: () => {},
    registerShortcut: () => ({ ok: true, dispose: () => {} }),
    clashesWith: () => null,
    chromeVersion: '140.0.0.0',
  })
  // A running worker for each loaded extension, reported the way Electron does.
  let report: ((e: { versionId: number; runningStatus: string }) => void) | null = null
  const scopes = new Map<number, string>()
  const workerEvents = new Map<string, unknown[][]>()
  const session = {
    serviceWorkers: {
      on: (_name: string, fn: typeof report) => void (report = fn),
      getWorkerFromVersionID: (v: number) => {
        const scope = scopes.get(v)
        if (!scope) return undefined
        const id = scope.slice('chrome-extension://'.length, -1)
        return { scope, isDestroyed: () => false, send: (_ch: string, ...args: unknown[]) => void workerEvents.get(id)?.push(args) }
      },
    },
  } as unknown as Session
  host.attach(session, 'default')
  const withTabs = await host.loadUnpacked('default', WITH_TABS)
  const noTabs = await host.loadUnpacked('default', NO_TABS)
  ;[withTabs, noTabs].forEach((id, i) => {
    scopes.set(i + 1, `chrome-extension://${id}/`)
    workerEvents.set(id, [])
    report?.({ versionId: i + 1, runningStatus: 'running' })
  })
  const worker = (extensionId: string): ShimCaller => ({ extensionId, send: () => {}, webContents: null, keepAlive: () => () => {} })
  return {
    host,
    withTabs,
    noTabs,
    worker,
    events: (id: string) => workerEvents.get(id) ?? [],
    setTabs: (next: HostTab[]) => void (tabs = next),
    closeWindow: () => {
      open = false
      tabs = []
    },
  }
}

describe('chrome.tabs events', () => {
  it('the shim contract carries the four events and the listen call', () => {
    expect(EXT_TAB_EVENTS).toEqual(['tabs.onCreated', 'tabs.onActivated', 'tabs.onUpdated', 'tabs.onRemoved'])
    for (const e of EXT_TAB_EVENTS) expect(EXT_SHIM_EVENTS).toContain(e)
    expect(EXT_SHIM_OPS).toContain('tabs.listen')
  })

  it('sends created, activated, updated and removed to a listening worker', async () => {
    const s = await setup()
    for (const e of EXT_TAB_EVENTS) s.host.listenTabs('default', s.worker(s.withTabs), e)
    s.host.syncTabs('default')
    expect(s.events(s.withTabs)).toEqual([])

    s.setTabs([tab(10), tab(11, { index: 1, active: true, url: 'https://mail.example.com/', title: 'Mail', loading: true })])
    s.host.syncTabs('default')
    const names = s.events(s.withTabs).map((e) => e[0])
    expect(names).toEqual(['tabs.onCreated', 'tabs.onActivated'])
    expect(s.events(s.withTabs)[0]?.[1]).toMatchObject({ id: 11, url: 'https://mail.example.com/', title: 'Mail', status: 'loading' })
    expect(s.events(s.withTabs)[1]?.[1]).toEqual({ tabId: 11, windowId: 1 })

    s.setTabs([tab(10), tab(11, { index: 1, active: true, url: 'https://mail.example.com/inbox', title: 'Inbox' })])
    s.host.syncTabs('default')
    const updated = s.events(s.withTabs).at(-1)
    expect(updated?.[0]).toBe('tabs.onUpdated')
    expect(updated?.[1]).toBe(11)
    expect(updated?.[2]).toEqual({ status: 'complete', url: 'https://mail.example.com/inbox', title: 'Inbox' })

    s.setTabs([tab(11, { active: true, url: 'https://mail.example.com/inbox', title: 'Inbox' })])
    s.host.syncTabs('default')
    expect(s.events(s.withTabs).at(-1)).toEqual(['tabs.onRemoved', 10, { windowId: 1, isWindowClosing: false }])

    s.closeWindow()
    s.host.syncTabs('default')
    expect(s.events(s.withTabs).at(-1)).toEqual(['tabs.onRemoved', 11, { windowId: 1, isWindowClosing: true }])
    s.host.dispose()
  })

  it('sends nothing to an extension that added no listener, and only the events it listens for', async () => {
    const s = await setup()
    s.host.listenTabs('default', s.worker(s.withTabs), 'tabs.onRemoved')
    s.setTabs([tab(10, { active: true }), tab(12, { index: 1 })])
    s.host.syncTabs('default')
    s.setTabs([tab(10, { active: true })])
    s.host.syncTabs('default')
    expect(s.events(s.withTabs).map((e) => e[0])).toEqual(['tabs.onRemoved'])
    expect(s.events(s.noTabs)).toEqual([])
    s.host.dispose()
  })

  it('keeps the address and title from an extension without the tabs permission or that site', async () => {
    const s = await setup()
    for (const e of EXT_TAB_EVENTS) s.host.listenTabs('default', s.worker(s.noTabs), e)
    s.setTabs([tab(10, { active: true }), tab(13, { index: 1, url: 'https://bank.test/', title: 'Bank' })])
    s.host.syncTabs('default')
    const created = s.events(s.noTabs).find((e) => e[0] === 'tabs.onCreated')?.[1] as Record<string, unknown>
    expect(created).toMatchObject({ id: 13, windowId: 1, status: 'complete' })
    expect(created).not.toHaveProperty('url')
    expect(created).not.toHaveProperty('title')
    // A title-only change tells it nothing it may see, so no onUpdated at all.
    s.setTabs([tab(10, { active: true }), tab(13, { index: 1, url: 'https://bank.test/', title: 'Bank – balance' })])
    s.host.syncTabs('default')
    expect(s.events(s.noTabs).filter((e) => e[0] === 'tabs.onUpdated')).toEqual([])
    // Pinning is not private: it hears that, without the address.
    s.setTabs([tab(10, { active: true }), tab(13, { index: 1, url: 'https://bank.test/', title: 'Bank – balance', pinned: true })])
    s.host.syncTabs('default')
    expect(s.events(s.noTabs).filter((e) => e[0] === 'tabs.onUpdated').map((e) => e[2])).toEqual([{ pinned: true }])
    s.host.dispose()
  })

  it('sends to a listening extension page until it is destroyed', async () => {
    const s = await setup()
    const got: unknown[][] = []
    let destroyed = false
    const page: ShimCaller = {
      extensionId: s.withTabs,
      send: (...args) => void got.push(args),
      webContents: { isDestroyed: () => destroyed, once: () => {} } as unknown as WebContents,
      keepAlive: () => () => {},
    }
    s.host.listenTabs('default', page, 'tabs.onCreated')
    s.setTabs([tab(10, { active: true }), tab(14, { index: 1 })])
    s.host.syncTabs('default')
    expect(got.map((e) => e[0])).toEqual(['tabs.onCreated'])
    destroyed = true
    s.setTabs([tab(10, { active: true }), tab(14, { index: 1 }), tab(15, { index: 2 })])
    s.host.syncTabs('default')
    expect(got).toHaveLength(1)
    s.host.dispose()
  })

  it('scheduleTabSync coalesces a burst into one sync on the next turn', async () => {
    const s = await setup()
    s.host.listenTabs('default', s.worker(s.withTabs), 'tabs.onCreated')
    s.setTabs([tab(10, { active: true }), tab(16, { index: 1 })])
    s.host.scheduleTabSync('default')
    s.host.scheduleTabSync('default')
    expect(s.events(s.withTabs)).toEqual([])
    await new Promise((r) => setTimeout(r, 5))
    expect(s.events(s.withTabs).map((e) => e[0])).toEqual(['tabs.onCreated'])
    s.host.dispose()
  })
})

describe('tabChange', () => {
  it('reports only what changed, in Chrome’s field names', () => {
    expect(tabChange(tab(1), tab(1))).toBeNull()
    expect(tabChange(tab(1), tab(1, { muted: true, audible: true }))).toEqual({ audible: true, mutedInfo: { muted: true } })
    expect(tabChange(tab(1), tab(1, { favicon: 'https://news.example.com/f.ico' }))).toEqual({ favIconUrl: 'https://news.example.com/f.ico' })
  })
})
