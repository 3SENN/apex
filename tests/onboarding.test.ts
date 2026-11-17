/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SETUP_QUESTIONS,
  SETUP_STEPS,
  answerText,
  applySetupPatch,
  firstChatSeed,
  freshSetupState,
  initialQuestions,
  nextSetupStep,
  previousSetupStep,
  questionAnswered,
  questionsReducer,
  rankConnectorSuggestions,
  setupMemoryNote,
  suggestNames,
} from '@shared/onboarding'
import { log } from '../src/main/log'
import { NOTICE_INVALID, NOTICE_NEWER, SetupStore, createOnboardingService, loadSetupState, type ProfileDeps } from '../src/main/onboarding'
import { UserProfileStore } from '../src/main/userProfile'
import { DESTINATIONS, type Destination } from '../src/shared/url'
import { FakeHost } from './helpers/fakeHost'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-setup-'))

/** Your profile's deps with a fake quick model (`reply` answers each json call) and recorded writes. */
function profileDeps(dir: string, reply: (system: string, prompt: string) => unknown = () => ({ say: 'Hi!', chips: [], multi: false, done: false }), ready = true) {
  const writes = { notes: [] as Array<{ path: string; text: string }>, routines: [] as unknown[], destinations: [] as Array<Record<Destination, boolean>> }
  let rows = Object.fromEntries(DESTINATIONS.map((d) => [d, ['chats', 'routines', 'connectors', 'skills', 'meetings'].includes(d)])) as Record<Destination, boolean>
  const deps: ProfileDeps = {
    store: new UserProfileStore(dir),
    quick: {
      ready: async () => ({ ok: ready, engine: ready ? ('api-key' as const) : null }),
      json: async (r) => r.schema.parse(reply(r.system, r.prompt)),
    },
    companionName: () => 'Pip',
    language: () => 'en',
    skills: () => ['weekly-review', 'meeting-prep'],
    directory: () => [{ id: 'notion', name: 'Notion', site: 'notion.so', category: 'work' }],
    destinations: () => rows,
    setDestinations: (next) => {
      rows = next
      writes.destinations.push(next)
    },
    saveRoutine: (draft) => void writes.routines.push(draft),
    timeZone: () => 'Europe/Amsterdam',
    writeMemory: (path, text) => void writes.notes.push({ path, text }),
  }
  return { deps, writes }
}

describe('setup steps', () => {
  it('runs the fixed sequence forward and back', () => {
    expect(SETUP_STEPS[0]).toBe('intro')
    expect(SETUP_STEPS.at(-1)).toBe('launch')
    expect(nextSetupStep('intro')).toBe('name')
    expect(nextSetupStep('layout')).toBe('questions')
    expect(nextSetupStep('launch')).toBeNull()
    expect(previousSetupStep('intro')).toBeNull()
    expect(previousSetupStep('showcase')).toBe('import-ai')
  })

  it('merges answers, marks visited steps and clears the notice', () => {
    const start = freshSetupState(1, null, 'reset')
    const next = applySetupPatch(start, { step: 'name', answers: { 'call-you': 'Ada' } }, 2)
    expect(next.visited).toEqual(['intro', 'name'])
    expect(next.answers['call-you']).toBe('Ada')
    expect(next.notice).toBeNull()
    expect(next.updatedAt).toBe(2)
    const again = applySetupPatch(next, { step: 'name', answers: { 'call-you': null } }, 3)
    expect(again.visited).toEqual(['intro', 'name'])
    expect(again.answers['call-you']).toBeNull()
  })
})

