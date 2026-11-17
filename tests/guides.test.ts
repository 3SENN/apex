/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, type Companion, type CompanionPreset } from '@shared/companion'
import { GUIDE_CATEGORIES, filterGuides, guideUrl } from '@shared/guides'
import type { RoutineSaveInput } from '@shared/routines'
import { parseGuide } from '@shared/guideMarkdown'
import { BUILTIN_SOURCES } from '../src/main/skills/builtin'
import { GUIDES } from '../src/main/guides/catalogue'
import { createGuidesService } from '../src/main/guides/service'
import { createPresetMethods, parsePresetExtras } from '../src/main/guides/presets'
import { FakeHost } from './helpers/fakeHost'

const BUILTIN_NAMES = new Set(BUILTIN_SOURCES.map((s) => s.id.replace(/^builtin-/, '')))
const DIRECTORY = ['notion', 'atlassian', 'asana', 'linear', 'github', 'figma', 'canva', 'deepwiki']

describe('the guide catalogue', () => {
  it('has unique ids, known categories and parsable bodies', () => {
    const ids = GUIDES.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    const categories: string[] = GUIDE_CATEGORIES.map((c) => c.id)
    for (const g of GUIDES) {
      expect(categories).toContain(g.category)
      expect(g.minutes).toBeGreaterThan(0)
      expect(parseGuide(g.body).length).toBeGreaterThan(1)
      expect(g.summary.length).toBeLessThan(120)
    }
  })

  it('bundles only built-in skills, valid paused-ready routines and directory connectors', () => {
    for (const g of GUIDES) {
      if (g.tryIt === 'install-bundle') expect(g.bundle).not.toBeNull()
      for (const name of g.bundle?.skills ?? []) expect(BUILTIN_NAMES.has(name), `${g.id}: ${name}`).toBe(true)
      for (const c of g.bundle?.connectors ?? []) expect(DIRECTORY).toContain(c)
      for (const r of g.bundle?.routines ?? []) {
        expect(r.name.length).toBeGreaterThan(0)
        if (r.schedule.kind === 'daily') expect(r.schedule.time).toMatch(/^\d{2}:\d{2}$/)
      }
    }
  })

  it('filters by category and search words', () => {
    expect(filterGuides(GUIDES, { category: 'travel' }).map((g) => g.id)).toEqual(GUIDES.filter((g) => g.category === 'travel').map((g) => g.id))
    expect(filterGuides(GUIDES, { category: 'travel' }).map((g) => g.id)).toContain('trip-planning')
    expect(filterGuides(GUIDES, { query: 'price watch' }).map((g) => g.id)).toContain('compare-before-buying')
    expect(filterGuides(GUIDES, { category: 'all' })).toHaveLength(GUIDES.length)
    expect(guideUrl('a b')).toBe('apex://guides/a%20b')
  })
})

function service() {
  const saved: RoutineSaveInput[] = []
  const host = new FakeHost()
  const routines: Array<{ id: string; name: string }> = []
  const s = createGuidesService({
    skills: { byName: (name) => (BUILTIN_NAMES.has(name) ? { id: `builtin-${name}`, name } : undefined) },
    routines: {
      list: () => routines,
      save: (input) => {
        saved.push(input)
        const r = { id: `r${routines.length + 1}`, name: input.name }
        routines.push(r)
        return r
      },
    },
    host,
    activeCompanionId: () => 'c1',
    directoryIds: () => DIRECTORY.filter((d) => d !== 'asana'),
  })
  return { s, saved, host }
}

describe('Try it', () => {
  it('installs a bundle: skills ready, routines saved paused once, connectors suggested', () => {
    const { s, saved } = service()
    const result = s.tryIt('weekly-review')
    expect(result.installedSkills).toEqual(['weekly-review'])
    expect(result.routines).toEqual(['r1'])
    expect(saved[0]).toMatchObject({ name: 'Weekly review', enabled: false, companionId: 'c1' })
    expect(result.connectorSuggestions).toEqual(['github'])
    expect(result.chatId).toBeNull()
    expect(s.tryIt('weekly-review').routines).toEqual(['r1'])
    expect(saved).toHaveLength(1)
  })

  it('starts a chat for a start-chat guide, with the guide as context', () => {
    const { s, host } = service()
    const result = s.tryIt('meet-your-companion')
    expect(result.chatId).toBe(host.startedChats[0]?.chatId)
    expect(host.startedChats[0]?.options?.context).toContain('<guide id="meet-your-companion">')
  })

  it('maps setup use cases to guides, with basics as the fallback', () => {
    const { s } = service()
    expect(s.forUseCases(['travel']).map((g) => g.id)).toContain('trip-planning')
    expect(s.forUseCases(['travel']).every((g) => g.category === 'travel')).toBe(true)
    expect(s.forUseCases(['other:knitting']).every((g) => g.category === 'basics')).toBe(true)
    expect(() => s.get('nope')).toThrow()
    expect('useCases' in s.get('documents')).toBe(false)
  })
})

