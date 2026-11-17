/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AUTO_ITEMS,
  DISMISS_ALL_AFTER_MS,
  FIRST_WEEK_GUIDES,
  FIRST_WEEK_VERSION,
  PLAN_COLLAPSED,
  gridStep,
  guideById,
  nextMorning,
  orderPlan,
  planItems,
  showMoreLabel,
  starterHue,
  visiblePlan,
  type FirstWeekSignals,
  type StarterChat,
} from '@shared/firstWeek'
import { internalTitle, parseInternalUrl } from '@shared/url'
import { FirstWeekStore, ITEM_ID, companionCustomised, companionFingerprint, readRecord, type FirstWeekDeps, type LiveSignals } from '../src/main/firstWeek'
import { STARTER_MODEL, STARTERS_SCHEMA, curatedStarters, generateStarters, parseStarters, starterContextText, starterRequest, type StarterContext, type StarterQuick } from '../src/main/firstWeekStarters'
import { EngineUnavailableError, createQuickModel, quickJsonSchema, type QuickClient, type QuickCreateParams } from '../src/main/agent/quick'

const DAY = 86_400_000
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-first-week-'))
const noSignals: FirstWeekSignals = { 'import-data': false, 'default-browser': false, 'connect-app': false, 'customise-companion': false, 'set-up-routine': false, 'try-dictation': false, 'record-meeting': false, 'build-artifact': false, 'search-web': false }

function starters(n: number): StarterChat[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, title: `Starter ${i + 1}`, description: 'd', prompt: `Prompt ${i + 1}`, glyph: 'compass', hue: starterHue(i) }))
}

interface Harness {
  dir: string
  store: FirstWeekStore
  live: LiveSignals
  clock: { now: number }
  companions: Array<{ id: string; fingerprint: string }>
  setOnboarded(value: boolean): void
}

