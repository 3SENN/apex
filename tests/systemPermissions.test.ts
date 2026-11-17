/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The main service is built from fakes here; Electron itself is never reached.
vi.mock('electron', () => {
  const noop: unknown = new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : noop), apply: () => noop, construct: () => noop as object })
  return new Proxy({}, { get: (_t, key) => (key === 'then' || key === '__esModule' ? undefined : noop), has: () => true })
})

import type { CalendarStatus } from '@shared/calendar'
import type { SiteSettingsEntry } from '@shared/sites'
import { DEFAULT_SITE_SETTINGS } from '@shared/sites'
import type { SpeechBroker, SpeechPermissions } from '@shared/speech'
import { SYSTEM_PERMISSIONS, SYSTEM_PRIVACY_PANES, systemPermissionRow, systemPermissionRows, type SystemPermissionsReport, type SystemRowInput } from '@shared/systemPermissions'
import { resolveSettingsSection } from '../src/renderer/src/settings/logic/nav'
import { defaultFor, permissionsUrl, sitesFor, systemRowNote, withDefault } from '../src/renderer/src/settings/logic/permissions'
import { createSystemPermissions, fullDiskAccess, SYSTEM_PERMISSIONS_SCHEMAS, type SystemPermissionsDeps } from '../src/main/systemPermissions'
import { SERVICE_SCHEMAS } from '../src/main/services'

const REPORT: SystemPermissionsReport = {
  supported: true,
  microphone: 'granted',
  camera: 'not-determined',
  speech: 'denied',
  screen: { app: 'denied', helper: 'denied' },
  location: null,
  notifications: 'unknown',
  fullDisk: 'denied',
}

const CALENDAR: CalendarStatus = { available: true, events: 'not-determined', reminders: 'restricted', enabled: { events: false, reminders: false } }

const input = (over: Partial<SystemRowInput> = {}, report: Partial<SystemPermissionsReport> = {}): SystemRowInput => ({ report: { ...REPORT, ...report }, calendar: CALENDAR, screenAsked: false, ...over })

describe('this Mac’s permission rows: status → action', () => {
  it('asks only what macOS never asked, links what is off, and does nothing for what is on', () => {
    const rows = Object.fromEntries(systemPermissionRows(input()).map((r) => [r.kind, r]))
    expect(Object.keys(rows)).toEqual([...SYSTEM_PERMISSIONS])
    expect(rows.microphone).toMatchObject({ state: 'granted', action: 'none' })
    expect(rows.camera).toMatchObject({ state: 'not-determined', action: 'allow' })
    expect(rows.speech).toMatchObject({ state: 'denied', action: 'open-settings' })
    expect(rows.calendars).toMatchObject({ state: 'not-determined', action: 'allow' })
    // Restricted (a managed Mac) can't be changed from System Settings.
    expect(rows.reminders).toMatchObject({ state: 'restricted', action: 'none' })
    expect(rows['full-disk']).toMatchObject({ state: 'denied', action: 'open-settings' })
  })

  it('never shows a permission macOS never asked about as denied', () => {
    for (const kind of SYSTEM_PERMISSIONS) {
      const row = systemPermissionRow(kind, input({ calendar: { ...CALENDAR, events: 'not-determined', reminders: 'not-determined' } }, { microphone: 'not-determined', camera: 'not-determined', speech: 'not-determined', location: 'not-determined' }))
      if (kind !== 'notifications' && kind !== 'full-disk') expect(row.state, kind).not.toBe('denied')
    }
  })

  it('Screen Recording: Allow until Apex asked, then System Settings, and Relaunch for a grant Apex sees only after restarting', () => {
    expect(systemPermissionRow('screen', input())).toMatchObject({ state: 'not-determined', action: 'allow' })
    expect(systemPermissionRow('screen', input({ screenAsked: true }))).toMatchObject({ state: 'denied', action: 'open-settings' })
    expect(systemPermissionRow('screen', input({}, { screen: { app: 'denied', helper: 'granted' } }))).toMatchObject({ state: 'relaunch', action: 'relaunch' })
    expect(systemPermissionRow('screen', input({}, { screen: { app: 'granted', helper: null } }))).toMatchObject({ state: 'granted', action: 'none' })
  })

  it('Screen Recording follows main’s own answer when it has one', () => {
    expect(systemPermissionRow('screen', input({ screenAccess: 'relaunch', screenAsked: false }))).toMatchObject({ state: 'relaunch', action: 'relaunch' })
    expect(systemPermissionRow('screen', input({ screenAccess: 'not-determined', screenAsked: true }))).toMatchObject({ state: 'not-determined', action: 'allow' })
    expect(systemPermissionRow('screen', input({ screenAccess: 'denied' }))).toMatchObject({ state: 'denied', action: 'open-settings' })
    expect(systemPermissionRow('screen', input({ screenAccess: 'granted' }, { screen: { app: 'denied', helper: 'denied' } }))).toMatchObject({ state: 'granted', action: 'none' })
    expect(systemPermissionRow('screen', input({ screenAccess: 'unsupported' }))).toMatchObject({ state: 'unavailable', action: 'none' })
  })

  it('Location: managed by macOS without a report (link only), and never asked from Settings', () => {
    expect(systemPermissionRow('location', input())).toMatchObject({ state: 'managed', action: 'open-settings' })
    expect(systemPermissionRow('location', input({}, { location: 'not-determined' }))).toMatchObject({ state: 'not-determined', action: 'none' })
    expect(systemPermissionRow('location', input({}, { location: 'denied' }))).toMatchObject({ state: 'denied', action: 'open-settings' })
  })

  it('Notifications can’t be read: unknown with a link, unless Apex saw them fail', () => {
    expect(systemPermissionRow('notifications', input())).toMatchObject({ state: 'unknown', action: 'open-settings' })
    expect(systemPermissionRow('notifications', input({}, { notifications: 'denied' }))).toMatchObject({ state: 'denied', action: 'open-settings' })
  })

  it('without the speech or calendar helper, those rows say so and offer nothing', () => {
    expect(systemPermissionRow('speech', input({}, { speech: null }))).toMatchObject({ state: 'unavailable', action: 'none' })
    expect(systemPermissionRow('calendars', input({ calendar: null }))).toMatchObject({ state: 'unavailable', action: 'none' })
    expect(systemPermissionRow('reminders', input({ calendar: { ...CALENDAR, available: false } }))).toMatchObject({ state: 'unavailable', action: 'none' })
  })

  it('each row’s note says what happens next', () => {
    const rows = systemPermissionRows(input())
    const note = (kind: string, opened = false) => systemRowNote(rows.find((r) => r.kind === kind)!, opened)
    expect(note('microphone')).toBeNull()
    expect(note('camera')).toBe('permissionsHub.note.notDetermined')
    expect(note('speech')).toBe('permissionsHub.note.denied')
    expect(note('speech', true)).toBe('permissionsHub.note.waiting')
    expect(note('notifications')).toBe('permissionsHub.note.notificationsUnknown')
    expect(note('location')).toBe('permissionsHub.note.managed')
    expect(systemRowNote({ kind: 'location', state: 'not-determined', action: 'none' }, false)).toBe('permissionsHub.note.locationAsk')
    expect(systemRowNote({ kind: 'full-disk', state: 'granted', action: 'none' }, false)).toBe('permissionsHub.note.fullDiskGranted')
    expect(systemRowNote({ kind: 'screen', state: 'relaunch', action: 'relaunch' }, true)).toBe('permissionsHub.note.relaunch')
  })

  it('links every permission to its own System Settings pane', () => {
    for (const kind of SYSTEM_PERMISSIONS) expect(SYSTEM_PRIVACY_PANES[kind], kind).toMatch(/^x-apple\.systempreferences:/)
    expect(SYSTEM_PRIVACY_PANES.location).toContain('Privacy_LocationServices')
    expect(SYSTEM_PRIVACY_PANES['full-disk']).toContain('Privacy_AllFiles')
  })
})