describe('setup persistence', () => {
  it('saves after every step and resumes after a restart', () => {
    const dir = tempDir()
    const a = new SetupStore({ dataDir: dir, now: () => 10 })
    a.save({ step: 'look', answers: { 'call-you': 'Ada' }, companionId: 'c1' })
    a.goTo('layout')
    const b = new SetupStore({ dataDir: dir, now: () => 20 })
    expect(b.state().step).toBe('layout')
    expect(b.state().visited).toEqual(['intro', 'look', 'layout'])
    expect(b.state().companionId).toBe('c1')
    expect(b.state().answers['call-you']).toBe('Ada')
  })

  it('resets an invalid file with a notice', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'setup.json'), '{ not json')
    const store = new SetupStore({ dataDir: dir, now: () => 5 })
    expect(store.state().step).toBe('intro')
    expect(store.state().notice).toBe(NOTICE_INVALID)
    expect(loadSetupState({ version: 1, step: 'nowhere' }, 1).notice).toBe(NOTICE_INVALID)
  })

  it('resets a file from a newer Atelier with its own notice', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'setup.json'), JSON.stringify({ version: 2, step: 'launch' }))
    const store = new SetupStore({ dataDir: dir })
    expect(store.state().notice).toBe(NOTICE_NEWER)
    expect(JSON.parse(readFileSync(join(dir, 'setup.json'), 'utf8')).version).toBe(1)
  })

  it('skips the rest and starts over, with or without a new companion', () => {
    const store = new SetupStore({ dataDir: tempDir(), now: () => 1 })
    store.save({ step: 'questions', companionId: 'c1', answers: { work: 'design' } })
    store.skipRest()
    expect(store.state().step).toBe('launch')
    expect(store.state().skipped).toBe(true)
    expect(store.restart({ newCompanion: false }).companionId).toBe('c1')
    store.save({ answers: { work: 'x' } })
    const fresh = store.restart({ newCompanion: true })
    expect(fresh.companionId).toBeNull()
    expect(fresh.answers).toEqual({})
    expect(fresh.step).toBe('intro')
  })

  it('broadcasts each change', () => {
    const seen: string[] = []
    const store = new SetupStore({ dataDir: tempDir(), onChange: (s) => seen.push(s.step) })
    store.goTo('name')
    store.goTo('look')
    expect(seen).toEqual(['name', 'look'])
  })
})

describe('the onboarding service', () => {
  afterEach(() => vi.restoreAllMocks())

  it('logs a warning when a step times out', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const service = createOnboardingService({ store: new SetupStore({ dataDir: tempDir() }), host: new FakeHost(), activeCompanionId: () => 'c1', companionExists: () => true, profile: profileDeps(tempDir()).deps })
    service.stepTimeout('connectors')
    expect(warn).toHaveBeenCalledWith('onboarding', expect.any(String), expect.objectContaining({ step: 'connectors' }))
  })

  it('launches the first chat seeded from the answers, and reports failure', async () => {
    const host = new FakeHost()
    const store = new SetupStore({ dataDir: tempDir() })
    store.save({ companionId: 'gone', answers: { 'call-you': 'Ada', 'first-tool': 'plan-trip', 'use-cases': ['travel'] } })
    const service = createOnboardingService({ store, host, activeCompanionId: () => 'c1', companionExists: (id) => id === 'c1', profile: profileDeps(tempDir()).deps })
    const result = await service.launch()
    expect(result.ok).toBe(true)
    expect(host.startedChats[0]?.text).toContain('trip')
    expect(host.startedChats[0]?.options).toMatchObject({ companionId: 'c1', open: 'page' })
    expect(host.startedChats[0]?.options?.context).toContain('<setup_answers>')
    expect(store.state().finishedAt).not.toBeNull()

    vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    host.failWith = new Error('offline')
    const failed = await service.launch()
    expect(failed).toEqual({ ok: false, chatId: null, error: 'offline' })
  })
})

describe('name suggestions', () => {
  it('gives distinct names, repeatable per seed, never an excluded one', () => {
    const a = suggestNames(7, 4)
    expect(new Set(a).size).toBe(4)
    expect(suggestNames(7, 4)).toEqual(a)
    expect(suggestNames(8, 4)).not.toEqual(a)
    const first = a[0] as string
    expect(suggestNames(7, 40, [first.toUpperCase()])).not.toContain(first)
  })
})

