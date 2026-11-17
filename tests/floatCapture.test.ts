/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Linux has no content protection (FloatManager.keepOutOf): the floats Apex
// shows hide for its own screen captures and come back after, and one about
// to show waits for the capture.

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', { value: 'linux' })

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
let nextId = 1

class FakeWindow extends EventEmitter {
  visible = false
  destroyed = false
  readonly webContents = Object.assign(new EventEmitter(), { id: nextId++, mainFrame: {}, send: vi.fn(), focus: vi.fn(), setWindowOpenHandler: vi.fn() })
  constructor() {
    super()
    windows.push(this)
  }
  isVisible(): boolean {
    return this.visible
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  show(): void {
    this.visible = true
  }
  showInactive(): void {
    this.visible = true
  }
  hide(): void {
    this.visible = false
  }
  destroy(): void {
    this.destroyed = true
  }
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  setContentProtection(): void {}
  setBounds(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 100, height: 100 }
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
}
const windows: FakeWindow[] = []

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => windows }),
  ipcMain: { handle: vi.fn(), on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => handlers.set(channel, fn) },
  screen: {
    on: vi.fn(),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
    getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }],
  },
}))

const { CONTENT_PROTECTION, FloatManager } = await import('../src/main/float/manager')

afterAll(() => {
  if (platform) Object.defineProperty(process, 'platform', platform)
})

function manager(): InstanceType<typeof FloatManager> {
  const m = new FloatManager({
    preload: '',
    url: () => 'app://apex/float.html',
    theme: () => ({}) as never,
    companion: () => null,
    reduceMotion: () => false,
    language: () => ({}) as never,
    apexWindow: () => null,
    callService: async () => null,
    smoke: true,
  })
  m.start()
  return m
}

/** The float page says it is ready, as its preload does. */
function ready(win: FakeWindow): void {
  handlers.get('float:ready')?.({ sender: win.webContents, senderFrame: win.webContents.mainFrame, returnValue: null })
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('floats and Apex’s own screen captures without content protection', () => {
  it('knows Linux has none', () => {
    expect(CONTENT_PROTECTION).toBe(false)
  })

  it('hides the shown floats for the capture and shows them again after', async () => {
    const m = manager()
    m.open('voice-hud', { state: 'listening' })
    const hud = m.window('voice-hud') as unknown as FakeWindow
    ready(hud)
    await tick()
    expect(hud.visible).toBe(true)
    const seen = await m.keepOutOf(async () => hud.visible)
    expect(seen).toBe(false)
    expect(hud.visible).toBe(true)
  })

  it('lets a float that opens during the capture show only once it is done, and leaves a closed one closed', async () => {
    const m = manager()
    m.open('voice-hud', { state: 'listening' })
    const hud = m.window('voice-hud') as unknown as FakeWindow
    ready(hud)
    await tick()
    let release = (): void => undefined
    const capture = m.keepOutOf(() => new Promise<void>((resolve) => (release = resolve)))
    await tick(150)
    m.open('launcher', {})
    const launcher = m.window('launcher') as unknown as FakeWindow
    ready(launcher)
    await tick()
    expect(launcher.visible).toBe(false)
    m.close('voice-hud')
    release()
    await capture
    expect(launcher.visible).toBe(true)
    expect(hud.visible).toBe(false)
  })
})
