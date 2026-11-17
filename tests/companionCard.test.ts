/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { seededRng } from '@shared/companionLogic'
import { contrastRatio } from '@shared/accent'
import { isLastVisible, pickerSlots, slotIndexOf, stepCompanion, stepSlot, successorAfterRemoval, switcherOrder, visibleCount } from '../src/renderer/src/companion-card/logic/cycle'
import { canRedo, canUndo, createHistory, pushHistory, redoHistory, sealHistory, undoHistory } from '../src/renderer/src/companion-card/logic/history'
import { filterNotes, groupByDate, itemToPath, noteFolder, notePathFromName, noteTitle, pathToItem } from '../src/renderer/src/companion-card/logic/notes'
import { describeSchedule, formToSchedule, scheduleToForm, toggleDay } from '../src/renderer/src/companion-card/logic/schedule'
import { cleanName, uniqueCompanionName } from '../src/renderer/src/companion-card/logic/names'
import { normalizeSection } from '../src/renderer/src/companion-card/logic/sections'
import { chatDefaults, effortLabel, modelLabel } from '../src/renderer/src/companion-card/logic/models'
import { biasPalettes, hexToHsl, paletteScore, pickPalette } from '../src/renderer/src/companion-card/logic/shuffle'
import { shareColors, shareLayout } from '../src/renderer/src/companion-card/logic/share'
import { breadcrumbs, filterFiles, sortFiles } from '../src/renderer/src/companion-card/logic/files'
import { SKILL_NAME, skillMatches, skillNameInput } from '../src/renderer/src/companion-card/logic/skills'

const list = [
  { id: 'a', hidden: false },
  { id: 'b', hidden: true },
  { id: 'c', hidden: false },
  { id: 'd', hidden: false },
]

describe('companion switcher order', () => {
  it('steps through visible companions and wraps', () => {
    const order = switcherOrder(list, 'a')
    expect(order).toEqual(['a', 'c', 'd'])
    expect(stepCompanion(order, 'a', 1)).toBe('c')
    expect(stepCompanion(order, 'd', 1)).toBe('a')
    expect(stepCompanion(order, 'a', -1)).toBe('d')
  })

  it('keeps a hidden companion in place while it is shown', () => {
    const order = switcherOrder(list, 'b')
    expect(order).toEqual(['a', 'b', 'c', 'd'])
    expect(stepCompanion(order, 'b', 1)).toBe('c')
    expect(stepCompanion(order, 'b', -1)).toBe('a')
  })

  it('stays put alone and falls back to the first for unknown ids', () => {
    expect(stepCompanion(['a'], 'a', 1)).toBe('a')
    expect(stepCompanion(['a', 'c'], 'zz', 1)).toBe('a')
    expect(stepCompanion([], 'zz', 1)).toBe('zz')
  })

  it('picks the neighbour after a delete, or nothing', () => {
    expect(successorAfterRemoval(list, 'c')).toBe('d')
    expect(successorAfterRemoval(list, 'd')).toBe('a')
    expect(successorAfterRemoval([{ id: 'a', hidden: false }], 'a')).toBeNull()
    // Deleting a hidden one lands on the visible one after it.
    expect(successorAfterRemoval(list, 'b')).toBe('c')
  })

  it('knows the last visible companion', () => {
    expect(visibleCount(list)).toBe(3)
    expect(isLastVisible(list, 'a')).toBe(false)
    const one = [{ id: 'a', hidden: false }, { id: 'b', hidden: true }]
    expect(isLastVisible(one, 'a')).toBe(true)
    expect(isLastVisible(one, 'b')).toBe(false)
    expect(isLastVisible(one, 'missing')).toBe(false)
  })

  it('ends the new-tab picker with an add entry and wraps around it', () => {
    const slots = pickerSlots(list)
    expect(slots).toEqual([{ kind: 'companion', id: 'a' }, { kind: 'companion', id: 'c' }, { kind: 'companion', id: 'd' }, { kind: 'add' }])
    expect(stepSlot(slots, 2, 1)).toBe(3)
    expect(stepSlot(slots, 3, 1)).toBe(0)
    expect(stepSlot(slots, 0, -1)).toBe(3)
    expect(slotIndexOf(slots, 'c')).toBe(1)
    expect(slotIndexOf(slots, 'b')).toBe(-1)
    expect(stepSlot([], 0, 1)).toBe(0)
  })
})

