/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBARGO_MS, QUIET_TIMEOUT_MS, type QueryStates } from '@shared/permissions'
import type { PermissionPromptProps } from '@shared/overlay/sites'

// The permissions pass: how the controller decides a website's request
// end to end, with Electron, macOS and the prompt surface stubbed.

const env = vi.hoisted(() => ({
  media: { camera: 'granted', microphone: 'granted' } as Record<string, string>,
  askAnswer: true,
  ipc: new Map<string, (event: { sender: unknown; senderFrame: unknown; returnValue?: unknown }) => void>(),
  prompts: [] as { props: PermissionPromptProps; resolve(result: unknown): void }[],
}))

vi.mock('electron', () => {
  const noop: unknown = new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : noop), apply: () => noop, construct: () => noop as object })
  const real: Record<string, unknown> = {
    ipcMain: { on: (channel: string, fn: never) => env.ipc.set(channel, fn) },
    systemPreferences: {
      getMediaAccessStatus: (kind: string) => env.media[kind],
      askForMediaAccess: async (kind: string) => {
        env.media[kind] = env.askAnswer ? 'granted' : 'denied'
        return env.askAnswer
      },
    },
  }
  return new Proxy(real, { get: (t, key) => (key === 'then' || key === '__esModule' ? undefined : key in t ? t[key as string] : noop), has: () => true })
})

vi.mock('../src/main/siteOverlay', () => ({
  windowOfTab: () => ({}),
  siteButtonAnchor: async () => ({}),
  presentSurface: (_win: unknown, _surface: string, _anchor: unknown, props: PermissionPromptProps) => new Promise((resolve) => env.prompts.push({ props, resolve })),
  resultValue: (r: { value?: unknown } | null) => (r && 'value' in r ? r.value : null),
}))

const { PermissionController, answerOf, answerQuietRequest, oneTimeGrants, onPermissionActivity, tabPermissionActivity } = await import('../src/main/permissions')
const { PermissionHistory, historyFileFor } = await import('../src/main/permissionHistory')
const { sites } = await import('../src/main/sites')
const { TabRegistry } = await import('../src/main/tabRegistry')
const { override } = await import('../src/preload/page/permissionStatus')

type Handler = (...args: unknown[]) => unknown

interface FakeWc {
  id: number
  url: string
  session: FakeSession
  mainFrame: { origin: string; url: string; framesInSubtree: unknown[]; send: (...a: unknown[]) => void }
  isDestroyed(): boolean
  getURL(): string
}
interface FakeSession {
  request: Handler | null
  check: Handler | null
  setPermissionRequestHandler(fn: Handler): void
  setPermissionCheckHandler(fn: Handler): void
}

const dirs: string[] = []
let wcIds = 1
let tabIds = 1
let settings: { sitePermissionDefaults: Record<string, 'ask' | 'block'>; quietNotificationPrompts: boolean }
let location: string | undefined
let openers: Map<number, FakeWc>
let notes: string[]
let grants: unknown[]
let registry: InstanceType<typeof TabRegistry>
let controller: InstanceType<typeof PermissionController>
let session: FakeSession
const platform = process.platform

function fakeSession(): FakeSession {
  const s: FakeSession = {
    request: null,
    check: null,
    setPermissionRequestHandler(fn) {
      s.request = fn
    },
    setPermissionCheckHandler(fn) {
      s.check = fn
    },
  }
  return s
}

function fakeWc(url: string): FakeWc {
  const sent: unknown[] = []
  const wc: FakeWc = {
    id: wcIds++,
    url,
    session,
    mainFrame: { origin: new URL(url).origin, url, framesInSubtree: [], send: (...a) => sent.push(a) },
    isDestroyed: () => false,
    getURL: () => wc.url,
  }
  wc.mainFrame.framesInSubtree = [wc.mainFrame]
  return wc
}

function openTab(url: string): { id: string; wc: FakeWc; agentControlled: boolean } {
  const wc = fakeWc(url)
  const tab = { id: `t${tabIds++}`, agentControlled: false, view: { webContents: wc } }
  registry.add(tab as never, 1)
  return { id: tab.id, wc, get agentControlled() { return tab.agentControlled }, set agentControlled(v) { tab.agentControlled = v } }
}