describe('the question cards', () => {
  const reduce = questionsReducer(SETUP_QUESTIONS)
  const indexOf = (id: string): number => SETUP_QUESTIONS.findIndex((q) => q.id === id)

  it('answers, skips, goes back and resumes at the first unanswered card', () => {
    let s = initialQuestions()
    expect(s.index).toBe(0)
    s = reduce(s, { type: 'next' })
    expect(s.answers['welcome-note']).toBe('seen')
    s = reduce(s, { type: 'set', id: 'call-you', value: 'Ada' })
    s = reduce(s, { type: 'next' })
    s = reduce(s, { type: 'skip' })
    expect(s.answers['time-zone']).toBeNull()
    expect(s.skipped).toEqual(['time-zone'])
    s = reduce(s, { type: 'back' })
    expect(s.index).toBe(indexOf('time-zone'))
    expect(initialQuestions(s.answers).index).toBe(indexOf('use-cases'))
  })

  it('toggles multiple choice and folds Other into the answer', () => {
    let s = initialQuestions({}, SETUP_QUESTIONS)
    s = reduce(s, { type: 'jump', index: indexOf('use-cases') })
    const q = SETUP_QUESTIONS[indexOf('use-cases')]!
    expect(questionAnswered(q, s)).toBe(false)
    s = reduce(s, { type: 'toggle', id: 'use-cases', option: 'research' })
    s = reduce(s, { type: 'toggle', id: 'use-cases', option: 'travel' })
    s = reduce(s, { type: 'toggle', id: 'use-cases', option: 'research' })
    s = reduce(s, { type: 'other', id: 'use-cases', text: 'Gardening' })
    s = reduce(s, { type: 'next' })
    expect(s.answers['use-cases']).toEqual(['travel', 'other:Gardening'])
    expect(answerText(q, s.answers['use-cases'])).toBe('Travel plans, Gardening')
  })

  it('writes only real answers to the memory note and the first chat', () => {
    expect(setupMemoryNote({ 'welcome-note': 'seen', 'time-zone': null })).toBeNull()
    const note = setupMemoryNote({ 'call-you': 'Ada', 'reply-style': 'short', work: 'teaching' })
    expect(note).toContain('- Name: Ada')
    expect(note).toContain('Short and to the point')
    expect(note).not.toContain('Time zone')
    const seed = firstChatSeed({ 'call-you': 'Ada' })
    expect(seed.text).toContain('Ada')
    expect(firstChatSeed({}).context).toBeNull()
  })
})

describe('connector suggestions', () => {
  it('ranks directory entries by visits in imported history, keeping order otherwise', () => {
    const entries = [{ id: 'notion', site: 'notion.so' }, { id: 'github', site: 'https://github.com' }, { id: 'figma', site: 'www.figma.com' }]
    expect(rankConnectorSuggestions(entries).map((e) => e.id)).toEqual(['notion', 'github', 'figma'])
    expect(rankConnectorSuggestions(entries, { 'gist.github.com': 3, 'www.figma.com': 9 }).map((e) => e.id)).toEqual(['figma', 'github', 'notion'])
    expect(rankConnectorSuggestions(entries, {}, 2)).toHaveLength(2)
  })
})

describe('history suggestions', () => {
  it('counts visits per host and suggests the most visited sites', async () => {
    const { favoriteSuggestions, hostVisits } = await import('@shared/onboarding')
    const items = [
      { url: 'https://www.example.com/a', visits: 3 },
      { url: 'https://example.com/b', visits: 2 },
      { url: 'https://news.site/x', visits: 9 },
      { url: 'atelier://settings', visits: 50 },
      { url: 'not a url', visits: 1 },
    ]
    expect(hostVisits(items)).toEqual({ 'example.com': 5, 'news.site': 9 })
    expect(favoriteSuggestions(items, 1)).toEqual([{ host: 'news.site', url: 'https://news.site/', visits: 9 }])
  })
})

