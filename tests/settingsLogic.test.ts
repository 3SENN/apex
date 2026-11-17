/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { describe, expect, it } from 'vitest'
import { AVATAR_MAX } from '@shared/ipc'
import { SETTINGS_PAGES } from '@shared/url'
import { AVATAR_FILE_MAX, avatarFileError, initialOf, isAvatarDataUrl, squareCrop } from '../src/renderer/src/settings/logic/avatar'
import {
  ALL_OWNERS,
  groupByOwner,
  matchesOwner,
  matchesQuery,
  memoryDisplayName,
  memoryFilePath,
  ownerChoices,
  ownerFilterOptions,
  ownerName,
  skillNameDraft,
  skillNameError,
  sortSkills,
} from '../src/renderer/src/settings/logic/filters'
import { BUILT_PAGES, DEFAULT_PAGE, NAV_RAIL_BELOW, navMode, resolveSettingsSection, settingsNav, type SettingsPageId } from '../src/renderer/src/settings/logic/nav'
import {
  describeDays,
  describeSchedule,
  formatClock,
  matchesStatus,
  newRoutineDraft,
  nextRunLabel,
  routineDraftErrors,
  scheduleError,
  sortRoutines,
  suggestionDraft,
  visibleSuggestions,
  ROUTINE_SUGGESTIONS,
} from '../src/renderer/src/settings/logic/routines'

const companions = [
  { id: 'companion-1', name: 'Pip', hidden: false },
  { id: 'companion-2', name: 'Juniper', hidden: true },
]

describe('settings nav', () => {
  it('lists only built pages, in spec order, with Connectors as a link', () => {
    const nav = settingsNav()
    const ids = nav.flatMap((g) => g.entries.map((e) => e.id))
    // Every platform's rows when no platform is given.
    for (const id of ['you', 'companions', 'dock-icon', 'model', 'permissions', 'connectors', 'general', 'appearance', 'search', 'languages', 'default-browser', 'notifications', 'privacy', 'downloads', 'import', 'memory', 'storage', 'about']) expect(ids).toContain(id)
    // ST-01's order inside each group, and About last.
    const order = (a: string, b: string): boolean => ids.indexOf(a) < ids.indexOf(b)
    expect(order('companions', 'dock-icon')).toBe(true)
    for (const [a, b] of [['general', 'appearance'], ['appearance', 'search'], ['search', 'languages'], ['languages', 'default-browser'], ['default-browser', 'notifications'], ['notifications', 'privacy'], ['downloads', 'import'], ['import', 'memory'], ['memory', 'storage']]) expect(order(a!, b!)).toBe(true)
    expect(ids.at(-1)).toBe('about')
    // Other platforms' rows are hidden: Dock icon is macOS only.
    expect(settingsNav(undefined, 'win32').flatMap((g) => g.entries.map((e) => e.id))).not.toContain('dock-icon')
    expect(settingsNav(undefined, 'darwin').flatMap((g) => g.entries.map((e) => e.id))).toContain('dock-icon')
    const connectors = nav.flatMap((g) => g.entries).find((e) => e.id === 'connectors')
    expect(connectors).toMatchObject({ kind: 'link', url: 'apex://connectors' })
    expect(nav.map((g) => g.label)).toEqual([null, 'Companion', 'Agent', 'Browsing', 'Your data', null])
  })

  it('drops groups whose pages are all unbuilt and shows pages once built', () => {
    const nav = settingsNav(new Set<SettingsPageId>(['you', 'about']))
    expect(nav.map((g) => g.id)).toEqual(['top', 'agent', 'bottom'])
    expect(nav[2]?.entries[0]).toMatchObject({ kind: 'page', id: 'about', title: `About ${BRAND_NAME}` })
  })

  it('uses titles from the shared page table', () => {
    for (const entry of settingsNav().flatMap((g) => g.entries)) {
      if (entry.kind === 'page') expect(entry.title).toBe(SETTINGS_PAGES.find((p) => p.id === entry.id)?.title)
    }
    expect([...BUILT_PAGES].every((id) => SETTINGS_PAGES.some((p) => p.id === id))).toBe(true)
  })

  it('resolves sections, sub-views and fallbacks', () => {
    expect(resolveSettingsSection('appearance')).toEqual({ page: 'appearance', view: null, redirect: null })
    expect(resolveSettingsSection('companion')).toEqual({ page: 'companions', view: 'look', redirect: null })
    expect(resolveSettingsSection('general')).toEqual({ page: 'general', view: null, redirect: null })
    // Aliases rewrite to the page that holds the setting; sites shows the site settings page inside Privacy.
    expect(resolveSettingsSection('zoom')).toEqual({ page: 'appearance', view: null, redirect: 'appearance' })
    expect(resolveSettingsSection('dock', undefined, 'darwin')).toEqual({ page: 'dock-icon', view: null, redirect: 'dock-icon' })
    expect(resolveSettingsSection('sites')).toEqual({ page: 'privacy', view: 'sites', redirect: null })
    // A page for another platform falls back like an unknown one.
    expect(resolveSettingsSection('dock-icon', undefined, 'win32').page).toBe(DEFAULT_PAGE)
    // Unbuilt, unknown and missing all land on the default page and ask for a rewrite.
    for (const section of ['nope', null]) {
      expect(resolveSettingsSection(section)).toEqual({ page: DEFAULT_PAGE, view: null, redirect: DEFAULT_PAGE })
    }
    // Prototype keys are not sections.
    expect(resolveSettingsSection('constructor').page).toBe(DEFAULT_PAGE)
  })

  it('collapses to a rail on narrow cards and floats when opened there', () => {
    expect(navMode(NAV_RAIL_BELOW, false, false)).toBe('expanded')
    expect(navMode(1400, true, false)).toBe('rail')
    expect(navMode(1400, false, true)).toBe('expanded')
    expect(navMode(NAV_RAIL_BELOW - 1, false, false)).toBe('rail')
    expect(navMode(700, false, true)).toBe('overlay')
    expect(navMode(700, true, true)).toBe('overlay')
  })
})