describe('look history', () => {
  it('undoes and redoes steps, and a new change clears redo', () => {
    let h = createHistory(1)
    h = pushHistory(h, 2)
    h = pushHistory(h, 3)
    expect(canUndo(h)).toBe(true)
    h = undoHistory(h)
    expect(h.present).toBe(2)
    expect(canRedo(h)).toBe(true)
    h = redoHistory(h)
    expect(h.present).toBe(3)
    h = undoHistory(undoHistory(h))
    expect(h.present).toBe(1)
    h = pushHistory(h, 9)
    expect(canRedo(h)).toBe(false)
    expect(h.past).toEqual([1])
  })

  it('ignores changes equal to the present', () => {
    const h = pushHistory(createHistory({ v: 1 }), { v: 1 }, { same: (a, b) => a.v === b.v })
    expect(h.past).toHaveLength(0)
  })

  it('collapses a group (a colour drag) into one step until sealed', () => {
    let h = createHistory('a')
    h = pushHistory(h, 'b', { group: 'color:skin' })
    h = pushHistory(h, 'c', { group: 'color:skin' })
    h = pushHistory(h, 'd', { group: 'color:skin' })
    expect(h.past).toEqual(['a'])
    expect(h.present).toBe('d')
    h = sealHistory(h)
    h = pushHistory(h, 'e', { group: 'color:skin' })
    expect(h.past).toEqual(['a', 'd'])
    // A different group is a new step too.
    h = pushHistory(h, 'f', { group: 'color:hair' })
    expect(h.past).toEqual(['a', 'd', 'e'])
    expect(undoHistory(h).present).toBe('e')
  })

  it('keeps at most the limit of steps', () => {
    let h = createHistory(0)
    for (let i = 1; i <= 10; i++) h = pushHistory(h, i, { limit: 4 })
    expect(h.past).toEqual([6, 7, 8, 9])
    expect(undoHistory(createHistory(5))).toEqual(createHistory(5))
    expect(redoHistory(createHistory(5))).toEqual(createHistory(5))
  })
})

describe('memory notes and links', () => {
  it('round-trips paths through link-safe item ids', () => {
    for (const path of ['/memories/trips/kyoto.md', 'notes/ünïcode file.txt', 'a']) {
      const item = pathToItem(path)
      expect(item).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(itemToPath(item)).toBe(path)
    }
    expect(pathToItem('x'.repeat(200))).toBeNull()
    expect(pathToItem('')).toBeNull()
    expect(itemToPath(null)).toBeNull()
    expect(itemToPath('not a valid id!')).toBeNull()
  })

  it('names notes and their folders', () => {
    expect(noteTitle('/memories/trips/kyoto.md')).toBe('kyoto')
    expect(noteTitle('/memories/plain')).toBe('plain')
    expect(noteFolder('/memories/trips/japan/kyoto.md')).toBe('trips/japan')
    expect(noteFolder('/memories/kyoto.md')).toBe('')
  })

  it('filters by words and author', () => {
    const notes = [
      { path: '/memories/trips/kyoto.md', modifiedAt: 1, author: 'agent' as const },
      { path: '/memories/food.md', modifiedAt: 2, author: 'you' as const },
      { path: '/memories/old.md', modifiedAt: 3, author: null },
    ]
    expect(filterNotes(notes, { query: 'trips KYO' }).map((n) => n.path)).toEqual(['/memories/trips/kyoto.md'])
    expect(filterNotes(notes, { author: 'you' })).toHaveLength(1)
    expect(filterNotes(notes, { author: 'agent' })).toHaveLength(1)
    expect(filterNotes(notes, { author: 'all' })).toHaveLength(3)
  })

  it('groups by date, newest first, leaving out empty groups', () => {
    const now = new Date(2026, 9, 28, 15, 0).getTime()
    const day = 86_400_000
    const notes = [
      { path: 'old', modifiedAt: now - 90 * day, author: null },
      { path: 'today-early', modifiedAt: now - 3_600_000, author: null },
      { path: 'today-late', modifiedAt: now - 60_000, author: null },
      { path: 'yesterday', modifiedAt: now - day, author: null },
    ]
    const groups = groupByDate(notes, now)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Earlier'])
    expect(groups[0]?.items.map((n) => n.path)).toEqual(['today-late', 'today-early'])
  })

  it('turns a typed name into a memory path', () => {
    expect(notePathFromName('Trip ideas')).toBe('/memories/trip-ideas.md')
    expect(notePathFromName('travel/Japan plans')).toBe('/memories/travel/japan-plans.md')
    expect(notePathFromName('list.txt')).toBe('/memories/list.txt')
    expect(notePathFromName('../../etc/passwd')).toBe('/memories/etc/passwd.md')
    expect(notePathFromName('shared/secret')).toBeNull()
    expect(notePathFromName('  /// ')).toBeNull()
    expect(notePathFromName('***')).toBeNull()
  })
})

