/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings, renderer side: the settings index covers every row on the
// settings pages, nav width limits, storage maths, the reset dialog's checks, the
// import flow's choices, clear-data option sets and the Dock icon values.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EN } from '@shared/i18n/en'
import { NOTIFICATION_CATEGORIES } from '@shared/notifications'
import { SETTINGS_INDEX, settingsRowUrl } from '@shared/settingsIndex'
import { SETTINGS_PAGES } from '@shared/url'
import type { ImportBrowser } from '@shared/browserImport'
import { clampNavWidth, NAV_WIDTH, navWidthForKey, settingsQuery } from '../src/renderer/src/settings/logic/nav'
import { CHAT_LIST_PREVIEW, MIN_SEGMENT, resetPhraseMatches, resetPlan, sortChatRows, storageLegend, storageSegments, totalBytes } from '../src/renderer/src/settings/logic/storage'
import { countedTypes, defaultTypes, initialBrowser, joinList, needsProfilePicker, toggleType } from '../src/renderer/src/settings/logic/importFlow'
import { CLEAR_CACHE, CLEAR_SITE_DATA, canClear, defaultClearRequest, needsHistoryConfirm, siteDataDescription, toggleKind } from '../src/renderer/src/settings/logic/clearData'
import { chosenCompanion, dockChoiceFor, dockValue } from '../src/renderer/src/settings/logic/dock'

const PAGES_DIR = join(__dirname, '..', 'src', 'renderer', 'src', 'settings', 'pages')
const PAGE_COMPONENTS = ['GeneralPage', 'AppearancePage', 'LanguagesPage', 'DefaultBrowserPage', 'NotificationsPage', 'PrivacyPage', 'StoragePage', 'ImportPage', 'DockIconPage']

/** Every row anchor a page declares; `notify-${category}` expands per category. */
function anchorsIn(file: string): string[] {
  const src = readFileSync(join(PAGES_DIR, `${file}.tsx`), 'utf8')
  const out: string[] = []
  for (const m of src.matchAll(/(?:anchor|data-settings-anchor)=(?:"([a-z0-9-]+)"|\{`([a-z0-9-]+)\$\{category\}`\})/g)) {
    if (m[1]) out.push(m[1])
    else if (m[2]) out.push(...NOTIFICATION_CATEGORIES.map((c) => `${m[2]}${c}`))
  }
  return out
}

describe('settings index (ST-05)', () => {
  it('has an entry for every row on the settings pages', () => {
    const anchors = new Set(SETTINGS_INDEX.map((e) => e.anchor))
    const missing = PAGE_COMPONENTS.flatMap((page) => anchorsIn(page).filter((a) => !anchors.has(a)).map((a) => `${page}#${a}`))
    expect(missing).toEqual([])
  })

  it('names real pages and message keys, with unique ids', () => {
    const pages = new Set<string>(SETTINGS_PAGES.map((p) => p.id))
    const ids = SETTINGS_INDEX.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of SETTINGS_INDEX) {
      expect(pages.has(entry.page), entry.id).toBe(true)
      expect(Object.hasOwn(EN, entry.title), entry.title).toBe(true)
      expect(entry.keywords.length, entry.id).toBeGreaterThan(0)
    }
    // Every settings page is findable by name too.
    for (const page of ['general', 'appearance', 'languages', 'default-browser', 'notifications', 'privacy', 'import', 'storage', 'about', 'dock-icon']) {
      expect(SETTINGS_INDEX.some((e) => e.page === page && e.anchor === ''), page).toBe(true)
    }
  })

  it('links a row with ?highlight and a page without', () => {
    expect(settingsRowUrl({ page: 'privacy', anchor: 'clear-cache' })).toBe('atelier://settings/privacy?highlight=clear-cache')
    expect(settingsRowUrl({ page: 'storage', anchor: '' })).toBe('atelier://settings/storage')
    expect(settingsQuery('atelier://settings/import?browser=chrome&highlight=import-browser')).toMatchObject({ browser: 'chrome', highlight: 'import-browser', clear: false })
    expect(settingsQuery('atelier://settings/privacy?clear=1&highlight=<x>')).toMatchObject({ clear: true, highlight: null })
  })
})

