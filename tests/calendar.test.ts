/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, safeStorage: { isEncryptionAvailable: () => false } }))

import { MEETING_SOON_MS, calendarReadable, type CalendarEvent, type CalendarStatus } from '../src/shared/calendar'
import type { CalendarSource } from '../src/shared/meetingCapture'
import { CalendarService, calendarHelperPath, meetingUrl, parseHelperOutput, soonEvents, type CalendarDeps } from '../src/main/calendar'
import { registerCalendarTools } from '../src/main/apps/calendarTools'
import { clientTool, resetClientToolsForTests, type ClientToolContext, type ToolSetup } from '../src/main/agent/tools/registry'

// MV-09, ST-20: the Calendar and Reminders helper's
// main side, run against the fake helper in tests/fixtures/calendar.

const FAKE = resolve('tests/fixtures/calendar/fake-helper.mjs')
const ENV_KEYS = ['APEX_FAKE_CALENDAR_EVENTS', 'APEX_FAKE_CALENDAR_REMINDERS', 'APEX_FAKE_CALENDAR_GRANT', 'APEX_FAKE_CALENDAR_FAIL'] as const

let dir: string
let sources: Array<CalendarSource | null>
let broadcasts: CalendarStatus[]
let opened: string[]
const services: CalendarService[] = []