describe('routine schedules', () => {
  it('describes schedules in words', () => {
    expect(describeSchedule({ kind: 'interval', hours: 1 })).toBe('Every hour')
    expect(describeSchedule({ kind: 'interval', hours: 6 })).toBe('Every 6 hours')
    expect(describeSchedule({ kind: 'daily', time: '08:30', days: [] })).toBe('Every day at 08:30')
    expect(describeSchedule({ kind: 'daily', time: '09:00', days: [5, 1, 2, 3, 4] })).toBe('Weekdays at 09:00')
    expect(describeSchedule({ kind: 'daily', time: '10:00', days: [6, 0] })).toBe('Weekends at 10:00')
    expect(describeSchedule({ kind: 'daily', time: '18:00', days: [4, 1] })).toBe('Mon and Thu at 18:00')
    expect(describeSchedule({ kind: 'daily', time: '18:00', days: [1, 3, 5] })).toBe('Mon, Wed and Fri at 18:00')
  })

  it('validates the form like main does', () => {
    expect(formToSchedule({ kind: 'daily', time: '7:00', days: [], hours: 1 })).toEqual({ error: 'Use a 24-hour time such as 08:30.' })
    expect(formToSchedule({ kind: 'interval', time: '', days: [], hours: 0 })).toEqual({ error: 'Choose between 1 and 168 hours.' })
    expect(formToSchedule({ kind: 'interval', time: '', days: [], hours: 12.4 })).toEqual({ schedule: { kind: 'interval', hours: 12 } })
    // All seven days is the same as every day.
    expect(formToSchedule({ kind: 'daily', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6, 6], hours: 1 })).toEqual({ schedule: { kind: 'daily', time: '07:00', days: [] } })
    expect(formToSchedule({ kind: 'daily', time: '07:00', days: [3, 1, 9], hours: 1 })).toEqual({ schedule: { kind: 'daily', time: '07:00', days: [1, 3] } })
    expect(scheduleToForm({ kind: 'interval', hours: 3 })).toMatchObject({ kind: 'interval', hours: 3 })
    expect(toggleDay([1, 3], 3)).toEqual([1])
    expect(toggleDay([3], 1)).toEqual([1, 3])
  })
})