describe('settings nav width (ST-02)', () => {
  it('clamps, remembers and steps with the keyboard', () => {
    expect(clampNavWidth('300')).toBe(300)
    expect(clampNavWidth(10)).toBe(NAV_WIDTH.min)
    expect(clampNavWidth(9999)).toBe(NAV_WIDTH.max)
    expect(clampNavWidth(null)).toBe(NAV_WIDTH.default)
    expect(navWidthForKey('ArrowRight', 288)).toBe(288 + NAV_WIDTH.step)
    expect(navWidthForKey('ArrowLeft', NAV_WIDTH.min)).toBe(NAV_WIDTH.min)
    expect(navWidthForKey('End', 288)).toBe(NAV_WIDTH.max)
    expect(navWidthForKey('a', 288)).toBeNull()
  })
})

describe('storage maths (ST-53, ST-54)', () => {
  const cats = [
    { id: 'cache', label: 'Cache', order: 60, bytes: 600, clearLabel: 'Clear' },
    { id: 'chats', label: 'Chats', order: 10, bytes: 100_000, clearLabel: null },
    { id: 'memory', label: 'Memory', order: 30, bytes: 0, clearLabel: null },
    { id: 'history', label: 'History', order: 40, bytes: 50_000, clearLabel: null },
  ]

  it('adds up and splits the bar in category order, widening tiny parts', () => {
    expect(totalBytes(cats)).toBe(150_600)
    const segs = storageSegments(cats)
    expect(segs.map((s) => s.id)).toEqual(['chats', 'history', 'cache'])
    expect(segs.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 6)
    expect(segs.find((s) => s.id === 'cache')?.share).toBe(MIN_SEGMENT)
    expect(storageSegments([{ ...cats[0]!, bytes: 0 }])).toEqual([])
  })

  it('keeps every category in the legend with a stable colour slot', () => {
    const legend = storageLegend(cats)
    expect(legend.map((c) => [c.id, c.tone])).toEqual([
      ['chats', 1],
      ['memory', 2],
      ['history', 3],
      ['cache', 4],
    ])
    // The bar uses the same slot as the legend.
    expect(storageSegments(cats).find((s) => s.id === 'cache')?.tone).toBe(4)
  })

  it('sorts chats largest first, then most recent', () => {
    const rows = [
      { chatId: 'a', title: 'A', bytes: 10, imageBytes: 0, updatedAt: 1 },
      { chatId: 'b', title: 'B', bytes: 30, imageBytes: 20, updatedAt: 1 },
      { chatId: 'c', title: 'C', bytes: 10, imageBytes: 0, updatedAt: 5 },
    ]
    expect(sortChatRows(rows).map((r) => r.chatId)).toEqual(['b', 'c', 'a'])
    expect(CHAT_LIST_PREVIEW).toBeGreaterThan(0)
  })
})

describe('reset dialog (ST-55)', () => {
  const steps = [
    { id: 'settings', order: 90, label: 'Settings', secrets: false },
    { id: 'stop', order: 0, label: 'Stop', secrets: false },
    { id: 'api-key', order: 100, label: 'Key', secrets: true },
  ]
  it('lists secret steps only when the box is ticked', () => {
    expect(resetPlan(steps, false).map((s) => s.id)).toEqual(['stop', 'settings'])
    expect(resetPlan(steps, true).map((s) => s.id)).toEqual(['stop', 'settings', 'api-key'])
  })
  it('needs the phrase typed, ignoring case and outer spaces', () => {
    expect(resetPhraseMatches('  Reset   atelier ', 'reset Atelier')).toBe(true)
    expect(resetPhraseMatches('reset', 'reset Atelier')).toBe(false)
    expect(resetPhraseMatches('', 'reset Atelier')).toBe(false)
  })
})