function harness(options: { dir?: string; onboarded?: boolean; personal?: FirstWeekDeps['personalStarters'] } = {}): Harness {
  const dir = options.dir ?? tempDir()
  const live: LiveSignals = { 'default-browser': false, 'connect-app': false, 'set-up-routine': false, 'try-dictation': false }
  const clock = { now: new Date(2026, 9, 28, 14, 30).getTime() }
  const companions = [{ id: 'pip', fingerprint: 'aaaa0000' }]
  let onboarded = options.onboarded ?? false
  const store = new FirstWeekStore(dir, {
    live: () => ({ ...live }),
    companions: () => companions.map((c) => ({ ...c })),
    onboarded: () => onboarded,
    curatedStarters: () => starters(8),
    ...(options.personal ? { personalStarters: options.personal } : {}),
    now: () => clock.now,
  })
  return { dir, store, live, clock, companions, setOnboarded: (v) => (onboarded = v) }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('first-week rules', () => {
  it('snoozes until 9:00 the next local day, whatever the time now', () => {
    const afternoon = new Date(2026, 9, 28, 14, 30).getTime()
    expect(new Date(nextMorning(afternoon))).toEqual(new Date(2026, 9, 29, 9, 0, 0, 0))
    // Just after midnight still means the next calendar day.
    const lateNight = new Date(2026, 9, 28, 0, 15).getTime()
    expect(new Date(nextMorning(lateNight))).toEqual(new Date(2026, 9, 29, 9, 0, 0, 0))
    // Month and year rollover.
    expect(new Date(nextMorning(new Date(2026, 11, 31, 22, 0).getTime()))).toEqual(new Date(2027, 0, 1, 9, 0, 0, 0))
  })

  it('interleaves starters with automatic items and hides dictation where it is unavailable', () => {
    const items = planItems({ starters: starters(3), completed: {}, dismissed: {}, signals: noSignals })
    expect(items.map((i) => i.id)).toEqual(['s1', 'import-data', 's2', 'search-web', 's3', 'connect-app', 'customise-companion', 'default-browser', 'set-up-routine', 'try-dictation', 'build-artifact', 'record-meeting'])
    const withoutDictation = planItems({ starters: [], completed: {}, dismissed: {}, signals: noSignals, dictationAvailable: false })
    expect(withoutDictation.map((i) => i.id)).not.toContain('try-dictation')
  })

  it('marks starters done when completed, autos on their signal, and keeps sticky completions', () => {
    const items = planItems({
      starters: starters(2),
      completed: { s2: 1, 'import-data': 1, 'default-browser': 1 },
      dismissed: { s1: 1 },
      signals: { ...noSignals, 'connect-app': true },
    })
    const done = Object.fromEntries(items.map((i) => [i.id, i.done]))
    expect(done.s1).toBeUndefined()
    expect(done.s2).toBe(true)
    expect(done['import-data']).toBe(true)
    expect(done['connect-app']).toBe(true)
    // Default browser is live only: an old completion doesn't count once it's changed back.
    expect(done['default-browser']).toBe(false)
  })

  it('carries each item’s action', () => {
    const items = planItems({ starters: starters(1), completed: {}, dismissed: {}, signals: noSignals })
    expect(items.find((i) => i.id === 's1')?.action).toEqual({ kind: 'chat', prompt: 'Prompt 1' })
    expect(items.find((i) => i.id === 'default-browser')?.action).toEqual({ kind: 'default-browser' })
    expect(items.find((i) => i.id === 'customise-companion')?.action).toEqual({ kind: 'companion' })
    expect(items.find((i) => i.id === 'import-data')?.action).toEqual({ kind: 'page', url: 'atelier://settings/import' })
  })

  it('puts unfinished cards first, keeping their order', () => {
    const items = planItems({ starters: starters(3), completed: { s1: 1 }, dismissed: {}, signals: { ...noSignals, 'connect-app': true } })
    expect(orderPlan(items).map((i) => i.id)).toEqual(['import-data', 's2', 'search-web', 's3', 'customise-companion', 'default-browser', 'set-up-routine', 'try-dictation', 'build-artifact', 'record-meeting', 's1', 'connect-app'])
  })

  it('shows six cards, then all of them', () => {
    const items = planItems({ starters: starters(8), completed: {}, dismissed: {}, signals: noSignals })
    expect(items).toHaveLength(17)
    expect(visiblePlan(items, false)).toMatchObject({ more: 11 })
    expect(visiblePlan(items, false).shown).toHaveLength(PLAN_COLLAPSED)
    expect(visiblePlan(items, true)).toMatchObject({ more: 0 })
    expect(visiblePlan(items, true).shown).toHaveLength(17)
    expect(visiblePlan(items.slice(0, 4), false)).toMatchObject({ more: 0 })
    expect(showMoreLabel(7, false)).toBe('Show 7 more')
    expect(showMoreLabel(7, true)).toBe('Show less')
  })

  it('moves focus through the two-column grid with the arrow keys', () => {
    expect(gridStep(0, 'ArrowRight', 6)).toBe(1)
    expect(gridStep(1, 'ArrowLeft', 6)).toBe(0)
    expect(gridStep(1, 'ArrowDown', 6)).toBe(3)
    expect(gridStep(3, 'ArrowUp', 6)).toBe(1)
    // Edges stay put.
    expect(gridStep(0, 'ArrowLeft', 6)).toBe(0)
    expect(gridStep(5, 'ArrowRight', 6)).toBe(5)
    expect(gridStep(4, 'ArrowDown', 6)).toBe(4)
    expect(gridStep(3, 'Home', 6)).toBe(0)
    expect(gridStep(0, 'End', 6)).toBe(5)
    expect(gridStep(0, 'Enter', 6)).toBeNull()
    expect(gridStep(0, 'ArrowDown', 0)).toBeNull()
  })

  it('gives neighbouring starters different hues', () => {
    for (let i = 0; i < 7; i++) expect(starterHue(i)).not.toBe(starterHue(i + 1))
  })
})

describe('first-week store', () => {
  it('is not created until setup finishes, then opens itself exactly once', () => {
    const h = harness()
    expect(h.store.view().status).toBe('not-created')
    expect(() => h.store.dismiss('s1')).toThrow(/setup/)
    h.setOnboarded(true)
    // setupFinished creates the record even before onboarded is read.
    const fresh = harness({ dir: tempDir() })
    expect(fresh.store.setupFinished()).toBe(true)
    expect(fresh.store.setupFinished()).toBe(false)
    const view = fresh.store.view()
    expect(view.status).toBe('ready')
    expect(view.items).toHaveLength(17)
    expect(view.total).toBe(17)
    expect(view.startersSource).toBe('curated')
    const saved = JSON.parse(readFileSync(join(fresh.dir, 'first-week.json'), 'utf8'))
    expect(saved.version).toBe(FIRST_WEEK_VERSION)
    expect(saved.autoOpenedAt).not.toBeNull()
  })

  it('creates the record for people who finished setup before the page existed, without opening it', () => {
    const h = harness({ onboarded: true })
    expect(h.store.view().status).toBe('ready')
    expect(h.store.setupFinished()).toBe(false)
  })

  it('resets an invalid file with a notice, keeping the old one aside', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'first-week.json'), JSON.stringify({ version: 1, createdAt: 'yesterday' }))
    const h = harness({ dir, onboarded: true })
    const view = h.store.view()
    expect(view.status).toBe('invalid')
    expect(view.notice).toMatch(/started over/)
    expect(view.items.length).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'first-week.invalid.json'))).toBe(true)
    // The new file is valid at once.
    expect(readRecord(readFileSync(join(dir, 'first-week.json'), 'utf8')).record).not.toBeNull()
    expect(h.store.acknowledge().status).toBe('ready')
  })

  it('resets a file from a newer Atelier and an unreadable one', () => {
    expect(readRecord(JSON.stringify({ version: FIRST_WEEK_VERSION + 1 })).notice).toMatch(/newer version/)
    expect(readRecord('{not json').notice).toMatch(/couldn’t be read/)
    expect(readRecord(null)).toEqual({ record: null, notice: null })
  })

  it('dismisses and restores single cards', () => {
    const h = harness({ onboarded: true })
    expect(h.store.dismiss('s1').items.map((i) => i.id)).not.toContain('s1')
    expect(h.store.restore('s1').items.map((i) => i.id)).toContain('s1')
    expect(() => h.store.dismiss('../etc')).toThrow()
  })

  it('unlocks dismiss all 30 days after setup', () => {
    const h = harness({ onboarded: true })
    const view = h.store.view()
    expect(view.canDismissAll).toBe(false)
    expect(view.dismissAllAt).toBe(view.createdAt! + DISMISS_ALL_AFTER_MS)
    expect(() => h.store.dismissAll()).toThrow(/30 days/)
    h.clock.now += 30 * DAY
    expect(h.store.view().canDismissAll).toBe(true)
    const after = h.store.dismissAll()
    expect(after.items).toHaveLength(0)
    expect(after.canDismissAll).toBe(false)
  })

  it('snoozes until the next morning and wakes up on its own', () => {
    const h = harness({ onboarded: true })
    const snoozed = h.store.snooze()
    expect(snoozed.snoozedUntil).toBe(nextMorning(h.clock.now))
    h.clock.now = snoozed.snoozedUntil! + 1
    expect(h.store.view().snoozedUntil).toBeNull()
    h.store.snooze()
    expect(h.store.unsnooze().snoozedUntil).toBeNull()
  })

  it('hides with a reason and shows again', () => {
    const h = harness({ onboarded: true })
    const hidden = h.store.hide('too-much', '  a note  ')
    expect(hidden.status).toBe('off')
    expect(hidden.hiddenReason).toBe('too-much')
    const saved = JSON.parse(readFileSync(join(h.dir, 'first-week.json'), 'utf8'))
    expect(saved.hidden).toMatchObject({ reason: 'too-much', note: 'a note' })
    const shown = h.store.show()
    expect(shown.status).toBe('ready')
    expect(shown.hiddenReason).toBeNull()
  })

  it('ticks starters by hand and automatic items on their signals', () => {
    const h = harness({ onboarded: true })
    expect(h.store.setDone('s3', true).items.find((i) => i.id === 's3')?.done).toBe(true)
    expect(h.store.setDone('s3', false).items.find((i) => i.id === 's3')?.done).toBe(false)

    h.store.signal('import-data')
    h.live['connect-app'] = true
    h.live['default-browser'] = true
    let done = Object.fromEntries(h.store.view().items.map((i) => [i.id, i.done]))
    expect(done).toMatchObject({ 'import-data': true, 'connect-app': true, 'default-browser': true })

    // Removing the connector keeps the step done; changing the default browser back does not.
    h.live['connect-app'] = false
    h.live['default-browser'] = false
    done = Object.fromEntries(h.store.view().items.map((i) => [i.id, i.done]))
    expect(done).toMatchObject({ 'import-data': true, 'connect-app': true, 'default-browser': false })
  })

  it('notices a customised or added companion against the setup baseline', () => {
    const h = harness({ onboarded: true })
    const customise = (): boolean | undefined => h.store.view().items.find((i) => i.id === 'customise-companion')?.done
    expect(customise()).toBe(false)
    h.companions[0]!.fingerprint = 'bbbb1111'
    expect(customise()).toBe(true)
    expect(companionCustomised({ pip: 'x' }, [{ id: 'pip', fingerprint: 'x' }, { id: 'nova', fingerprint: 'y' }])).toBe(true)
    expect(companionCustomised({ pip: 'x' }, [{ id: 'pip', fingerprint: 'x' }])).toBe(false)
  })

  it('fingerprints what makes a companion itself', () => {
    const base = { name: 'Pip', persona: 'pip', look: { rig: 'A' }, instructions: '' }
    expect(companionFingerprint(base)).toBe(companionFingerprint({ ...base }))
    expect(companionFingerprint(base)).not.toBe(companionFingerprint({ ...base, look: { rig: 'B' } }))
    expect(companionFingerprint(base)).not.toBe(companionFingerprint({ ...base, instructions: 'Be brief.' }))
    expect(companionFingerprint(base)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('replaces curated starters with personal ones, once', async () => {
    const personal = vi.fn(async () => starters(5).map((s) => ({ ...s, title: `Personal ${s.id}` })))
    const h = harness({ personal })
    h.store.setupFinished()
    expect(h.store.view().personalizing).toBe(true)
    await flush()
    const view = h.store.view()
    expect(view.personalizing).toBe(false)
    expect(view.startersSource).toBe('personal')
    expect(view.items.find((i) => i.id === 's1')?.title).toBe('Personal s1')
    h.store.retryPersonal()
    expect(personal).toHaveBeenCalledTimes(1)
  })

  it('keeps trying after "no key" but not after a failed call', async () => {
    let result: StarterChat[] | null = null
    const personal = vi.fn(async () => result)
    const h = harness({ personal })
    h.store.setupFinished()
    await flush()
    expect(h.store.view().startersSource).toBe('curated')
    // A key arrives: one more try, which fails.
    result = []
    h.store.retryPersonal()
    await flush()
    expect(personal).toHaveBeenCalledTimes(2)
    h.store.retryPersonal()
    await flush()
    expect(personal).toHaveBeenCalledTimes(2)
    expect(h.store.view().startersSource).toBe('curated')
  })

  it('never swaps starters under you once one was opened', async () => {
    let release: (s: StarterChat[]) => void = () => undefined
    const personal = vi.fn(() => new Promise<StarterChat[]>((r) => (release = r)))
    const h = harness({ personal })
    h.store.setupFinished()
    h.store.setDone('s1', true)
    release(starters(6).map((s) => ({ ...s, title: 'Late' })))
    await flush()
    expect(h.store.view().startersSource).toBe('curated')
    expect(h.store.view().items.find((i) => i.id === 's2')?.title).toBe('Starter 2')
  })

  it('pushes a view on every change', () => {
    const h = harness({ onboarded: true })
    const seen: string[] = []
    h.store.on('changed', (v) => seen.push(v.status))
    h.store.snooze()
    h.store.hide('other')
    h.store.refresh()
    expect(seen).toEqual(['ready', 'off', 'off'])
  })

  it('accepts only known item ids', () => {
    for (const id of ['s1', 's8', ...AUTO_ITEMS]) expect(ITEM_ID.test(id)).toBe(true)
    for (const id of ['s0', 's9', 'S1', 'import', '']) expect(ITEM_ID.test(id)).toBe(false)
  })
})

describe('starter chats', () => {
  const context: StarterContext = {
    userName: 'Sam',
    companionName: 'Pip',
    instructions: 'Keep answers short.',
    memoryNotes: ['home.md: Lives in Ghent', 'food.md: Vegetarian'],
    connectors: ['Calendar'],
    recentSites: ['runners.example.com', 'runners.example.com', 'Bad host<script>', 'news.example.org'],
  }

  it('ships eight curated starters', () => {
    const list = curatedStarters()
    expect(list).toHaveLength(8)
    expect(list.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])
    for (const s of list) {
      expect(s.title.length).toBeLessThanOrEqual(48)
      expect(s.prompt.length).toBeGreaterThan(20)
    }
  })

  it('builds a small structured-output quick request on the small model', () => {
    const request = starterRequest(context)
    expect(request.model).toBe(STARTER_MODEL)
    expect(request.effort).toBe('low')
    expect(request.kind).toBe('onboarding')
    expect(request.schema).toBe(STARTERS_SCHEMA)
    expect(request).not.toHaveProperty('thinking')
    // The zod schema converts to a structured-output schema both engines accept.
    const schema = quickJsonSchema(request.schema) as { type: string; required: string[]; additionalProperties: boolean }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['starters'])
    expect(schema.additionalProperties).toBe(false)
    const text = starterContextText(context)
    expect(text).toContain('<name>Sam</name>')
    expect(text).toContain('<connected_apps>Calendar</connected_apps>')
    // Hosts only, de-duplicated, and nothing that isn't a plain hostname.
    expect(text).toContain('<recent_sites>runners.example.com, news.example.org</recent_sites>')
    expect(text).not.toContain('script')
    expect(text).toContain('Vegetarian')
  })

  it('leaves out what it doesn’t know and trims long context', () => {
    const text = starterContextText({ ...context, userName: '', instructions: 'x'.repeat(5000), connectors: [], memoryNotes: [] })
    expect(text).not.toContain('<name>')
    expect(text).not.toContain('<connected_apps>')
    expect(text).not.toContain('<memory_notes>')
    expect(text.length).toBeLessThan(1000)
  })

  it('validates, trims and de-duplicates the model’s starters', () => {
    const json = JSON.stringify({
      starters: [
        { title: 'Plan a run.', description: 'A route for Saturday', prompt: 'Plan me a 10 km route near home.', glyph: 'compass' },
        { title: 'plan a run', description: 'dup', prompt: 'Duplicate prompt here.', glyph: 'compass' },
        { title: 'Cook something new', description: 'd'.repeat(200), prompt: 'Suggest a vegetarian dinner.', glyph: 'list' },
        { title: 'Check my week', description: 'Your calendar at a glance', prompt: 'What is on my calendar this week?', glyph: 'calendar' },
        { title: 'Compare shoes', description: 'Trail shoes side by side', prompt: 'Compare three trail running shoes.', glyph: 'cart' },
      ],
    })
    const parsed = parseStarters(json)
    expect(parsed?.map((s) => s.title)).toEqual(['Plan a run', 'Cook something new', 'Check my week', 'Compare shoes'])
    expect(parsed?.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4'])
    expect(parsed?.[1]?.description.length).toBeLessThanOrEqual(80)
    expect(parseStarters('not json')).toBeNull()
    expect(parseStarters(JSON.stringify({ starters: [{ title: 'x', description: 'y', prompt: 'long enough', glyph: 'rocket' }] }))).toBeNull()
    // Fewer than four is a failure.
    expect(parseStarters(JSON.stringify({ starters: JSON.parse(json).starters.slice(0, 2) }))).toBeNull()
  })

  const okStarters = { starters: curatedStarters().slice(0, 5).map(({ title, description, prompt, glyph }) => ({ title, description, prompt, glyph })) }

  function keyQuick(create: (params: QuickCreateParams) => Promise<Awaited<ReturnType<QuickClient['messages']['create']>>>) {
    return createQuickModel({ engine: () => 'api-key', apiKey: () => 'sk-test', client: () => ({ messages: { create } }), others: {} })
  }

  it('generates with the API key through QuickModel: low effort and a json_schema format', async () => {
    const create = vi.fn(async (_params: QuickCreateParams) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(okStarters) }] }))
    const result = await generateStarters(keyQuick(create), context)
    expect(result).toHaveLength(5)
    expect(create).toHaveBeenCalledTimes(1)
    const request = create.mock.calls[0]?.[0]
    expect(request?.model).toBe(STARTER_MODEL)
    expect(request?.output_config?.effort).toBe('low')
    expect(request?.output_config?.format?.type).toBe('json_schema')
  })

  it('falls back to the curated list on refusals and errors, and passes "no engine" up', async () => {
    expect(await generateStarters(keyQuick(async () => ({ stop_reason: 'refusal', content: [] })), context)).toBeNull()
    expect(await generateStarters(keyQuick(async () => Promise.reject(new Error('offline'))), context)).toBeNull()
    // Malformed twice (QuickModel's one retry) is a failure, not a throw.
    expect(await generateStarters(keyQuick(async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"starters":[]}' }] })), context)).toBeNull()
    const none: StarterQuick = { ready: async () => ({ ok: false, engine: null, reason: 'none' }), json: async () => Promise.reject(new EngineUnavailableError('none')) }
    await expect(generateStarters(none, context)).rejects.toBeInstanceOf(EngineUnavailableError)
  })
})

describe('first-week routes', () => {
  it('parses the page and its guides, with tab titles', () => {
    expect(parseInternalUrl('atelier://first-week')).toMatchObject({ page: 'first-week', section: null })
    expect(parseInternalUrl('atelier://first-week/meet-your-companion')).toMatchObject({ page: 'first-week', section: 'meet-your-companion' })
    expect(parseInternalUrl('atelier://first-week/a/b')).toBeNull()
    expect(internalTitle('atelier://first-week')).toEqual({ title: 'Getting started', crumbs: ['Getting started'] })
    expect(internalTitle('atelier://first-week/chats-and-tabs')).toEqual({ title: 'Chats and tabs', crumbs: ['Getting started', 'Chats and tabs'] })
    expect(internalTitle('atelier://first-week/unknown').crumbs).toEqual(['Getting started'])
  })

  it('has four guides with unique ids', () => {
    expect(FIRST_WEEK_GUIDES).toHaveLength(4)
    expect(new Set(FIRST_WEEK_GUIDES.map((g) => g.id)).size).toBe(4)
    expect(guideById('memory-and-connectors')?.minutes).toBeGreaterThan(0)
    expect(guideById(null)).toBeNull()
  })
})