function request(wc: FakeWc, permission: string, details: Record<string, unknown> = {}): Promise<boolean> {
  return new Promise((resolve) => session.request!(wc, permission, resolve, { requestingUrl: wc.getURL(), isMainFrame: true, ...details }))
}

function check(wc: FakeWc | null, permission: string, origin: string, details: Record<string, unknown> = {}): boolean {
  return session.check!(wc, permission, origin, { isMainFrame: true, requestingUrl: origin, ...details }) as boolean
}

async function nextPrompt(): Promise<(typeof env.prompts)[number]> {
  await vi.waitFor(() => expect(env.prompts.length).toBeGreaterThan(0))
  return env.prompts.shift()!
}

const answer = (allow: boolean, remember = false): unknown => ({ instanceId: 'i', value: { allow, remember } })
const escape = { instanceId: 'i', dismissed: 'escape' }

function states(wc: FakeWc, frame: unknown = wc.mainFrame): QueryStates {
  const event: { sender: unknown; senderFrame: unknown; returnValue?: unknown } = { sender: wc, senderFrame: frame }
  env.ipc.get('apex-page:permissions')!(event)
  return event.returnValue as QueryStates
}

beforeAll(() => {
  // The macOS checks only run on a Mac.
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  env.media.camera = 'granted'
  env.media.microphone = 'granted'
  env.askAnswer = true
  env.prompts.length = 0
  settings = { sitePermissionDefaults: {}, quietNotificationPrompts: false }
  location = undefined
  openers = new Map()
  notes = []
  grants = []
  registry = new TabRegistry()
  session = fakeSession()
  const dir = mkdtempSync(join(tmpdir(), 'apex-perm-'))
  dirs.push(dir)
  sites.attach(session as never, { private: false, dataDir: dir })
  controller = new PermissionController({
    windows: {} as never,
    tabsRegistry: registry,
    noteForAgent: (_id, text) => notes.push(text),
    capture: { grant: (id: string, kinds: unknown) => grants.push([id, kinds]) } as never,
    broadcast: () => undefined,
    smoke: false,
    settings: () => settings,
    systemLocation: async () => location as never,
    openerOf: (wc) => (openers.get(wc.id) as never) ?? null,
  })
  controller.install(session as never, { private: false, partition: 'persist:apex' })
})

afterEach(() => {
  vi.useRealTimers()
})

const store = () => sites.storeFor(session as never)!

describe('asking and one-off answers', () => {
  it('keeps a camera-and-microphone one-off answer per permission, so a camera-only check reads it', async () => {
    const tab = openTab('https://meet.example/room')
    const pending = request(tab.wc, 'media', { mediaTypes: ['video', 'audio'] })
    const prompt = await nextPrompt()
    expect(prompt.props.host).toBe('meet.example')
    prompt.resolve(answer(true))
    expect(await pending).toBe(true)
    expect(grants).toEqual([[tab.id, ['camera', 'microphone']]])
    expect(check(tab.wc, 'media', 'https://meet.example', { mediaType: 'video' })).toBe(true)
    expect(check(tab.wc, 'media', 'https://meet.example', { mediaType: 'audio' })).toBe(true)
    expect(oneTimeGrants(tab.id).sort()).toEqual(['camera', 'microphone'])
    expect(store().permission('https://meet.example', 'camera')).toBe('ask')
    // Site info's Revoke takes back that one permission only.
    controller.revokeOneTime(tab.id, 'camera')
    expect(oneTimeGrants(tab.id)).toEqual(['microphone'])
    expect(check(tab.wc, 'media', 'https://meet.example', { mediaType: 'audio' })).toBe(true)
  })

  it('reports a refusal as blocked activity, and clears activity on navigation', async () => {
    const tab = openTab('https://maps.example/')
    const seen: unknown[] = []
    const off = onPermissionActivity((a) => seen.push(a))
    const pending = request(tab.wc, 'geolocation')
    ;(await nextPrompt()).resolve(answer(false))
    expect(await pending).toBe(false)
    expect(tabPermissionActivity(tab.id)).toEqual([{ tabId: tab.id, origin: 'https://maps.example', permission: 'location', outcome: 'blocked' }])
    expect(seen).toHaveLength(1)
    // The one-off refusal stands for the tab without another prompt.
    expect(await request(tab.wc, 'geolocation')).toBe(false)
    expect(env.prompts).toHaveLength(0)
    controller.navigated(tab.id)
    expect(tabPermissionActivity(tab.id)).toEqual([])
    off()
  })
})

