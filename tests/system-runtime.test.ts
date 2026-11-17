/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRANDING } from '../src/shared/branding'

// The system runtime with Electron faked: what closing the last window does in
// background mode, the Dock, the tray and its menu, the one-time notice,
// second launches, and the login item through the fake backend.

const fx = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const trays: Array<{ menus: unknown[]; destroyed: boolean; tooltip: string }> = []
  return {
    handlers,
    trays,
    app: {
      isPackaged: false,
      on: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
      off: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn)),
      emit: vi.fn(),
      dock: { hide: vi.fn(), show: vi.fn(async () => undefined) },
      focus: vi.fn(),
      quit: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
      setAppUserModelId: vi.fn(),
      setBadgeCount: vi.fn(),
      getPath: () => tmpdir(),
      getAppPath: () => tmpdir(),
    },
    openExternal: vi.fn(async () => undefined),
  }
})

vi.mock('electron', () => {
  class Tray {
    menus: unknown[] = []
    destroyed = false
    tooltip = ''
    constructor() {
      fx.trays.push(this)
    }
    on(): void {}
    destroy(): void {
      this.destroyed = true
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    setContextMenu(menu: unknown): void {
      this.menus.push(menu)
    }
    setToolTip(text: string): void {
      this.tooltip = text
    }
    setImage(): void {}
  }
  return {
    app: fx.app,
    Tray,
    Menu: { buildFromTemplate: (template: unknown) => template },
    nativeImage: { createFromPath: () => ({ setTemplateImage: () => undefined }), createFromDataURL: (url: string) => ({ url }) },
    nativeTheme: { on: () => undefined, off: () => undefined, shouldUseDarkColors: false },
    Notification: class {
      static isSupported(): boolean {
        return false
      }
    },
    shell: { openExternal: fx.openExternal },
    BrowserWindow: class {},
  }
})
vi.mock('../src/main/log', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }))

const { SystemRuntime } = await import('../src/main/system/service')
const { TRAY_IDS } = await import('../src/main/system/tray')
const { FakeLoginItem } = await import('../src/main/system/loginItem')

type Kind = 'normal' | 'private' | 'chat'

function fakeWindow(id: number, kind: Kind = 'normal', visible = true) {
  const state = { visible, destroyed: false }
  return {
    id,
    kind,
    state,
    tabs: { create: vi.fn() },
    chrome: { isDestroyed: () => false, send: vi.fn() },
    window: {
      isDestroyed: () => state.destroyed,
      isVisible: () => state.visible,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(() => {
        state.visible = true
      }),
      focus: vi.fn(),
      isFocused: () => false,
      flashFrame: vi.fn(),
      setOverlayIcon: vi.fn(),
    },
  }
}

type FakeWindow = ReturnType<typeof fakeWindow>

let dataDir = ''

