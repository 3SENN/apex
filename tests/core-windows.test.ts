/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { SavedWindow } from '@shared/windows'
import { ClosedEntries } from '../src/main/closedEntries'
import { dockItems, dockWindowId } from '../src/main/dockMenu'
import type { WindowContext } from '../src/main/features/types'
import { KeepAwake } from '../src/main/powerSave'
import { SessionWriter, keepingLastWindows, parseSession } from '../src/main/sessionRestore'
import { CLOSE_COALESCE_MS, CloseCoalescer, WindowManager, closeTarget, needsCloseConfirm, offsetBounds } from '../src/main/windows'

// Windows: close order and coalescing, the closed-entry stack, the session
// round trip (corrupt and newer files start fresh), private windows never
// saved or remembered, the Dock rows and keep-awake.

const base = { popupFocused: false, otherWindowFocused: false, windowFocused: true, peekOpen: false, rail: false, selection: 0, activeTab: true }

describe('close order (SH-26)', () => {
  it('closes a focused popup, then peek, then the selection, then the active tab', () => {
    expect(closeTarget({ ...base, popupFocused: true, peekOpen: true, selection: 3 })).toBe('popup')
    expect(closeTarget({ ...base, peekOpen: true, selection: 3 })).toBe('peek')
    expect(closeTarget({ ...base, rail: true, selection: 3 })).toBe('rail')
    expect(closeTarget({ ...base, selection: 3 })).toBe('selection')
    expect(closeTarget({ ...base, selection: 1 })).toBe('tab')
    expect(closeTarget({ ...base, activeTab: false })).toBe('none')
    expect(closeTarget({ ...base, otherWindowFocused: true })).toBe('other-window')
    expect(closeTarget({ ...base, windowFocused: false })).toBe('none')
  })

  it('combines repeats within about 300 ms into one press', () => {
    const c = new CloseCoalescer()
    expect(c.accept(1000)).toBe(true)
    expect(c.accept(1000 + CLOSE_COALESCE_MS - 1)).toBe(false)
    expect(c.accept(1000 + CLOSE_COALESCE_MS)).toBe(true)
  })

  it('asks before closing a window with several unpinned tabs (ST-22)', () => {
    expect(needsCloseConfirm({ enabled: true, kind: 'normal', unpinnedTabs: 2 })).toBe(true)
    expect(needsCloseConfirm({ enabled: true, kind: 'normal', unpinnedTabs: 1 })).toBe(false)
    expect(needsCloseConfirm({ enabled: false, kind: 'normal', unpinnedTabs: 5 })).toBe(false)
    expect(needsCloseConfirm({ enabled: true, kind: 'chat', unpinnedTabs: 5 })).toBe(false)
  })

  it('offsets new windows 24 px and wraps inside the work area', () => {
    const area = { x: 0, y: 0, width: 1440, height: 900 }
    expect(offsetBounds({ x: 100, y: 80, width: 800, height: 600 }, area)).toEqual({ x: 124, y: 104, width: 800, height: 600 })
    const wrapped = offsetBounds({ x: 630, y: 290, width: 800, height: 600 }, area)
    expect(wrapped.x + wrapped.width).toBeLessThanOrEqual(1440)
    expect(wrapped.y + wrapped.height).toBeLessThanOrEqual(900)
  })
})

describe('the closed-entry stack (SH-27)', () => {
  const tab = (url: string, at: number) => ({ kind: 'tab' as const, title: url, url, closedAt: at, index: 0, pinned: false, entries: [{ url, title: url }], entryIndex: 0, groupId: null })
  it('lists the newest first, capped, and takes by index', () => {
    const s = new ClosedEntries(3)
    for (let i = 1; i <= 4; i++) s.push(tab(`https://e.test/${i}`, i))
    s.push(tab('about:blank', 9))
    s.push({ kind: 'window', title: 'w', tabCount: 0, closedAt: 9, saved: {} as SavedWindow })
    expect(s.size).toBe(3)
    expect(s.list().map((e) => (e.kind === 'tab' ? e.url : e.kind))).toEqual(['https://e.test/4', 'https://e.test/3', 'https://e.test/2'])
    expect(s.list(1)).toHaveLength(1)
    expect(s.take(1)?.kind === 'tab' && s.size).toBe(2)
    expect(s.take(5)).toBeNull()
    expect(s.take(-1)).toBeNull()
  })

  it('forgets a deleted chat', () => {
    const s = new ClosedEntries()
    s.push({ kind: 'chat', chatId: 'c1', title: 'A chat', closedAt: 1 })
    s.push(tab('https://e.test/', 2))
    s.forgetChat('c1')
    expect(s.list().map((e) => e.kind)).toEqual(['tab'])
  })
})