describe('what the page reads (check and permissions.query)', () => {
  it('reads never asked as prompt, and stored answers as granted or denied', () => {
    const tab = openTab('https://chat.example/')
    expect(check(tab.wc, 'notifications', 'https://chat.example')).toBe(false)
    expect(states(tab.wc).notifications).toBe('prompt')
    expect(states(tab.wc).geolocation).toBe('prompt')
    store().set('https://chat.example', { permissions: { notifications: 'allow', location: 'block' } })
    expect(states(tab.wc).notifications).toBe('granted')
    expect(states(tab.wc).push).toBe('granted')
    expect(states(tab.wc).geolocation).toBe('denied')
    expect(check(tab.wc, 'notifications', 'https://chat.example')).toBe(true)
  })

  it('answers only sessions it was installed on', () => {
    const tab = openTab('https://chat.example/')
    const other = { ...tab.wc, session: fakeSession() }
    expect(states(other as never)).toBeNull()
  })

  it('lets a service worker read its site’s stored answer', () => {
    store().set('https://chat.example', { permissions: { notifications: 'allow' } })
    expect(check(null, 'notifications', 'https://chat.example', { isMainFrame: false })).toBe(true)
    expect(check(null, 'notifications', 'https://other.example', { isMainFrame: false })).toBe(false)
  })
})

describe('frames (permission delegation)', () => {
  it('asks as the top-level page for a delegated cross-origin frame, and stores it there', async () => {
    const tab = openTab('https://news.example/story')
    const pending = request(tab.wc, 'geolocation', { requestingUrl: 'https://maps.vendor.com/embed', isMainFrame: false })
    const prompt = await nextPrompt()
    expect(prompt.props.origin).toBe('https://news.example')
    expect(prompt.props.host).toBe('news.example')
    expect(prompt.props.embedded).toBe('maps.vendor.com')
    prompt.resolve(answer(true, true))
    expect(await pending).toBe(true)
    expect(store().permission('https://news.example', 'location')).toBe('allow')
    expect(store().permission('https://maps.vendor.com', 'location')).toBe('ask')
    expect(check(tab.wc, 'geolocation', 'https://maps.vendor.com', { isMainFrame: false })).toBe(true)
  })

  it('refuses notifications to a cross-origin frame without asking', async () => {
    const tab = openTab('https://news.example/story')
    expect(await request(tab.wc, 'notifications', { requestingUrl: 'https://ads.example.net/frame', isMainFrame: false })).toBe(false)
    expect(env.prompts).toHaveLength(0)
    const frame = { origin: 'https://ads.example.net', url: 'https://ads.example.net/frame' }
    expect(states(tab.wc, frame).notifications).toBe('denied')
    expect(states(tab.wc, frame).geolocation).toBe('prompt')
  })
})