describe('preset extras', () => {
  const look = { ...DEFAULT_LOOK, parts: { ...DEFAULT_LOOK.parts }, face: { ...DEFAULT_LOOK.face }, colors: { ...DEFAULT_LOOK.colors } }
  const preset = (version: string, patch: Partial<CompanionPreset> = {}): CompanionPreset => ({ id: 'pip', name: 'Pip', tagline: 'Curious', personality: 'Warm and upbeat.', look, version, ...patch })

  function setup() {
    let current = preset('1')
    let mine = { id: 'c1', name: 'Pip', persona: 'pip', look: structuredClone(look) } as Companion
    const methods = createPresetMethods({
      dataDir: mkdtempSync(join(tmpdir(), 'apex-presets-')),
      companions: {
        find: (id) => (id === 'c1' ? mine : undefined),
        update: (_id, patch) => {
          mine = { ...mine, ...(patch as Partial<Companion>) }
          return mine
        },
      },
      presets: () => [current],
      presetsRaw: () => [{ id: 'pip', summary: 'A cheerful helper.', starterSkills: [{ name: 'hello', description: 'Says hi', instructions: 'Say hi.' }], version: '1' }, { id: 'bad', starterSkills: 'x' }],
    })
    return { methods, setPreset: (p: CompanionPreset) => (current = p), edit: (patch: Partial<Companion>) => (mine = { ...mine, ...patch }), mine: () => mine }
  }

  it('describes a preset with its extras', () => {
    const { methods } = setup()
    expect(methods.presetDetail('pip')).toMatchObject({ name: 'Pip', tagline: 'Curious', summary: 'A cheerful helper.', version: '1' })
    expect(methods.presetDetail('pip').starterSkills).toHaveLength(1)
    expect(() => methods.presetDetail('nobody')).toThrow()
    expect(Object.keys(parsePresetExtras([{ id: 'x', version: '2' }, 7]))).toEqual(['x'])
  })

  it('offers a review only after the preset changes, marks your edits and applies only what you pick', () => {
    const { methods, setPreset, edit, mine } = setup()
    expect(methods.presetDiff('c1')).toBeNull()
    edit({ name: 'Pipsqueak' })
    setPreset(preset('2', { name: 'Pippa', look: { ...look, colors: { ...look.colors, accent: '#123456' } } }))
    const rows = methods.presetDiff('c1')!
    expect(rows.map((r) => r.field)).toEqual(['name', 'colors'])
    expect(rows[0]).toMatchObject({ yours: 'Pipsqueak', preset: 'Pippa', edited: true })
    expect(rows[1]?.edited).toBe(false)
    const updated = methods.applyPresetUpdate('c1', ['colors'])
    expect(updated.name).toBe('Pipsqueak')
    expect(updated.look.colors.accent).toBe('#123456')
    expect(mine().name).toBe('Pipsqueak')
    expect(methods.presetDiff('c1')).toBeNull()
  })

  it('can mark an update reviewed without taking anything', () => {
    const { methods, setPreset, mine } = setup()
    methods.presetDiff('c1')
    setPreset(preset('3', { name: 'Pipster' }))
    expect(methods.presetDiff('c1')).toHaveLength(1)
    expect(() => methods.applyPresetUpdate('c1', ['nonsense'])).toThrow()
    methods.applyPresetUpdate('c1', ['acknowledge'])
    expect(mine().name).toBe('Pip')
    expect(methods.presetDiff('c1')).toBeNull()
  })
})

describe('settings guide links', () => {
  it('point at guides that exist', async () => {
    const { SETTINGS_GUIDES } = await import('@shared/guides')
    const ids = new Set(GUIDES.map((g) => g.id))
    for (const id of Object.values(SETTINGS_GUIDES)) expect(ids.has(id), id).toBe(true)
  })
})