describe('avatar checks', () => {
  it('accepts common pictures and explains everything else', () => {
    expect(avatarFileError({ type: 'image/png', size: 2048 })).toBeNull()
    expect(avatarFileError({ type: 'image/jpeg', size: AVATAR_FILE_MAX })).toBeNull()
    expect(avatarFileError({ type: 'application/pdf', size: 10 })).toMatch(/isn’t a picture/)
    expect(avatarFileError({ type: '', size: 10 })).toMatch(/isn’t a picture/)
    expect(avatarFileError({ type: 'image/svg+xml', size: 10 })).toMatch(/isn’t a picture/)
    expect(avatarFileError({ type: 'image/x-icon', size: 10 })).toMatch(/format/)
    expect(avatarFileError({ type: 'image/png', size: AVATAR_FILE_MAX + 1 })).toMatch(/smaller/)
    expect(avatarFileError({ type: 'image/png', size: 0 })).toMatch(/empty/)
  })

  it('validates saved data URLs like main does', () => {
    expect(isAvatarDataUrl('data:image/webp;base64,AAAA')).toBe(true)
    expect(isAvatarDataUrl('data:image/gif;base64,AAAA')).toBe(false)
    expect(isAvatarDataUrl('data:image/png;base64,AA AA')).toBe(false)
    expect(isAvatarDataUrl(`data:image/png;base64,${'A'.repeat(AVATAR_MAX)}`)).toBe(false)
  })

  it('crops to the centred square and takes initials', () => {
    expect(squareCrop(400, 300)).toEqual({ sx: 50, sy: 0, size: 300 })
    expect(squareCrop(300, 500)).toEqual({ sx: 0, sy: 100, size: 300 })
    expect(initialOf('  senne ')).toBe('S')
    expect(initialOf('élodie')).toBe('É')
    expect(initialOf('')).toBe('')
  })
})