describe('macOS turned Apex off', () => {
  it('says so even where the site is allowed, once per page', async () => {
    const tab = openTab('https://meet.example/')
    store().set('https://meet.example', { permissions: { camera: 'allow' } })
    env.media.camera = 'denied'
    const pending = request(tab.wc, 'media', { mediaTypes: ['video'] })
    const prompt = await nextPrompt()
    expect(prompt.props.systemBlocked).toEqual(['camera'])
    expect(prompt.props.remember).toBeNull()
    prompt.resolve(answer(false))
    expect(await pending).toBe(false)
    expect(tabPermissionActivity(tab.id)).toContainEqual({ tabId: tab.id, origin: 'https://meet.example', permission: 'camera', outcome: 'blocked-by-macos' })
    // The second request on the page only refuses; the chip still shows the way back.
    expect(await request(tab.wc, 'media', { mediaTypes: ['video'] })).toBe(false)
    expect(env.prompts).toHaveLength(0)
    expect(grants).toEqual([])
  })

  it('asks macOS once after the site is allowed, and reports a refusal there', async () => {
    const tab = openTab('https://meet.example/')
    store().set('https://meet.example', { permissions: { microphone: 'allow' } })
    env.media.microphone = 'not-determined'
    env.askAnswer = false
    expect(await request(tab.wc, 'media', { mediaTypes: ['audio'] })).toBe(false)
    expect(tabPermissionActivity(tab.id).map((a) => a.outcome)).toEqual(['blocked-by-macos'])
  })

  it('reads Location Services from the speech helper, and blocks nothing while it is unknown', async () => {
    const tab = openTab('https://maps.example/')
    store().set('https://maps.example', { permissions: { location: 'allow' } })
    expect(await request(tab.wc, 'geolocation')).toBe(true)
    location = 'denied'
    const pending = request(tab.wc, 'geolocation')
    const prompt = await nextPrompt()
    expect(prompt.props.systemBlocked).toEqual(['location'])
    prompt.resolve(answer(false))
    expect(await pending).toBe(false)
    expect(tabPermissionActivity(tab.id)).toContainEqual({ tabId: tab.id, origin: 'https://maps.example', permission: 'location', outcome: 'blocked-by-macos' })
  })
})

describe('dismissals', () => {
  it('blocks a question for a week after three dismissals, and remembers that across restarts', async () => {
    const tab = openTab('https://spam.example/')
    for (let i = 0; i < 3; i++) {
      const pending = request(tab.wc, 'geolocation')
      ;(await nextPrompt()).resolve(i === 1 ? { instanceId: 'i', value: { dismissed: true } } : escape)
      expect(await pending).toBe(false)
    }
    expect(tabPermissionActivity(tab.id)).toContainEqual({ tabId: tab.id, origin: 'https://spam.example', permission: 'location', outcome: 'blocked' })
    expect(await request(tab.wc, 'geolocation')).toBe(false)
    expect(env.prompts).toHaveLength(0)
    expect(states(tab.wc).geolocation).toBe('denied')
    // Nothing was stored as the site's answer.
    expect(store().permission('https://spam.example', 'location')).toBe('ask')
    const reread = new PermissionHistory(historyFileFor(store().file))
    expect(reread.embargoed('https://spam.example', 'location')).toBe(true)
    expect(reread.embargoed('https://spam.example', 'location', Date.now() + EMBARGO_MS + 1)).toBe(false)
    // A change in site info lifts it.
    controller.forgetOrigin('https://spam.example')
    const again = request(tab.wc, 'geolocation')
    ;(await nextPrompt()).resolve(answer(true))
    expect(await again).toBe(true)
  })

  it('counts nothing when a prompt is closed for its tab', async () => {
    const tab = openTab('https://a.example/')
    const pending = request(tab.wc, 'geolocation')
    ;(await nextPrompt()).resolve({ instanceId: 'i', dismissed: 'closed' })
    expect(await pending).toBe(false)
    expect(tabPermissionActivity(tab.id)).toEqual([])
    const reread = new PermissionHistory(historyFileFor(store().file))
    expect(reread.get('https://a.example', 'location')).toBeUndefined()
  })

  it('reads the prompt’s answers and dismissals', () => {
    expect(answerOf({ instanceId: 'i', dismissed: 'escape' })?.dismissed).toBe(true)
    expect(answerOf({ instanceId: 'i', value: { dismissed: true } })?.dismissed).toBe(true)
    expect(answerOf({ instanceId: 'i', dismissed: 'closed' })).toBeNull()
    expect(answerOf({ instanceId: 'i', value: { allow: true, remember: true } })).toEqual({ allow: true, remember: true })
    expect(answerOf(null)).toBeNull()
  })
})