const savedWindow = (over: Partial<SavedWindow> = {}): SavedWindow => ({
  bounds: { x: 10, y: 20, width: 1200, height: 800 },
  displayMode: 'normal',
  sidebarOpen: true,
  name: null,
  tabs: [
    { url: 'https://a.test/', title: 'A', pinned: true, groupId: null, entries: [{ url: 'https://a.test/', title: 'A' }], index: 0 },
    { url: 'https://b.test/2', title: 'B', pinned: false, groupId: 'g1', entries: [{ url: 'https://b.test/1', title: 'B1' }, { url: 'https://b.test/2', title: 'B' }], index: 1 },
  ],
  activeIndex: 1,
  split: { primary: 0, secondary: 1, ratio: 0.4 },
  groups: [{ id: 'g1', name: 'Work', color: 'lagoon', collapsed: false }],
  ...over,
})

describe('session.json', () => {
  it('round-trips windows, tabs with history, groups and split', () => {
    const session = { version: 1 as const, windows: [savedWindow(), savedWindow({ name: 'Second', displayMode: 'maximized', split: null })] }
    const read = parseSession(JSON.stringify(session))
    expect(read).toEqual({ ok: true, session })
  })

  it('starts fresh, with a reason, from a missing, corrupt or newer file', () => {
    expect(parseSession(null)).toEqual({ ok: false, reason: 'missing' })
    expect(parseSession('{"version":1,"windows":[')).toEqual({ ok: false, reason: 'corrupt' })
    expect(parseSession('"text"')).toEqual({ ok: false, reason: 'corrupt' })
    expect(parseSession('{"version":1}')).toEqual({ ok: false, reason: 'corrupt' })
    expect(parseSession(JSON.stringify({ version: 2, windows: [] }))).toEqual({ ok: false, reason: 'newer' })
  })

  it('drops a bad tab or window, not the session, and repairs indexes', () => {
    const bad = savedWindow({ activeIndex: 9, tabs: [{ url: '', title: 'x' } as never, savedWindow().tabs[0]!], split: { primary: 0, secondary: 1, ratio: 0.5 } })
    const read = parseSession(JSON.stringify({ version: 1, windows: [bad, { nonsense: true }] }))
    expect(read.ok && read.session.windows).toHaveLength(1)
    const w = read.ok ? read.session.windows[0] : null
    expect(w?.tabs).toHaveLength(1)
    expect(w?.activeIndex).toBe(0)
    expect(w?.split).toBeNull()
  })

  it('debounces writes, flushes on demand and stays frozen after quit', async () => {
    const writes: number[] = []
    let n = 0
    const writer = new SessionWriter('/nowhere/session.json', () => ({ version: 1, windows: [] }), { write: () => void writes.push(++n), delayMs: 20 })
    writer.schedule()
    writer.schedule()
    await new Promise((r) => setTimeout(r, 40))
    expect(writes).toEqual([1])
    writer.schedule()
    await writer.flush()
    expect(writes).toEqual([1, 2])
    writer.freeze()
    writer.schedule()
    await new Promise((r) => setTimeout(r, 40))
    expect(writes).toEqual([1, 2])
  })

  it('keeps the last window’s tabs after its X quits Atelier on Windows and Linux, and not on macOS', () => {
    const open = { version: 1 as const, windows: [savedWindow()] }
    const gone = { version: 1 as const, windows: [] }
    let now: typeof open | typeof gone = open
    // Windows: the window is gone by the time quitting saves; what it had stays.
    const windows = keepingLastWindows(() => now, true)
    expect(windows()).toBe(open)
    now = gone
    expect(windows()).toBe(open)
    // A window opened later (background mode's Open Atelier) is the session from then on.
    const later = { version: 1 as const, windows: [savedWindow({ name: 'Later' })] }
    now = later
    expect(windows()).toBe(later)
    // macOS: closing the last window leaves Atelier in the Dock, and quitting after that starts afresh.
    now = open
    const mac = keepingLastWindows(() => now, false)
    expect(mac()).toBe(open)
    now = gone
    expect(mac()).toBe(gone)
  })
})

// ---- WindowManager with fake windows: private windows are never saved or remembered ----

interface FakeTab {
  id: string
  pinned: boolean
  internalUrl: string | null
  view: { webContents: { isDestroyed(): boolean } }
}

function fakeWindow(id: number, kind: WindowContext['kind'], urls: string[]): WindowContext & { tabsEmitter: EventEmitter; created: unknown[] } {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    isFullScreen: () => false,
    isMaximized: () => false,
    getTitle: () => `Window ${id}`,
    getNormalBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    focus: () => undefined,
  })
  const tabs: FakeTab[] = urls.map((url, i) => ({ id: `${id}-${i}`, pinned: false, internalUrl: null, view: { webContents: { isDestroyed: () => true } } }))
  const info = (t: FakeTab) => ({ id: t.id, url: urls[Number(t.id.split('-')[1])] ?? '', title: 'T', pinned: t.pinned, groupId: null })
  const created: unknown[] = []
  const tabsEmitter = Object.assign(new EventEmitter(), {
    all: () => tabs,
    info,
    activeId: () => tabs[0]?.id ?? null,
    split: () => null,
    snapshot: () => ({ groups: [] }),
    serialize: () => tabs.map((t) => ({ url: info(t).url, title: 'T', pinned: false, groupId: null, entries: [{ url: info(t).url, title: 'T' }], index: 0 })),
    create: (url: string, opts: unknown) => void created.push({ url, opts }),
  })
  return {
    id,
    kind,
    window: window as never,
    chrome: { isDestroyed: () => false, send: () => undefined } as never,
    tabs: tabsEmitter as never,
    peek: {} as never,
    overlay: { ownsWebContents: () => false, relay: () => undefined } as never,
    chromeWindow: { state: () => ({ sidebarOpen: true, name: null }) } as never,
    session: {} as never,
    send: () => undefined,
    tabsEmitter,
    created,
  }
}