describe('routine wording', () => {
  it('describes days and schedules', () => {
    expect(describeDays([])).toBe('Every day')
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day')
    expect(describeDays([5, 1, 2, 3, 4])).toBe('Weekdays')
    expect(describeDays([6, 0])).toBe('Weekends')
    expect(describeDays([0, 3, 1])).toBe('Mon, Wed, Sun')
    expect(describeSchedule({ kind: 'interval', hours: 1 })).toBe('Every hour')
    expect(describeSchedule({ kind: 'interval', hours: 6 })).toBe('Every 6 hours')
    expect(describeSchedule({ kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }, 'en-GB')).toBe('Weekdays at 08:30')
    expect(describeSchedule({ kind: 'daily', time: '18:05', days: [] }, 'en-US')).toMatch(/^Every day at 6:05\sPM$/)
    expect(formatClock('7:5')).toBe('7:5')
  })

  it('counts down to the next run', () => {
    const now = new Date(2026, 9, 28, 9, 0).getTime()
    expect(nextRunLabel({ enabled: false, nextRunAt: now + 1000 }, now)).toBe('Paused')
    expect(nextRunLabel({ enabled: true, nextRunAt: null }, now)).toBe('Not scheduled')
    expect(nextRunLabel({ enabled: true, nextRunAt: now - 5000 }, now)).toBe('Due now')
    expect(nextRunLabel({ enabled: true, nextRunAt: now + 30_000 }, now)).toBe('Due now')
    expect(nextRunLabel({ enabled: true, nextRunAt: now + 2 * 3_600_000 + 5 * 60_000 }, now)).toBe('Next run in 2 h 5 min')
    expect(nextRunLabel({ enabled: true, nextRunAt: new Date(2026, 9, 30, 8, 0).getTime() }, now, 'en-GB')).toBe('Next run Friday at 08:00')
    expect(nextRunLabel({ enabled: true, nextRunAt: new Date(2026, 10, 20, 8, 0).getTime() }, now, 'en-GB')).toBe('Next run 20 Nov at 08:00')
  })

  it('validates drafts field by field', () => {
    expect(scheduleError({ kind: 'interval', hours: 0 })).toMatch(/1 to 168/)
    expect(scheduleError({ kind: 'interval', hours: 2.5 })).toMatch(/whole/)
    expect(scheduleError({ kind: 'interval', hours: 168 })).toBeNull()
    expect(scheduleError({ kind: 'daily', time: '', days: [] })).toMatch(/time/)
    expect(scheduleError({ kind: 'daily', time: '23:59', days: [] })).toBeNull()
    const draft = newRoutineDraft('shared')
    expect(routineDraftErrors(draft)).toEqual({ name: 'Give the routine a name.', prompt: 'Say what the routine should do.' })
    expect(routineDraftErrors({ ...draft, name: 'Brief', prompt: 'Do it' })).toEqual({})
  })

  it('filters by status and sorts by next run, then name', () => {
    const list = [
      { name: 'b paused', enabled: false, nextRunAt: 10 },
      { name: 'later', enabled: true, nextRunAt: 300 },
      { name: 'a paused', enabled: false, nextRunAt: null },
      { name: 'soon', enabled: true, nextRunAt: 100 },
      { name: 'unscheduled', enabled: true, nextRunAt: null },
    ]
    expect(sortRoutines(list, 'next').map((r) => r.name)).toEqual(['soon', 'later', 'unscheduled', 'a paused', 'b paused'])
    expect(sortRoutines(list, 'name').map((r) => r.name)).toEqual(['a paused', 'b paused', 'later', 'soon', 'unscheduled'])
    expect(list.filter((r) => matchesStatus(r, 'paused')).length).toBe(2)
    expect(list.filter((r) => matchesStatus(r, 'active')).length).toBe(3)
    expect(list.filter((r) => matchesStatus(r, 'all')).length).toBe(5)
  })
})