describe('website permissions by kind', () => {
  const entry = (origin: string, settings: Partial<SiteSettingsEntry['settings']>): SiteSettingsEntry => ({ origin, settings: { ...structuredClone(DEFAULT_SITE_SETTINGS), ...settings }, overrides: 1 })
  const entries = [
    entry('https://zoom.us', { permissions: { camera: 'allow', microphone: 'allow' } }),
    entry('https://ads.example', { permissions: { camera: 'block', notifications: 'block' } }),
    entry('https://board.example', { devices: [{ kind: 'usb', id: '1', name: 'Arduino' }] }),
  ]

  it('lists the websites with their own answer, by host, with counts', () => {
    const camera = sitesFor(entries, 'camera')
    expect(camera.sites.map((s) => [s.host, s.decision])).toEqual([
      ['ads.example', 'block'],
      ['zoom.us', 'allow'],
    ])
    expect([camera.allowed, camera.blocked, camera.devices.length]).toEqual([1, 1, 0])
    expect(sitesFor(entries, 'location').sites).toEqual([])
    const usb = sitesFor(entries, 'usb')
    expect(usb.devices.map((d) => [d.host, d.device.name])).toEqual([['board.example', 'Arduino']])
  })

  it('a default missing from the setting asks, and Ask removes it again', () => {
    expect(defaultFor(undefined, 'camera')).toBe('ask')
    expect(defaultFor({ camera: 'block' }, 'camera')).toBe('block')
    const blocked = withDefault({}, 'notifications', 'block')
    expect(blocked).toEqual({ notifications: 'block' })
    expect(withDefault(blocked, 'notifications', 'ask')).toEqual({})
    expect(withDefault(undefined, 'midi', 'block')).toEqual({ midi: 'block' })
  })

  it('lives under Privacy at apex://settings/access, and other pages link to a row there', () => {
    expect(resolveSettingsSection('access')).toMatchObject({ page: 'privacy', view: 'access', redirect: null })
    expect(permissionsUrl()).toBe('apex://settings/access')
    expect(permissionsUrl('mac-microphone')).toBe('apex://settings/access?highlight=mac-microphone')
  })
})

