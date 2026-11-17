/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// OV-15's device grants (main/devices.ts): one made without "remember" lasts
// while one of the site's tabs is open, Reset and a block end it, and the
// agent never gets a device, not even through the getDevices() check.

const h = vi.hoisted(() => ({ answer: null as unknown }))

vi.mock('electron', () => ({ webContents: { fromFrame: (frame: { wc: unknown }) => frame.wc } }))
vi.mock('../src/main/siteOverlay', () => ({
  presentSurface: async () => h.answer,
  paneAnchor: () => ({}),
  resultValue: (r: unknown) => r,
  windowOfTab: () => ({}),
}))

import { DeviceChooser } from '../src/main/devices'
import { sites } from '../src/main/sites'

type Handler = (...args: unknown[]) => unknown
interface FakeTab {
  id: string
  agentControlled: boolean
  requestedUrl: string
  view: { webContents: { id: number; session: unknown; isDestroyed(): boolean; getURL(): string } }
}

const ORIGIN = 'https://keys.example'
const KEYBOARD = { deviceId: 'hid-1', vendorId: 0x46d, productId: 0xc31c, name: 'Keyboard', serialNumber: 'S1' } as unknown as Electron.HIDDevice

let dir: string
let session: { handlers: Map<string, Handler>; check: ((d: unknown) => boolean) | null }
let tabs: FakeTab[]
let chooser: DeviceChooser

function tab(id: string, url: string, sess: unknown = session): FakeTab {
  return { id, agentControlled: false, requestedUrl: url, view: { webContents: { id: tabs.length + 1, session: sess, isDestroyed: () => false, getURL: () => url } } }
}

/** Runs the chooser for a tab and picks the keyboard. */
async function choose(t: FakeTab, remember: boolean): Promise<string | null> {
  h.answer = { deviceId: KEYBOARD.deviceId, remember }
  let picked: string | null | undefined
  session.handlers.get('select-hid-device')!({ preventDefault() {} }, { frame: { wc: t.view.webContents }, deviceList: [KEYBOARD] }, (id: string | undefined) => {
    picked = id ?? null
  })
  await new Promise((r) => setTimeout(r, 0))
  return picked ?? null
}

const allowed = (origin = ORIGIN): boolean => session.check!({ deviceType: 'hid', origin, device: KEYBOARD })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apex-devices-'))
  tabs = []
  session = { handlers: new Map(), check: null }
  Object.assign(session, {
    on: (name: string, fn: Handler) => session.handlers.set(name, fn),
    setDevicePermissionHandler: (fn: (d: unknown) => boolean) => (session.check = fn),
    setBluetoothPairingHandler: () => undefined,
  })
  sites.attach(session as unknown as Electron.Session, { private: false, dataDir: dir })
  chooser = new DeviceChooser(
    {
      windows: {} as never,
      tabsRegistry: { all: () => tabs, byWebContents: (id: number) => tabs.find((t) => t.view.webContents.id === id) } as never,
      broadcast: () => undefined,
      noteForAgent: () => undefined,
      isPrivate: () => false,
    },
    'Unnamed device',
  )
  chooser.install(session as unknown as Electron.Session)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('device grants without "remember"', () => {
  it('last while one of the site’s tabs is open, and show in site info until then', async () => {
    const first = tab('t1', `${ORIGIN}/a`)
    const second = tab('t2', `${ORIGIN}/b`)
    tabs.push(first, second)
    expect(await choose(first, false)).toBe(KEYBOARD.deviceId)
    expect(allowed()).toBe(true)
    expect(chooser.sessionDevices(session as unknown as Electron.Session, ORIGIN)).toEqual([{ kind: 'hid', id: `${0x46d}:${0xc31c}:S1`, name: 'Keyboard' }])
    tabs.splice(0, 1)
    chooser.tabClosed('t1', session as unknown as Electron.Session)
    expect(allowed()).toBe(true)
    tabs.splice(0, 1)
    chooser.tabClosed('t2', session as unknown as Electron.Session)
    expect(allowed()).toBe(false)
    expect(chooser.sessionDevices(session as unknown as Electron.Session, ORIGIN)).toEqual([])
  })

  it('end with Reset, with a block on the kind, and with Revoke', async () => {
    const t = tab('t1', ORIGIN)
    tabs.push(t)
    const s = session as unknown as Electron.Session
    await choose(t, false)
    chooser.revokeSite(s, ORIGIN)
    expect(allowed()).toBe(false)
    await choose(t, false)
    chooser.revokeSite(s, ORIGIN, ['usb'])
    expect(allowed()).toBe(true)
    sites.storeFor(s)!.set(ORIGIN, { permissions: { hid: 'block' } })
    expect(allowed()).toBe(false)
    sites.storeFor(s)!.set(ORIGIN, { permissions: { hid: 'ask' } })
    expect(allowed()).toBe(true)
    chooser.revoke(s, ORIGIN, { kind: 'hid', id: `${0x46d}:${0xc31c}:S1` })
    expect(allowed()).toBe(false)
  })
})

describe('remembered devices', () => {
  it('survive the tab closing, and Revoke removes them from the site too', async () => {
    const t = tab('t1', ORIGIN)
    tabs.push(t)
    const s = session as unknown as Electron.Session
    await choose(t, true)
    tabs.length = 0
    chooser.tabClosed('t1', s)
    expect(allowed()).toBe(true)
    chooser.revoke(s, ORIGIN, { kind: 'hid', id: `${0x46d}:${0xc31c}:S1` })
    expect(sites.storeFor(s)!.get(ORIGIN).devices).toEqual([])
    expect(allowed()).toBe(false)
  })
})

describe('the agent', () => {
  it('gets no device: neither the chooser nor the check behind getDevices()', async () => {
    const person = tab('t1', ORIGIN)
    tabs.push(person)
    await choose(person, true)
    expect(allowed()).toBe(true)
    const agent = tab('t2', `${ORIGIN}/agent`)
    agent.agentControlled = true
    tabs.push(agent)
    expect(allowed()).toBe(false)
    expect(await choose(agent, false)).toBeNull()
    // Another site, or the same site in another profile's session, is unaffected.
    tabs[1] = tab('t2', ORIGIN, {})
    tabs[1].agentControlled = true
    expect(allowed()).toBe(true)
  })
})