function make(over: Partial<CalendarDeps> = {}): CalendarService {
  const service = new CalendarService({
    dataDir: dir,
    helper: () => FAKE,
    broadcast: (e) => broadcasts.push(e.status),
    openExternal: (url) => opened.push(url),
    setSource: (s) => sources.push(s),
    ...over,
  })
  services.push(service)
  return service
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apex-calendar-'))
  sources = []
  broadcasts = []
  opened = []
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const s of services.splice(0)) s.dispose()
  rmSync(dir, { recursive: true, force: true })
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('the helper protocol', () => {
  it('keeps valid lines and drops junk or lines that break the protocol', () => {
    const lines = parseHelperOutput(['{"type":"status","events":"granted","reminders":"denied"}', 'not json', '{"type":"event","id":""}', '{"type":"mystery"}', '', '{"type":"end"}'].join('\n'))
    expect(lines).toEqual([{ type: 'status', events: 'granted', reminders: 'denied' }, { type: 'end' }])
  })

  it('finds meeting links in the url, location or title', () => {
    expect(meetingUrl(null, 'Room 4, https://acme.zoom.us/j/99?pwd=x', null)).toBe('https://acme.zoom.us/j/99?pwd=x')
    expect(meetingUrl('https://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij')
    expect(meetingUrl('https://example.com/agenda', 'Office', 'Sync')).toBeNull()
  })

  it('finds the helper: an override, then the packaged or dev build, never off macOS', () => {
    expect(calendarHelperPath({ packaged: false, resourcesPath: '/r', appPath: '/a', env: { APEX_CALENDAR_HELPER: FAKE } })).toBe(FAKE)
    expect(calendarHelperPath({ packaged: false, resourcesPath: '/r', appPath: '/a', env: { APEX_CALENDAR_HELPER: '/missing/helper' } })).toBeNull()
    expect(calendarHelperPath({ packaged: true, resourcesPath: '/r', appPath: '/a', platform: 'linux', env: {} })).toBeNull()
    expect(calendarHelperPath({ packaged: true, resourcesPath: '/nowhere', appPath: '/a', platform: 'darwin', env: {} })).toBeNull()
  })

  it('never points a packaged (fused) app at a script helper unless smoke lends it a Node', () => {
    // Launching the fused binary on a script starts a whole second Apex instead of running it.
    expect(calendarHelperPath({ packaged: true, resourcesPath: '/r', appPath: '/a', env: { APEX_CALENDAR_HELPER: FAKE } })).toBeNull()
    expect(calendarHelperPath({ packaged: true, resourcesPath: '/r', appPath: '/a', env: { APEX_CALENDAR_HELPER: FAKE, APEX_SMOKE: '1' } })).toBeNull()
    expect(calendarHelperPath({ packaged: true, resourcesPath: '/r', appPath: '/a', env: { APEX_CALENDAR_HELPER: FAKE, APEX_SMOKE: '1', APEX_SMOKE_NODE: '/usr/bin/node' } })).toBe(FAKE)
  })
})

describe('CalendarService', () => {
  it('is unavailable without a helper, and says so', async () => {
    const service = make({ helper: () => null })
    const status = await service.status()
    expect(status).toEqual({ available: false, events: 'not-determined', reminders: 'not-determined', enabled: { events: false, reminders: false } })
    await expect(service.requestAccess('events')).rejects.toThrow(/not part of this build/)
    expect(await service.upcoming({ from: 0, to: 1000 })).toEqual([])
    expect(sources.at(-1)).toBeNull()
  })

  it('reads nothing until the switch is on, even with permission', async () => {
    const service = make()
    const status = await service.status()
    expect(status).toMatchObject({ available: true, events: 'granted', reminders: 'granted', enabled: { events: false, reminders: false } })
    expect(calendarReadable(status, 'events')).toBe(false)
    expect(await service.upcoming({ from: Date.now(), to: Date.now() + 86_400_000 })).toEqual([])
    expect(await service.reminders()).toEqual([])
    expect(sources.at(-1)).toBeNull()
  })

  it('reads events once on, sorted, with meeting links, and becomes the meetings’ CalendarSource', async () => {
    const service = make()
    const status = await service.setEnabled('events', true)
    expect(status.enabled.events).toBe(true)
    expect(broadcasts.at(-1)).toEqual(status)
    expect(sources.at(-1)).toBe(service)
    const now = Date.now()
    const events = await service.upcoming({ from: now - 60_000, to: now + 2 * 86_400_000 })
    expect(events.map((e) => e.id)).toEqual(['evt-holiday', 'evt-standup', 'evt-lunch', 'evt-review'].filter((id) => events.some((e) => e.id === id)))
    const standup = events.find((e) => e.id === 'evt-standup')!
    expect(standup).toMatchObject({ title: 'Team stand-up', calendar: 'Work', allDay: false, url: 'https://example.zoom.us/j/123456789?pwd=abc' })
    expect(events.find((e) => e.id === 'evt-holiday')).toMatchObject({ title: 'Untitled event', allDay: true })
    // The CalendarSource shape: a window from now.
    const soon = await (service as CalendarSource).upcoming(5 * 60_000)
    expect(soon.map((e) => e.id)).toContain('evt-standup')
    expect(soon.map((e) => e.id)).not.toContain('evt-review')
    // The switch is remembered.
    expect((await make().status()).enabled.events).toBe(true)
  })

  it('refuses ranges that end first or span more than two months', async () => {
    const service = make()
    await service.setEnabled('events', true)
    await expect(service.upcoming({ from: 10, to: 5 })).rejects.toThrow(/ends before/)
    await expect(service.upcoming({ from: 0, to: 70 * 86_400_000 })).rejects.toThrow(/two months/)
  })

  it('reads reminders when on, undated last', async () => {
    const service = make()
    await service.setEnabled('reminders', true)
    const reminders = await service.reminders()
    expect(reminders.map((r) => r.id)).toEqual(['rem-3', 'rem-1', 'rem-2'])
    expect(reminders[2]).toMatchObject({ dueAt: null, list: 'Home', completed: false })
  })

  it('switches a kind on when macOS grants the request, and not when it denies', async () => {
    process.env.APEX_FAKE_CALENDAR_EVENTS = 'not-determined'
    process.env.APEX_FAKE_CALENDAR_REMINDERS = 'not-determined'
    const service = make()
    const denied = await service.requestAccess('reminders')
    expect(denied).toMatchObject({ reminders: 'denied', enabled: { reminders: false } })
    process.env.APEX_FAKE_CALENDAR_GRANT = '1'
    const granted = await service.requestAccess('events')
    expect(granted).toMatchObject({ events: 'granted', enabled: { events: true } })
  })

  it('keeps the last known permissions when the helper fails, and opens the right Privacy pane', async () => {
    process.env.APEX_FAKE_CALENDAR_FAIL = '1'
    const service = make()
    expect((await service.status()).events).toBe('not-determined')
    service.openPrivacySettings('reminders')
    expect(opened).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders'])
  })

  it('announces a meeting about to start once (meeting-soon)', async () => {
    const service = make()
    const heard: CalendarEvent[] = []
    service.on('meeting-soon', (e) => heard.push(e))
    await service.setEnabled('events', true)
    await vi.waitFor(() => expect(heard.map((e) => e.id)).toEqual(['evt-standup']), { timeout: 5000 })
  })
})

describe('soonEvents', () => {
  const event = (id: string, startsIn: number, allDay = false): CalendarEvent => ({ id, title: id, startsAt: 1_000_000 + startsIn, endsAt: 1_000_000 + startsIn + 60_000, allDay, calendar: 'c', location: null, url: null })

  it('picks timed events inside the soon window that were not announced', () => {
    const now = 1_000_000
    const list = [event('a', 30_000), event('b', MEETING_SOON_MS + 1), event('c', 10_000, true), event('d', -30_000), event('e', -120_000)]
    expect(soonEvents(list, now, new Set()).map((e) => e.id)).toEqual(['a', 'd'])
    expect(soonEvents(list, now, new Set([`a:${1_000_000 + 30_000}`])).map((e) => e.id)).toEqual(['d'])
  })
})

describe('the calendar tools', () => {
  let service: CalendarService
  const ctx = { chatId: 'c', companionId: 'x', isPrivate: false, isRoutine: false, signal: new AbortController().signal, emit: () => undefined, ask: async () => ({}) } as unknown as ClientToolContext
  const setup = { workspace: { calendar: true } } as unknown as ToolSetup

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'apex-calendar-tools-'))
    sources = []
    broadcasts = []
    service = new CalendarService({ dataDir: dir, helper: () => FAKE, broadcast: () => undefined, openExternal: () => undefined, setSource: () => undefined })
    resetClientToolsForTests()
    registerCalendarTools(service)
  })
  afterAll(() => {
    service.dispose()
    resetClientToolsForTests()
  })

  it('are offered only for kinds that are switched on', async () => {
    expect(clientTool('calendar_events')!.enabled(setup)).toBe(false)
    expect(clientTool('list_reminders')!.enabled(setup)).toBe(false)
    await service.setEnabled('events', true)
    expect(clientTool('calendar_events')!.enabled(setup)).toBe(true)
    expect(clientTool('list_reminders')!.enabled(setup)).toBe(false)
  })

  it('return events as JSON with ISO times', async () => {
    const out = await clientTool('calendar_events')!.run({}, ctx)
    expect(out.isError).toBeFalsy()
    expect(out.content).toContain('Team stand-up')
    expect(out.content).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })
})