describe('names, sections and models', () => {
  it('cleans names and suffixes clashes like main', () => {
    expect(cleanName('  Pip   the   Great  ')).toBe('Pip the Great')
    expect(cleanName('x'.repeat(40))).toHaveLength(24)
    expect(uniqueCompanionName('Pip', ['pip', 'Pip 2'])).toBe('Pip 3')
    expect(uniqueCompanionName('Juniper', ['Pip'])).toBe('Juniper')
    expect(uniqueCompanionName('', [])).toBe('Companion')
    const long = 'A'.repeat(24)
    expect(uniqueCompanionName(long, [long])).toBe(`${'A'.repeat(22)} 2`)
  })

  it('opens General for unknown sections', () => {
    expect(normalizeSection('memory')).toBe('memory')
    expect(normalizeSection('nope')).toBe('general')
    expect(normalizeSection(null)).toBe('general')
  })

  it('resolves a companion’s defaults over the global ones', () => {
    expect(chatDefaults({ model: null, effort: null }, { model: 'claude-opus-5-5', effort: 'high' })).toEqual({ model: 'claude-opus-5-5', effort: 'high', modelSource: 'global', effortSource: 'global' })
    expect(chatDefaults({ model: 'claude-haiku-5-5', effort: 'low' }, { model: 'claude-opus-5-5', effort: 'high' })).toEqual({ model: 'claude-haiku-5-5', effort: 'low', modelSource: 'companion', effortSource: 'companion' })
    expect(modelLabel('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5')
    expect(modelLabel('mystery')).toBe('mystery')
    expect(effortLabel('xhigh')).toBe('Extra high')
  })
})

describe('shuffle styles', () => {
  const palettes = [
    { name: 'Pastel', weight: 1, colors: { skin: '#f7e6dc', hair: '#e8d5f2', accent: '#d9ecf7', outfit: '#f2e9d0' } },
    { name: 'Neon', weight: 1, colors: { skin: '#ff2d6f', hair: '#00e5ff', accent: '#ffe600', outfit: '#7cff00' } },
    { name: 'Night', weight: 1, colors: { skin: '#f0d0b0', hair: '#101018', accent: '#c01830', outfit: '#1a1a40' } },
  ]

  it('reads colours as HSL', () => {
    expect(hexToHsl('#ffffff')).toEqual({ h: 0, s: 0, l: 1 })
    expect(hexToHsl('#ff0000').s).toBeCloseTo(1)
  })

  it('scores palettes by style', () => {
    const [pastel, neon, night] = palettes.map((p) => p.colors) as [typeof palettes[0]['colors'], typeof palettes[0]['colors'], typeof palettes[0]['colors']]
    expect(paletteScore(pastel, 'soft')).toBeGreaterThan(paletteScore(neon, 'soft'))
    expect(paletteScore(neon, 'bright')).toBeGreaterThan(paletteScore(pastel, 'bright'))
    expect(paletteScore(night, 'bold')).toBeGreaterThan(paletteScore(pastel, 'bold'))
    expect(paletteScore(night, 'any')).toBe(1)
  })

  it('tilts the odds without ruling palettes out', () => {
    const soft = biasPalettes(palettes, 'soft')
    expect(soft.every((p) => p.weight > 0)).toBe(true)
    expect(soft[0]!.weight).toBeGreaterThan(soft[1]!.weight)
    expect(biasPalettes(palettes, 'any')).toEqual(palettes)
    const rng = seededRng(7)
    const picks = Array.from({ length: 200 }, () => pickPalette(palettes, 'bright', rng)?.name)
    expect(picks.filter((n) => n === 'Neon').length).toBeGreaterThan(120)
    expect(pickPalette([], 'soft', rng)).toBeUndefined()
  })
})

describe('share image', () => {
  it('lays the figure and name out side by side', () => {
    const layout = shareLayout('Pip')
    expect(layout.figure.x + layout.figure.size).toBeLessThanOrEqual(layout.name.x)
    expect(layout.name.x + layout.name.maxWidth).toBeLessThan(layout.width)
    expect(shareLayout('A much longer name here').name.size).toBeLessThan(layout.name.size)
  })

  it('keeps the name readable on the wash', () => {
    for (const [accent, outfit] of [['#6a4bff', '#ffffff'], ['#ffe600', '#fff8c0'], ['#101018', '#000000']] as const) {
      const colors = shareColors(accent, outfit)
      expect(contrastRatio(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('files and skills', () => {
  const entries = [
    { path: 'b.txt', name: 'b.txt', kind: 'file' as const, modifiedAt: 5 },
    { path: 'Notes', name: 'Notes', kind: 'folder' as const, modifiedAt: 1 },
    { path: 'a10.pdf', name: 'a10.pdf', kind: 'file' as const, modifiedAt: 9 },
    { path: 'a2.pdf', name: 'a2.pdf', kind: 'file' as const, modifiedAt: 2 },
  ]

  it('sorts folders first, by name or last change', () => {
    expect(sortFiles(entries, 'name').map((e) => e.name)).toEqual(['Notes', 'a2.pdf', 'a10.pdf', 'b.txt'])
    expect(sortFiles(entries, 'modified').map((e) => e.name)).toEqual(['Notes', 'a10.pdf', 'b.txt', 'a2.pdf'])
    expect(filterFiles(entries, 'PDF a1').map((e) => e.name)).toEqual(['a10.pdf'])
  })

  it('builds breadcrumbs for subfolders', () => {
    expect(breadcrumbs('')).toEqual([{ label: '', path: '' }])
    expect(breadcrumbs('trips/kyoto')).toEqual([
      { label: '', path: '' },
      { label: 'trips', path: 'trips' },
      { label: 'kyoto', path: 'trips/kyoto' },
    ])
  })

  it('shapes skill names as you type', () => {
    expect(skillNameInput('/Weekly Report!')).toBe('weekly-report')
    expect(SKILL_NAME.test(skillNameInput('Weekly Report'))).toBe(true)
    expect(SKILL_NAME.test('-bad')).toBe(false)
    expect(skillMatches({ name: 'weekly-report', description: 'Sums up my week' }, 'week sums')).toBe(true)
    expect(skillMatches({ name: 'weekly-report', description: '' }, 'month')).toBe(false)
  })
})