describe('the setup conversation and your profile (ON-18)', () => {
  const service = (dir: string, deps: ProfileDeps) => createOnboardingService({ store: new SetupStore({ dataDir: dir }), host: new FakeHost(), activeCompanionId: () => 'c1', companionExists: () => true, profile: deps })

  it('has no conversation without an engine, so setup shows the question cards', async () => {
    const dir = tempDir()
    expect(await service(dir, profileDeps(dir, undefined, false).deps).interviewTurn([])).toBeNull()
  })

  it('asks one thing at a time with quick replies, and wraps up after seven questions', async () => {
    const dir = tempDir()
    const prompts: string[] = []
    const { deps } = profileDeps(dir, (_system, prompt) => {
      prompts.push(prompt)
      return { say: ' What do you do? ', chips: ['Design', 'Design', ' Teaching '], multi: false, done: false }
    })
    const s = service(dir, deps)
    expect(await s.interviewTurn([])).toEqual({ say: 'What do you do?', chips: ['Design', 'Teaching'], multi: false, done: false })
    const seven = Array.from({ length: 7 }, (_, i) => [{ from: 'companion' as const, text: `Question ${i}` }, { from: 'you' as const, text: `Answer ${i}` }]).flat()
    expect(await s.interviewTurn(seven)).toMatchObject({ chips: [], done: true })
    expect(prompts.at(-1)).toContain('wrap up now')
  })

  it('turns the conversation into your profile, saves it with the About me note and plans your workspace', async () => {
    const dir = tempDir()
    const { deps, writes } = profileDeps(dir, () => ({
      name: null,
      work: 'Product designer',
      techLevel: 'mixed',
      interests: ['design', 'meetings', 'routines'],
      goals: ['Faster handoffs'],
      habits: [{ what: 'Plan the week', prompt: 'Plan my week with me.', days: [1, 1, 9], time: '09:00', skill: 'weekly-review' }, { what: 'Bad', prompt: 'x', days: [], time: 'noon', skill: null }],
      apps: ['Notion', 'Slack'],
      replyStyle: 'short',
    }))
    const store = new SetupStore({ dataDir: dir })
    store.save({ answers: { 'call-you': 'Ada' } })
    const s = createOnboardingService({ store, host: new FakeHost(), activeCompanionId: () => 'c1', companionExists: () => true, profile: deps })
    const { profile, plan } = await s.finishInterview([{ from: 'companion', text: 'What do you do?' }, { from: 'you', text: 'I design apps and use Notion and Slack.' }])
    expect(profile).toMatchObject({ name: 'Ada', work: 'Product designer', techLevel: 'mixed', apps: ['Notion', 'Slack'] })
    expect(profile.habits).toEqual([{ what: 'Plan the week', prompt: 'Plan my week with me.', days: [1], time: '09:00', skill: 'weekly-review' }])
    expect(s.profile()).toEqual(profile)
    expect(writes.notes[0]?.path).toBe('/memories/about-me.md')
    expect(writes.notes[0]?.text).toContain('Plan the week (Mondays at 09:00)')
    expect(plan.connectors).toEqual(['notion'])
    expect(plan.destinations).toMatchObject({ chats: true, meetings: true, routines: true, connectors: false })
    expect(plan.routines[0]?.draft).toMatchObject({ name: 'Plan the week', companionId: 'c1', skillId: 'weekly-review' })
    // A profile survives a restart.
    expect(new UserProfileStore(dir).get()).toEqual(profile)
  })

  it('falls back to the cards’ answers when the conversation can’t become a profile', async () => {
    const dir = tempDir()
    vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const { deps } = profileDeps(dir, () => ({ nonsense: true }))
    const store = new SetupStore({ dataDir: dir })
    store.save({ answers: { 'call-you': 'Ada', 'use-cases': ['meetings'], 'hands-on': 'simple' } })
    const s = createOnboardingService({ store, host: new FakeHost(), activeCompanionId: () => 'c1', companionExists: () => true, profile: deps })
    const { profile, plan } = await s.finishInterview([{ from: 'you', text: 'Hello' }])
    expect(profile).toMatchObject({ name: 'Ada', interests: ['meetings'], techLevel: 'simple' })
    expect(plan.guided).toBe(true)
  })

  it('applies what the review kept: the sidebar rows and only the routines you ticked', async () => {
    const dir = tempDir()
    const { deps, writes } = profileDeps(dir, () => ({ name: 'Ada', work: null, techLevel: 'technical', interests: ['coding'], goals: [], habits: [{ what: 'Standup notes', prompt: 'Draft my standup.', days: [1, 2, 3, 4, 5], time: '09:30', skill: null }, { what: 'Weekly review', prompt: 'Review my week.', days: [5], time: '16:00', skill: 'weekly-review' }], apps: [], replyStyle: null }))
    const s = service(dir, deps)
    expect(s.applyPlan({ destinations: {}, routines: [] })).toEqual({ routines: 0 })
    const { plan } = await s.finishInterview([{ from: 'you', text: 'I write code.' }])
    expect(s.applyPlan({ destinations: { meetings: true, chats: false }, routines: [plan.routines[1]!.id] })).toEqual({ routines: 1 })
    const rows = writes.destinations.at(-1)!
    expect(DESTINATIONS.filter((d) => rows[d])).toEqual(['chats', 'routines', 'meetings'])
    expect(writes.routines).toEqual([expect.objectContaining({ name: 'Weekly review', skillId: 'weekly-review' })])
  })
})