describe('quiet notification requests', () => {
  it('waits on the chip instead of a prompt when turned on, and keeps the chip’s answer', async () => {
    settings.quietNotificationPrompts = true
    const tab = openTab('https://news.example/')
    const pending = request(tab.wc, 'notifications')
    await vi.waitFor(() => expect(tabPermissionActivity(tab.id)).toEqual([{ tabId: tab.id, origin: 'https://news.example', permission: 'notifications', outcome: 'quiet' }]))
    expect(env.prompts).toHaveLength(0)
    answerQuietRequest(tab.id, 'notifications', true)
    expect(await pending).toBe(true)
    expect(store().permission('https://news.example', 'notifications')).toBe('allow')
    expect(tabPermissionActivity(tab.id)).toEqual([])
  })

  it('asks quietly once the prompt was put away, and ends unanswered as a dismissal', async () => {
    const tab = openTab('https://news.example/')
    const first = request(tab.wc, 'notifications')
    ;(await nextPrompt()).resolve(escape)
    expect(await first).toBe(false)
    vi.useFakeTimers()
    const second = request(tab.wc, 'notifications')
    await vi.advanceTimersByTimeAsync(10)
    expect(env.prompts).toHaveLength(0)
    expect(tabPermissionActivity(tab.id).map((a) => a.outcome)).toEqual(['quiet'])
    await vi.advanceTimersByTimeAsync(QUIET_TIMEOUT_MS)
    expect(await second).toBe(false)
    vi.useRealTimers()
    expect(new PermissionHistory(historyFileFor(store().file)).get('https://news.example', 'notifications')?.dismissals).toBe(2)
    // The chip still answers after the wait ran out, for the page's next request.
    answerQuietRequest(tab.id, 'notifications', false)
    expect(store().permission('https://news.example', 'notifications')).toBe('block')
  })

  it('refuses a waiting quiet request when the page moves on', async () => {
    settings.quietNotificationPrompts = true
    const tab = openTab('https://news.example/')
    const pending = request(tab.wc, 'notifications')
    await vi.waitFor(() => expect(tabPermissionActivity(tab.id)).toHaveLength(1))
    controller.navigated(tab.id)
    expect(await pending).toBe(false)
  })
})

describe('defaults, secure contexts and new questions', () => {
  it('refuses without asking where the default is Block and the site has no answer', async () => {
    settings.sitePermissionDefaults = { notifications: 'block' }
    const tab = openTab('https://news.example/')
    expect(await request(tab.wc, 'notifications')).toBe(false)
    expect(env.prompts).toHaveLength(0)
    expect(tabPermissionActivity(tab.id).map((a) => a.outcome)).toEqual(['blocked'])
    expect(states(tab.wc).notifications).toBe('denied')
    store().set('https://news.example', { permissions: { notifications: 'allow' } })
    expect(await request(tab.wc, 'notifications')).toBe(true)
  })

  it('keeps powerful features from insecure pages', async () => {
    const tab = openTab('http://plain.example/')
    for (const p of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'local-fonts', 'idle-detection']) expect(await request(tab.wc, p)).toBe(false)
    expect(await request(tab.wc, 'media', { mediaTypes: ['video'] })).toBe(false)
    expect(env.prompts).toHaveLength(0)
    expect(check(tab.wc, 'hid', 'http://plain.example')).toBe(false)
    expect(states(tab.wc).geolocation).toBe('denied')
    const local = openTab('http://localhost:5173/')
    expect(check(local.wc, 'hid', 'http://localhost:5173')).toBe(true)
  })

  it('asks before a site places windows across displays', async () => {
    const tab = openTab('https://slides.example/')
    const pending = request(tab.wc, 'window-management')
    const prompt = await nextPrompt()
    expect(prompt.props.perms).toEqual(['window-management'])
    prompt.resolve(answer(true))
    expect(await pending).toBe(true)
  })

  it('never allows full screen without a click, nor full screen to the agent', async () => {
    const tab = openTab('https://video.example/')
    expect(await request(tab.wc, 'automatic-fullscreen')).toBe(false)
    expect(await request(tab.wc, 'fullscreen')).toBe(true)
    tab.agentControlled = true
    expect(await request(tab.wc, 'fullscreen')).toBe(false)
    expect(await request(tab.wc, 'automatic-fullscreen')).toBe(false)
    expect(notes).toHaveLength(1)
  })

  it('tells every other page about new defaults while one tab’s frame is being replaced', () => {
    const moving = openTab('https://moving.example/')
    Object.defineProperty(moving.wc, 'mainFrame', {
      get() {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      },
    })
    const steady = openTab('https://steady.example/')
    const sent: unknown[] = []
    steady.wc.mainFrame.send = (...a) => sent.push(a)
    settings.sitePermissionDefaults = { notifications: 'block' }
    expect(() => controller.refresh()).not.toThrow()
    expect(sent).toHaveLength(1)
  })
})