function setup(o: { platform?: 'darwin' | 'win32' | 'linux'; runInBackground?: boolean; windows?: FakeWindow[]; focused?: FakeWindow | null } = {}) {
  const settings = { runInBackground: o.runInBackground ?? false, layout: 'sidebar', profileHue: 'stone', theme: 'system' }
  const wins = o.windows ?? []
  const commands = { has: vi.fn(() => false), run: vi.fn(async () => true) }
  const opened: Array<{ kind: string; url?: string }> = []
  const windows = {
    all: () => wins,
    focused: () => (o.focused === undefined ? (wins[0] ?? null) : o.focused),
    list: () => [],
    recentlyClosed: () => [],
    reopen: () => false,
    open: vi.fn((kind: string, options: { url?: string } = {}) => {
      opened.push({ kind, url: options.url })
      const win = fakeWindow(100 + opened.length)
      wins.push(win)
      return win.id
    }),
  }
  const meetings = { status: () => ({ state: 'idle' }), stop: vi.fn(async () => undefined), on: () => undefined }
  const deps = {
    settings: { get: () => settings, on: () => undefined, off: () => undefined },
    routines: { runningCount: () => 0, nextRunAt: () => null },
    meetings,
    windows,
    attention: { onChange: () => () => undefined },
    commands,
    broadcast: vi.fn(),
    dataDir,
    smoke: true,
  }
  const runtime = new SystemRuntime(deps as never, o.platform ?? 'darwin')
  return { runtime, settings, windows, opened, commands, meetings, deps, wins }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'atelier-system-'))
  fx.trays.length = 0
  fx.handlers.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('closing the last window', () => {
  it('quits without background mode', () => {
    const { runtime } = setup({ runInBackground: false })
    expect(runtime.windowAllClosed()).toBe(false)
    expect(fx.trays).toHaveLength(0)
  })

  it('on macOS in background mode: stays, hides the Dock, shows the tray, and says so once', () => {
    const { runtime } = setup({ runInBackground: true })
    expect(runtime.windowAllClosed()).toBe(true)
    expect(fx.app.dock.hide).toHaveBeenCalledTimes(1)
    expect(runtime.dockHidden).toBe(true)
    expect(runtime.trayShown).toBe(true)
    expect(runtime.record.notices).toBe(1)
    // The notice is one-time, also for a new runtime on the same data.
    expect(runtime.windowAllClosed()).toBe(true)
    expect(runtime.record.notices).toBe(1)
    expect(setup({ runInBackground: true }).runtime.windowAllClosed()).toBe(true)
  })

  it('on Windows in background mode: stays in the tray with the Dock untouched', () => {
    const { runtime } = setup({ platform: 'win32', runInBackground: true })
    expect(runtime.windowAllClosed()).toBe(true)
    expect(fx.app.dock.hide).not.toHaveBeenCalled()
    expect(runtime.trayShown).toBe(true)
  })

  it('after ⌘Q (before-quit) really quits, even in background mode', () => {
    const { runtime } = setup({ runInBackground: true })
    runtime.start()
    for (const fn of fx.handlers.get('before-quit') ?? []) fn({ defaultPrevented: false, preventDefault: () => undefined })
    expect(runtime.windowAllClosed()).toBe(false)
    runtime.stop()
  })

  it('a quit held to ask first (CH-30) is not a quit yet: background mode keeps running', () => {
    const { runtime } = setup({ runInBackground: true })
    runtime.start()
    for (const fn of fx.handlers.get('before-quit') ?? []) fn({ defaultPrevented: true, preventDefault: () => undefined })
    expect(runtime.windowAllClosed()).toBe(true)
    runtime.stop()
  })
})

describe('the tray', () => {
  it('renders the tray contributions as its menu, with a tooltip', () => {
    const { runtime } = setup({ runInBackground: true })
    runtime.syncTray()
    const menu = fx.trays[0]?.menus.at(-1) as Array<{ id?: string }> | undefined
    expect(menu).toBeDefined()
    expect(fx.trays[0]?.tooltip).toBe(BRAND_NAME)
  })

  it('hides when background mode goes off', () => {
    const { runtime, settings } = setup({ runInBackground: true })
    runtime.syncTray()
    settings.runInBackground = false
    runtime.syncTray()
    expect(runtime.trayShown).toBe(false)
    expect(fx.trays[0]?.destroyed).toBe(true)
  })

  it(`Open ${BRAND_NAME} brings the Dock and a window back`, async () => {
    const win = fakeWindow(1, 'normal', false)
    const { runtime } = setup({ runInBackground: true, windows: [win] })
    win.state.visible = false
    runtime.windowAllClosed()
    await runtime.runTrayItem({ id: TRAY_IDS.open })
    expect(fx.app.dock.show).toHaveBeenCalled()
    expect(win.window.show).toHaveBeenCalled()
    expect(win.window.focus).toHaveBeenCalled()
  })

  it(`Open ${BRAND_NAME} with no window left opens a new one`, async () => {
    const { runtime, opened } = setup({ runInBackground: true, windows: [] })
    await runtime.runTrayItem({ id: TRAY_IDS.open })
    expect(opened).toEqual([{ kind: 'normal', url: undefined }])
  })

  it('Quit goes through the quit command when it is registered, else quits', async () => {
    const { runtime, commands } = setup()
    await runtime.runTrayItem({ id: TRAY_IDS.quit, commandId: 'quit' })
    expect(fx.app.quit).toHaveBeenCalledTimes(1)
    commands.has.mockReturnValue(true)
    await runtime.runTrayItem({ id: TRAY_IDS.quit, commandId: 'quit' })
    expect(commands.run).toHaveBeenCalledWith('quit', null)
    expect(fx.app.quit).toHaveBeenCalledTimes(1)
  })

  it('Stop asks the recorder to stop', async () => {
    const { runtime, meetings } = setup()
    await runtime.runTrayItem({ id: TRAY_IDS.stopRecording })
    expect(meetings.stop).toHaveBeenCalled()
  })
})