describe('destination filters', () => {
  it('matches every word, ignoring case and accents', () => {
    expect(matchesQuery(['Weekly report', 'Summarise the week'], 'week SUMM')).toBe(true)
    expect(matchesQuery(['Café notes'], 'cafe')).toBe(true)
    expect(matchesQuery(['Weekly report'], 'monthly')).toBe(false)
    expect(matchesQuery(['anything', null], '   ')).toBe(true)
  })

  it('names owners and builds filter choices', () => {
    expect(ownerName('shared', companions)).toBe('Shared')
    expect(ownerName('companion-2', companions)).toBe('Juniper')
    expect(ownerName('companion-9', companions)).toBe('Removed companion')
    expect(ownerFilterOptions(companions).map((o) => o.label)).toEqual(['All companions', 'Shared', 'Pip', 'Juniper (hidden)'])
    expect(ownerChoices(companions)[0]).toEqual({ value: 'shared', label: 'Shared with all companions' })
    expect(matchesOwner('companion-1', ALL_OWNERS)).toBe(true)
    expect(matchesOwner('companion-1', 'shared')).toBe(false)
  })

  it('groups shared first, then companions in order, then removed owners', () => {
    const items = [
      { id: 'a', owner: 'companion-2' },
      { id: 'b', owner: 'companion-9' },
      { id: 'c', owner: 'shared' },
      { id: 'd', owner: 'companion-1' },
      { id: 'e', owner: 'shared' },
    ]
    const groups = groupByOwner(items, companions)
    expect(groups.map((g) => g.label)).toEqual(['Shared with all companions', 'Pip', 'Juniper', 'Removed companion'])
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['c', 'e'])
  })

  it('shapes skill names as you type', () => {
    expect(skillNameDraft('/Weekly Report')).toBe('weekly-report')
    expect(skillNameDraft('trip_plan!!  v2')).toBe('trip-plan-v2')
    expect(skillNameDraft('a'.repeat(60))).toHaveLength(40)
    expect(skillNameError('')).toMatch(/name/)
    expect(skillNameError('trailing-')).toMatch(/dashes/)
    expect(skillNameError('ok-name-2')).toBeNull()
  })

  it('sorts skills by use, update or name', () => {
    const skills = [
      { name: 'b', updatedAt: 5, lastUsedAt: null },
      { name: 'a', updatedAt: 1, lastUsedAt: 50 },
      { name: 'c', updatedAt: 9, lastUsedAt: 10 },
    ]
    expect(sortSkills(skills, 'used').map((s) => s.name)).toEqual(['a', 'c', 'b'])
    expect(sortSkills(skills, 'updated').map((s) => s.name)).toEqual(['c', 'b', 'a'])
    expect(sortSkills(skills, 'name').map((s) => s.name)).toEqual(['a', 'b', 'c'])
  })

  it('turns typed names into safe memory paths', () => {
    expect(memoryFilePath('preferences')).toBe('/memories/preferences.md')
    expect(memoryFilePath('/memories/travel/trips.txt')).toBe('/memories/travel/trips.txt')
    expect(memoryFilePath('  /notes.md ')).toBe('/memories/notes.md')
    expect(memoryFilePath('a\\b')).toBe('/memories/a/b.md')
    for (const bad of ['', '   ', '/memories/', 'folder/', '../secrets', 'a/../../b', 'a//b']) expect(memoryFilePath(bad)).toBeNull()
    expect(memoryDisplayName('/memories/travel/trips.md')).toBe('travel/trips.md')
  })
})