describe('popups and views without a tab', () => {
  it('asks a popup’s question through its opener’s tab, never for the camera', async () => {
    const tab = openTab('https://shop.example/')
    const popup = fakeWc('https://pay.example/checkout')
    openers.set(popup.id, tab.wc)
    const pending = request(popup, 'geolocation')
    const prompt = await nextPrompt()
    expect(prompt.props.tabId).toBe(tab.id)
    expect(prompt.props.origin).toBe('https://pay.example')
    prompt.resolve(answer(true))
    expect(await pending).toBe(true)
    expect(check(popup, 'geolocation', 'https://pay.example')).toBe(true)
    expect(await request(popup, 'media', { mediaTypes: ['video'] })).toBe(false)
    expect(check(popup, 'media', 'https://pay.example', { mediaType: 'video' })).toBe(false)
    expect(env.prompts).toHaveLength(0)
  })

  it('makes the check agree with the refusal where there is no tab to ask in', async () => {
    const peek = fakeWc('https://maps.example/')
    store().set('https://maps.example', { permissions: { location: 'allow', notifications: 'allow' } })
    expect(await request(peek, 'geolocation')).toBe(false)
    expect(check(peek, 'geolocation', 'https://maps.example')).toBe(false)
    expect(check(peek, 'hid', 'https://maps.example')).toBe(false)
  })
})

describe('the page’s permission status (main-world override)', () => {
  const saved: Record<string, unknown> = {}
  const g = globalThis as Record<string, unknown>

  beforeEach(() => {
    for (const k of ['Permissions', 'PermissionStatus', 'Notification']) saved[k] = g[k]
    class PermissionStatus extends EventTarget {
      constructor(readonly name: string) {
        super()
      }
      get state(): string {
        return 'denied'
      }
    }
    class Permissions {
      query(d: { name: string }): Promise<PermissionStatus> {
        if (d.name === 'nope') return Promise.reject(new TypeError('bad name'))
        return Promise.resolve(new PermissionStatus(d.name))
      }
    }
    class Notification {
      static get permission(): string {
        return 'denied'
      }
    }
    Object.assign(g, { Permissions, PermissionStatus, Notification })
  })
  afterEach(() => {
    Object.assign(g, saved)
  })

  it('reports never asked as prompt, fires change when the answer moves, and leaves other names alone', async () => {
    let push: ((s: QueryStates) => void) | null = null
    override({ states: () => ({ notifications: 'prompt', geolocation: 'prompt' }), onChange: (fn) => (push = fn) })
    const permissions = new (g.Permissions as new () => { query(d: { name: string }): Promise<EventTarget & { state: string; onchange?: unknown }> })()
    const status = await permissions.query({ name: 'geolocation' })
    expect(status.state).toBe('prompt')
    expect((g.Notification as { permission: string }).permission).toBe('default')
    expect((await permissions.query({ name: 'persistent-storage' })).state).toBe('denied')
    await expect(permissions.query({ name: 'nope' })).rejects.toThrow('bad name')
    const changes: string[] = []
    status.addEventListener('change', () => changes.push(status.state))
    push!({ notifications: 'granted', geolocation: 'granted' })
    expect(changes).toEqual(['granted'])
    expect((g.Notification as { permission: string }).permission).toBe('granted')
    // The wrapped natives still read as native code.
    expect(Function.prototype.toString.call((g.Permissions as { prototype: { query: unknown } }).prototype.query)).toContain('[native code]')
  })
})