describe('second launches', () => {
  it('opens links in the front normal window and brings it forward', async () => {
    const front = fakeWindow(1)
    const { runtime } = setup({ windows: [front] })
    runtime.handleLaunch({ urls: ['https://a.example/', 'file:///tmp/b.html'], companionFiles: [], background: false })
    await vi.waitFor(() => expect(front.tabs.create).toHaveBeenCalledTimes(2))
    expect(front.tabs.create).toHaveBeenNthCalledWith(1, 'https://a.example/')
  })

  it('skips a private front window for a normal one', async () => {
    const priv = fakeWindow(1, 'private')
    const normal = fakeWindow(2)
    const { runtime } = setup({ windows: [priv, normal], focused: priv })
    runtime.handleLaunch({ urls: ['https://a.example/'], companionFiles: [], background: false })
    await vi.waitFor(() => expect(normal.tabs.create).toHaveBeenCalledWith('https://a.example/'))
    expect(priv.tabs.create).not.toHaveBeenCalled()
  })

  it('opens a normal window with the first link when only private windows are open', async () => {
    const priv = fakeWindow(1, 'private')
    const { runtime, opened } = setup({ windows: [priv], focused: priv })
    runtime.handleLaunch({ urls: ['https://a.example/', 'https://b.example/'], companionFiles: [], background: false })
    await vi.waitFor(() => expect(opened).toEqual([{ kind: 'normal', url: 'https://a.example/' }]))
    expect(priv.tabs.create).not.toHaveBeenCalled()
  })

  it('sends companion files to the import review', async () => {
    const { runtime } = setup({ windows: [fakeWindow(1)] })
    runtime.handleLaunch({ urls: [], companionFiles: ['/home/me/Ada.ateliercompanion'], background: false })
    await vi.waitFor(() => expect(fx.app.emit).toHaveBeenCalledWith('open-file', expect.anything(), '/home/me/Ada.ateliercompanion'))
  })

  it(`ignores a login launch meeting a running ${BRAND_NAME}`, async () => {
    const win = fakeWindow(1)
    const { runtime } = setup({ windows: [win] })
    runtime.handleLaunch({ urls: [], companionFiles: [], background: true })
    await Promise.resolve()
    expect(win.window.show).not.toHaveBeenCalled()
  })
})

describe('the login item', () => {
  it('reads and writes through the fake in smoke, and broadcasts changes', () => {
    const { runtime, deps } = setup()
    expect(runtime.backend()).toBeInstanceOf(FakeLoginItem)
    expect(runtime.loginItem().status).toBe('disabled')
    expect(runtime.setOpenAtLogin(true)).toEqual({ supported: true, openAtLogin: true, status: 'enabled' })
    expect(deps.broadcast).toHaveBeenCalledWith({ type: 'login-item', state: { supported: true, openAtLogin: true, status: 'enabled' } })
  })

  it('opens Login Items on macOS (recorded in smoke), and refuses on Linux', () => {
    expect(() => setup({ platform: 'linux' }).runtime.openLoginItemsSettings()).toThrow()
    const { runtime } = setup()
    runtime.openLoginItemsSettings()
    expect(runtime.record.opened).toEqual(['x-apple.systempreferences:com.apple.LoginItems-Settings.extension'])
    expect(fx.openExternal).not.toHaveBeenCalled()
  })

  it('starts without a window only for a login launch in background mode', () => {
    const { runtime } = setup({ runInBackground: true })
    expect(runtime.startHidden()).toBe(false)
    vi.spyOn(runtime.backend(), 'openedAtLogin').mockReturnValue(true)
    expect(runtime.startHidden()).toBe(true)
    expect(runtime.trayShown).toBe(true)
    // No "still running" notice for a start that never showed a window.
    expect(runtime.record.notices).toBe(0)
  })
})

describe('Windows start-up', () => {
  it('sets the AppUserModelId', () => {
    const { runtime } = setup({ platform: 'win32' })
    runtime.start()
    expect(fx.app.setAppUserModelId).toHaveBeenCalledWith(BRANDING.bundleId)
    runtime.stop()
  })
})