describe('routine runs', () => {
  it('maps a run chat to its most urgent status', async () => {
    const { runStatus, runsOf } = await import('../src/renderer/src/settings/logic/routines')
    expect(runStatus({ status: 'running', unread: true, needsInput: true })).toBe('working')
    expect(runStatus({ status: 'needs-approval', unread: false, needsInput: false })).toBe('needs-input')
    expect(runStatus({ status: 'finished', unread: true, needsInput: true })).toBe('needs-input')
    expect(runStatus({ status: 'error', unread: true, needsInput: false })).toBe('error')
    expect(runStatus({ status: 'finished', unread: true, needsInput: false })).toBe('unread')
    expect(runStatus({ status: 'finished', unread: false, needsInput: false })).toBe('success')
    expect(runStatus({ status: 'idle', unread: false, needsInput: false })).toBe('idle')
    const chats = [
      { id: 'a', routineId: 'r1', lastActiveAt: 1 },
      { id: 'b', routineId: null, lastActiveAt: 9 },
      { id: 'c', routineId: 'r2', lastActiveAt: 5 },
      { id: 'd', routineId: 'r1', lastActiveAt: 7 },
    ]
    expect(runsOf(chats, 'r1').map((c) => c.id)).toEqual(['d', 'a'])
    expect(runsOf(chats, null).map((c) => c.id)).toEqual(['d', 'c', 'a'])
    expect(runsOf(chats, null, 1).map((c) => c.id)).toEqual(['d'])
  })
})

describe('connector URLs', () => {
  it('accepts https and local http only', async () => {
    const { connectorUrlError } = await import('../src/renderer/src/settings/logic/filters')
    expect(connectorUrlError('https://mcp.example.com/sse')).toBeNull()
    expect(connectorUrlError('http://localhost:8080/mcp')).toBeNull()
    expect(connectorUrlError('http://127.0.0.1/mcp')).toBeNull()
    expect(connectorUrlError('')).toMatch(/Paste/)
    expect(connectorUrlError('example.com/mcp')).toMatch(/full URL/)
    expect(connectorUrlError('http://example.com/mcp')).toMatch(/https/)
    expect(connectorUrlError('ftp://example.com')).toMatch(/https/)
  })
})

describe('collection grouping', () => {
  it('labels days and groups consecutive items', async () => {
    const { dayLabel, groupByDay, siteInitial } = await import('../src/renderer/src/settings/logic/collections')
    const now = new Date(2026, 9, 28, 15, 0).getTime()
    expect(dayLabel(new Date(2026, 9, 28, 0, 5).getTime(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 27, 23, 59).getTime(), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 9, 20, 9).getTime(), now, 'en-GB')).toBe('Tuesday 20 October')
    expect(dayLabel(new Date(2025, 0, 3, 9).getTime(), now, 'en-GB')).toBe('Friday, 3 January 2025')
    const items = [
      { t: new Date(2026, 9, 28, 14).getTime() },
      { t: new Date(2026, 9, 28, 9).getTime() },
      { t: new Date(2026, 9, 27, 20).getTime() },
    ]
    expect(groupByDay(items, (i) => i.t, now).map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
    ])
    expect(siteInitial('https://www.example.org/a')).toBe('E')
    expect(siteInitial('not a url', 'docs')).toBe('D')
    expect(siteInitial('about:blank')).toBe('?')
  })
})

describe('routine suggestions (DS-102)', () => {
  it('hides dismissed and already-made ones, and opens a fresh draft', () => {
    const first = ROUTINE_SUGGESTIONS[0]!
    expect(visibleSuggestions(new Set(), []).length).toBe(ROUTINE_SUGGESTIONS.length)
    expect(visibleSuggestions(new Set([first.id]), []).some((s) => s.id === first.id)).toBe(false)
    expect(visibleSuggestions(new Set(), [{ name: ` ${first.name.toUpperCase()} ` }]).some((s) => s.id === first.id)).toBe(false)
    const draft = suggestionDraft(first, 'companion-1')
    expect(draft).toMatchObject({ name: first.name, owner: 'companion-1', enabled: true })
    expect(draft.schedule).not.toBe(first.schedule)
    for (const s of ROUTINE_SUGGESTIONS) expect(scheduleError(s.schedule), s.id).toBeNull()
  })
  it('describes the newer schedule kinds', () => {
    expect(describeSchedule({ kind: 'interval', minutes: 30 })).toBe('Every 30 minutes')
    expect(describeSchedule({ kind: 'interval', minutes: 120 })).toBe('Every 2 hours')
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * 1' })).toContain('0 9 * * 1')
    expect(scheduleError({ kind: 'cron', expr: ' ' })).not.toBeNull()
  })
})