describe('import flow (ST-46, ON-03)', () => {
  const chrome: ImportBrowser = { id: 'chrome', name: 'Chrome', kind: 'chromium', profiles: [{ id: 'Default', name: 'Personal' }, { id: 'Profile 1', name: 'Work' }], types: ['bookmarks', 'history', 'tabs', 'searchEngines'], needsAccess: false }
  const safari: ImportBrowser = { id: 'safari', name: 'Safari', kind: 'safari', profiles: [{ id: 'default', name: 'Safari' }], types: ['bookmarks', 'history'], needsAccess: true }

  it('starts on the asked-for browser, else the first readable one', () => {
    expect(initialBrowser([safari, chrome], 'safari')?.id).toBe('safari')
    expect(initialBrowser([safari, chrome], null)?.id).toBe('chrome')
    expect(initialBrowser([safari], 'nope')?.id).toBe('safari')
    expect(initialBrowser([], null)).toBeNull()
  })

  it('ticks what the browser keeps and only allows those', () => {
    expect(defaultTypes(safari)).toEqual(['bookmarks', 'history'])
    expect(toggleType(['bookmarks', 'history'], 'history', false, safari.types)).toEqual(['bookmarks'])
    expect(toggleType(['bookmarks'], 'tabs', true, safari.types)).toEqual(['bookmarks'])
    expect(toggleType(['history'], 'bookmarks', true, chrome.types)).toEqual(['bookmarks', 'history'])
    expect(needsProfilePicker(chrome)).toBe(true)
    expect(needsProfilePicker(safari)).toBe(false)
  })

  it('reads the summary counts as a list', () => {
    expect(countedTypes({ history: 3, bookmarks: 2, tabs: 0 })).toEqual([
      { type: 'bookmarks', count: 2 },
      { type: 'history', count: 3 },
    ])
    const and = (a: string, b: string): string => `${a} and ${b}`
    expect(joinList(['2 bookmarks'], and)).toBe('2 bookmarks')
    expect(joinList(['a', 'b', 'c'], and)).toBe('a, b and c')
    expect(joinList([], and)).toBe('')
  })
})

describe('clear-data option sets (ST-36)', () => {
  it('starts on history and cookies for the last hour, and asks before history', () => {
    const req = defaultClearRequest()
    expect(req.range).toBe('hour')
    expect(canClear({ ...req, history: false, siteData: false, cache: false })).toBe(false)
    expect(needsHistoryConfirm(toggleKind(req, 'history', true))).toBe(true)
    expect(needsHistoryConfirm(CLEAR_CACHE)).toBe(false)
    expect(CLEAR_SITE_DATA).toEqual({ range: 'all', history: false, siteData: true, cache: false })
    expect(siteDataDescription('all')).toBe('settings.clearData.siteData.description')
    expect(siteDataDescription('day')).toBe('settings.clearData.siteData.ranged')
  })
})

describe('Dock icon values (ST-09)', () => {
  it('maps choices to radio values and back, and finds the companion', () => {
    expect(dockValue({ kind: 'standard' })).toBe('standard')
    expect(dockValue({ kind: 'companion', companionId: 'pip' })).toBe('pip')
    expect(dockChoiceFor('standard')).toEqual({ kind: 'standard' })
    expect(dockChoiceFor('pip')).toEqual({ kind: 'companion', companionId: 'pip' })
    expect(chosenCompanion({ kind: 'companion', companionId: 'pip' }, [{ id: 'pip' }])).toEqual({ id: 'pip' })
    expect(chosenCompanion({ kind: 'companion', companionId: 'gone' }, [{ id: 'pip' }])).toBeNull()
    expect(chosenCompanion({ kind: 'standard' }, [{ id: 'pip' }])).toBeNull()
  })
})