describe('the window manager', () => {
  it('saves normal windows only, never private ones', () => {
    const wm = new WindowManager()
    wm.add(fakeWindow(1, 'normal', ['https://a.test/', 'https://b.test/']))
    wm.add(fakeWindow(2, 'private', ['https://secret.test/']))
    wm.add(fakeWindow(3, 'chat', ['https://c.test/']))
    const saved = wm.serialize()
    expect(saved.version).toBe(1)
    expect(saved.windows).toHaveLength(1)
    expect(saved.windows[0]?.tabs.map((t) => t.url)).toEqual(['https://a.test/', 'https://b.test/'])
    expect(wm.serializeWindow(wm.get(2)!)).toBeNull()
  })

  it('remembers closed tabs of normal windows, not private ones, and reopens with history', () => {
    const wm = new WindowManager()
    const normal = fakeWindow(1, 'normal', ['https://a.test/', 'https://b.test/'])
    const priv = fakeWindow(2, 'private', ['https://secret.test/'])
    wm.add(normal)
    wm.add(priv)
    const [, second] = normal.tabs.all() as unknown as FakeTab[]
    normal.tabsEmitter.emit('closed', second)
    priv.tabsEmitter.emit('closed', (priv.tabs.all() as unknown as FakeTab[])[0])
    normal.tabsEmitter.emit('closed', second, { moved: true })
    expect(wm.recentlyClosed().map((e) => (e.kind === 'tab' ? e.url : e.kind))).toEqual(['https://b.test/'])
    expect(wm.reopen()).toBe(true)
    const reopened = (wm.focused() as ReturnType<typeof fakeWindow>).created[0] as { url: string; opts: { index: number; history: { entries: unknown[] } } }
    expect(reopened.url).toBe('https://b.test/')
    expect(reopened.opts.index).toBe(1)
    expect(reopened.opts.history.entries).toHaveLength(1)
  })

  it('holds a close behind the guard until closeNow', () => {
    const wm = new WindowManager()
    const win = fakeWindow(1, 'normal', ['https://a.test/', 'https://b.test/'])
    let closes = 0
    Object.assign(win.window, { close: () => void (closes++, win.window.emit('close', { preventDefault: () => undefined })) })
    wm.add(win)
    let asked = 0
    wm.setCloseGuard(() => (asked++, true))
    const event = { prevented: false, preventDefault() {
      this.prevented = true
    } }
    win.window.emit('close', event)
    expect(event.prevented).toBe(true)
    expect(asked).toBe(1)
    wm.closeNow(1)
    expect(closes).toBe(1)
    expect(asked).toBe(1)
  })
})

describe('the Dock menu (SH-60)', () => {
  it('lists open windows, then New Window and New Private Window', () => {
    const items = dockItems({
      windows: [
        { id: 1, kind: 'normal', title: 'Docs', tabCount: 2, focused: true },
        { id: 2, kind: 'private', title: '', tabCount: 1, focused: false },
        { id: 3, kind: 'popup', title: 'Sign in', tabCount: 0, focused: false },
      ],
    })
    expect(items.map((i) => i.type ?? 'normal')).toEqual(['checkbox', 'checkbox', 'separator', 'normal', 'normal'])
    expect(items[0]?.checked).toBe(true)
    expect(items[1]?.label).toMatch(/Private/)
    expect(items.slice(-2).map((i) => i.commandId)).toEqual(['new-window', 'new-private-window'])
    expect(dockWindowId(items[1]!.id)).toBe(2)
    expect(dockWindowId('core-dock-new-window')).toBeNull()
    expect(dockItems({ windows: [] }).map((i) => i.commandId)).toEqual(['new-window', 'new-private-window'])
  })
})

describe('keep awake (ST-22)', () => {
  it('holds the blocker only while enabled and something works', () => {
    const started = new Set<number>()
    let next = 1
    const k = new KeepAwake({ start: () => (started.add(next), next++), stop: (id) => void started.delete(id), isStarted: (id) => started.has(id) })
    k.update(false, 2)
    expect(k.holding).toBe(false)
    k.update(true, 0)
    expect(k.holding).toBe(false)
    k.update(true, 1)
    k.update(true, 3)
    expect(started.size).toBe(1)
    k.update(true, 0)
    expect(started.size).toBe(0)
    k.update(true, 1)
    k.dispose()
    expect(k.holding).toBe(false)
  })
})