describe('the systemPermissions service', () => {
  const helper = (p: Partial<SpeechPermissions> = {}, available = true) => {
    const calls: string[] = []
    const broker = {
      status: () => ({ available, reason: null, active: null }),
      permissions: async () => ({ microphone: 'granted', speech: 'not-determined', screen: 'granted', ...p }) as SpeechPermissions,
      request: async (kind: string) => {
        calls.push(kind)
        return { microphone: 'granted', speech: 'granted', screen: 'granted', ...p } as SpeechPermissions
      },
    } as unknown as SpeechBroker
    return { broker, calls }
  }
  const deps = (over: Partial<SystemPermissionsDeps> = {}): SystemPermissionsDeps & { opened: string[]; asked: string[] } => {
    const opened: string[] = []
    const asked: string[] = []
    return {
      platform: 'darwin',
      mediaStatus: (kind) => (kind === 'camera' ? 'not-determined' : kind === 'screen' ? 'denied' : 'granted'),
      askForMedia: async (kind) => {
        asked.push(kind)
        return true
      },
      askForScreen: async () => void asked.push('screen-capture'),
      broker: () => helper().broker,
      fullDisk: () => 'denied',
      notifications: () => 'unknown',
      openExternal: (url) => void opened.push(url),
      opened,
      asked,
      ...over,
    }
  }

  it('reads everything without prompting', async () => {
    const d = deps()
    const report = await createSystemPermissions(d).status()
    expect(report).toEqual({
      supported: true,
      microphone: 'granted',
      camera: 'not-determined',
      speech: 'not-determined',
      screen: { app: 'denied', helper: 'granted' },
      location: null,
      notifications: 'unknown',
      fullDisk: 'denied',
    })
    expect(d.asked).toEqual([])
  })

  it('passes the helper’s Location answer through', async () => {
    const { broker } = helper({ location: 'denied' })
    expect((await createSystemPermissions(deps({ broker: () => broker })).status()).location).toBe('denied')
  })

  it('without the helper (missing, unavailable or failing) speech and location are unknown, not an error', async () => {
    for (const broker of [null, helper({}, false).broker, { status: () => { throw new Error('Not available yet') } } as unknown as SpeechBroker]) {
      const report = await createSystemPermissions(deps({ broker: () => broker })).status()
      expect(report.speech).toBeNull()
      expect(report.screen.helper).toBeNull()
      expect(report.location).toBeNull()
    }
    const failing = { status: () => ({ available: true }), permissions: async () => Promise.reject(new Error('timeout')) } as unknown as SpeechBroker
    expect((await createSystemPermissions(deps({ broker: () => failing })).status()).speech).toBeNull()
  })

  it('asks camera and microphone through Electron, speech and screen through the helper', async () => {
    const h = helper()
    const d = deps({ broker: () => h.broker })
    const service = createSystemPermissions(d)
    await service.request('camera')
    await service.request('microphone')
    await service.request('speech')
    await service.request('screen')
    expect(d.asked).toEqual(['camera', 'microphone'])
    expect(h.calls).toEqual(['speech', 'screen'])
  })

  it('without the helper, Screen Recording is asked by a capture, and a failed ask still reports', async () => {
    const d = deps({ broker: () => null, askForMedia: async () => Promise.reject(new Error('no')) })
    const service = createSystemPermissions(d)
    await service.request('screen')
    expect(d.asked).toEqual(['screen-capture'])
    await expect(service.request('camera')).resolves.toMatchObject({ supported: true })
  })

  it('opens each pane on macOS, and nothing elsewhere', async () => {
    const d = deps()
    createSystemPermissions(d).openSettings('location')
    expect(d.opened).toEqual([SYSTEM_PRIVACY_PANES.location])
    const win = deps({ platform: 'win32' })
    const service = createSystemPermissions(win)
    service.openSettings('camera')
    expect(win.opened).toEqual([])
    expect((await service.status()).supported).toBe(false)
    await service.request('camera')
    expect(win.asked).toEqual([])
  })

  it('reads Full Disk Access from Safari’s folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'apex-fda-'))
    expect(fullDiskAccess(home)).toBe('unknown')
    mkdirSync(join(home, 'Library', 'Safari'), { recursive: true })
    expect(fullDiskAccess(home)).toBe('granted')
  })

  it('has argument schemas spread into the service table', () => {
    expect(SERVICE_SCHEMAS.systemPermissions).toBe(SYSTEM_PERMISSIONS_SCHEMAS.systemPermissions)
    expect(SERVICE_SCHEMAS.systemPermissions.request.safeParse(['camera']).success).toBe(true)
    expect(SERVICE_SCHEMAS.systemPermissions.request.safeParse(['location']).success).toBe(false)
    expect(SERVICE_SCHEMAS.systemPermissions.openSettings.safeParse(['full-disk']).success).toBe(true)
    expect(SERVICE_SCHEMAS.systemPermissions.openSettings.safeParse(['keychain']).success).toBe(false)
  })
})
