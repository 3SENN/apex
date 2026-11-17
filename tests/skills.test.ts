/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHARED_OWNER } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { AppEvent } from '@shared/services'
import { filterSkills, skillSegment, type Skill } from '@shared/skills'
import type { ClientToolContext } from '../src/main/agent/tools/registry'
import { NOT_YET } from '../src/main/serviceKit'
import { RoutineStore } from '../src/main/routines/store'
import { skillRoutineTools } from '../src/main/routines/tools'
import { DRAFT_SYSTEM, createSkillsService, parseDraftReply, type SkillServiceDeps } from '../src/main/skills/service'
import { SkillStore } from '../src/main/skills/store'
import { FakeHost } from './helpers/fakeHost'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-skillsd-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface Harness {
  store: SkillStore
  host: FakeHost
  events: AppEvent[]
  trashed: string[]
  revealed: string[]
  picks: { open: string | null; save: string | null; folder: string | null }
  service: ReturnType<typeof createSkillsService>
}

function harness(options: { trash?: (id: string) => void } = {}): Harness {
  const store = new SkillStore(dir)
  const host = new FakeHost()
  const events: AppEvent[] = []
  const trashed: string[] = []
  const revealed: string[] = []
  const picks = { open: null as string | null, save: null as string | null, folder: null as string | null }
  const log: AgentEvent[] = [
    { type: 'user-message', text: 'Find three flights to Lisbon under €200 and compare them.' } as AgentEvent,
    { type: 'text-delta', text: 'Here are three options, compared by price and time.' } as AgentEvent,
  ]
  const deps: SkillServiceDeps = {
    store,
    host,
    chats: { summary: (id) => (id === 'chat-1' ? { title: 'Lisbon flights', createdAt: 1, companionId: 'ava' } : undefined), load: () => ({ log }) },
    companions: { find: (id) => (id === 'ava' ? { id, name: 'Ava' } : undefined), get: () => ({ id: 'ava', name: 'Ava' }) },
    startChatFallback: () => 'fallback-chat',
    broadcast: (e) => void events.push(e),
    trash: options.trash ?? ((id) => void trashed.push(id)),
    reveal: (path) => void revealed.push(path),
    dialogs: { saveFile: async () => picks.save, pickFolder: async () => picks.folder, openFile: async () => picks.open },
    writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
  }
  return { store, host, events, trashed, revealed, picks, service: createSkillsService(deps) }
}

describe('Save as skill from a chat', () => {
  it('drafts with the quick model, from the transcript, with Atelier’s own prompt', async () => {
    const h = harness()
    h.host.completeReplies = ['{"name":"flight-compare","description":"Compares flights for a trip.","instructions":"Find flights and compare them.","steps":[{"title":"Search","instructions":"Search three sites."}]}']
    const draft = await h.service.draftFromChat('chat-1')
    expect(draft).toEqual({ name: 'flight-compare', description: 'Compares flights for a trip.', instructions: 'Find flights and compare them.', steps: [{ id: 'step-1', title: 'Search', instructions: 'Search three sites.' }], owner: 'ava' })
    const call = h.host.completions[0]!
    expect(call.system).toBe(DRAFT_SYSTEM)
    expect(call.prompt).toContain('Lisbon')
    expect(call.companionId).toBe('ava')
    // Nothing is saved until the person confirms in the sheet.
    expect(h.store.list()).toHaveLength(0)
  })

  it('turns a messy reply into a usable draft, and refuses an unusable one', () => {
    expect(parseDraftReply('Sure! {"name":"Weekly Notes","instructions":"Do it"} done', 'x').name).toBe('weekly-notes')
    expect(() => parseDraftReply('no json here', 'x')).toThrow(/Couldn’t draft/)
    expect(() => parseDraftReply('{"name":"a"}', 'x')).toThrow(/Couldn’t draft/)
  })

  it('says so when the chat is gone or the model fails', async () => {
    const h = harness()
    await expect(h.service.draftFromChat('missing')).rejects.toThrow(/no longer exists/)
    h.host.failWith = new Error('offline')
    await expect(h.service.draftFromChat('chat-1')).rejects.toThrow('offline')
  })
})

describe('the draft_skill client tool', () => {
  const ctx = (events: AgentEvent[]): ClientToolContext => ({ chatId: 'c', companionId: 'ava', isPrivate: false, isRoutine: false, signal: new AbortController().signal, emit: (e) => void events.push(e), ask: () => Promise.reject(new Error('unused')) })

  it('shows a draft of the companion’s own skill without blocking or saving', async () => {
    const skills = new SkillStore(dir, { builtins: [] })
    const tool = skillRoutineTools({ routines: new RoutineStore(dir), skills }).find((t) => t.name === 'draft_skill')!
    const events: AgentEvent[] = []
    const result = await tool.run(tool.parse.parse({ name: 'trip-plan', description: 'Plans trips', instructions: 'Plan it.', steps: [{ title: 'Ask', instructions: 'Ask dates.' }] }), ctx(events))
    expect(result.content).toMatch(/Shown to the user as a draft of a skill of your own\. It is not saved/)
    const event = events[0] as Extract<AgentEvent, { type: 'skill-draft' }>
    expect(event.type).toBe('skill-draft')
    expect(event.draft).toMatchObject({ name: 'trip-plan', owner: 'ava', steps: [{ id: 'step-1', title: 'Ask' }] })
    expect(event.draft.updates).toBeUndefined()
    expect(skills.list()).toHaveLength(0)
  })

  it('changes a skill the companion already has, keeping steps it leaves out', async () => {
    const skills = new SkillStore(dir, { builtins: [] })
    const mine = skills.save({ name: 'trip-plan', description: 'Mine', instructions: 'x', steps: [{ id: 'step-1', title: 'Ask', instructions: 'Ask dates.' }], owner: 'ava' })
    const tool = skillRoutineTools({ routines: new RoutineStore(dir), skills }).find((t) => t.name === 'draft_skill')!
    const events: AgentEvent[] = []
    const result = await tool.run(tool.parse.parse({ name: 'trip-plan', description: 'Plans trips, cheaply', instructions: 'Plan it on a budget.' }), ctx(events))
    expect(result.content).toMatch(/a change to your skill \/trip-plan/)
    const event = events[0] as Extract<AgentEvent, { type: 'skill-draft' }>
    expect(event.draft).toMatchObject({ name: 'trip-plan', owner: 'ava', updates: mine.id, steps: [{ title: 'Ask', instructions: 'Ask dates.' }] })
    // Saving the draft the way the card does updates that skill instead of failing on its name.
    const saved = skills.save({ id: event.draft.updates, name: event.draft.name, description: event.draft.description, instructions: event.draft.instructions, steps: event.draft.steps, owner: event.draft.owner })
    expect(saved.id).toBe(mine.id)
    expect(skills.list()).toHaveLength(1)
    expect(skills.require(mine.id)).toMatchObject({ instructions: 'Plan it on a budget.', steps: [{ title: 'Ask' }] })
  })

  it('gives the companion its own version of a shared skill, never changing the shared one', async () => {
    const skills = new SkillStore(dir, { builtins: [] })
    const shared = skills.save({ name: 'trip-plan', description: 'Everyone’s', instructions: 'x' })
    const tool = skillRoutineTools({ routines: new RoutineStore(dir), skills }).find((t) => t.name === 'draft_skill')!
    const events: AgentEvent[] = []
    const result = await tool.run(tool.parse.parse({ name: 'trip-plan', description: 'Mine', instructions: 'My way.' }), ctx(events))
    expect(result.content).toMatch(/instead of the shared one/)
    const event = events[0] as Extract<AgentEvent, { type: 'skill-draft' }>
    expect(event.draft.updates).toBeUndefined()
    const own = skills.save({ ...event.draft })
    expect(own.owner).toBe('ava')
    expect(skills.require(shared.id).instructions).toBe('x')
    expect(skills.resolve('trip-plan', 'ava')?.id).toBe(own.id)
    expect(skills.resolve('trip-plan', 'bo')?.id).toBe(shared.id)
  })

  it('reads the companion’s own skill, a shared one and a supporting file, never another companion’s', async () => {
    const skills = new SkillStore(dir, { builtins: [] })
    const mine = skills.save({ name: 'trip-plan', description: 'Plans trips', instructions: 'Plan it.', owner: 'ava' })
    skills.writeFile(mine.id, 'airlines.md', 'KLM first.')
    skills.save({ name: 'recap', description: 'Recaps', instructions: 'Recap it.' })
    skills.save({ name: 'secret', description: 'Bo’s own', instructions: 'Bo only.', owner: 'bo' })
    const tool = skillRoutineTools({ routines: new RoutineStore(dir), skills }).find((t) => t.name === 'read_skill')!
    const own = JSON.parse((await tool.run(tool.parse.parse({ name: '/trip-plan' }), ctx([]))).content)
    expect(own).toMatchObject({ name: 'trip-plan', whose: 'yours', instructions: 'Plan it.', files: ['airlines.md'] })
    expect(own).not.toHaveProperty('note')
    const shared = JSON.parse((await tool.run(tool.parse.parse({ name: 'recap' }), ctx([]))).content)
    expect(shared).toMatchObject({ whose: 'shared', note: expect.stringMatching(/your own version/) })
    expect((await tool.run(tool.parse.parse({ name: 'trip-plan', file: 'airlines.md' }), ctx([]))).content).toBe('KLM first.')
    const other = await tool.run(tool.parse.parse({ name: 'secret' }), ctx([]))
    expect(other.isError).toBe(true)
    expect(other.content).toMatch(/Yours: \/trip-plan/)
  })

  it('refuses a draft with no instructions', async () => {
    const tool = skillRoutineTools({ routines: new RoutineStore(dir), skills: new SkillStore(dir, { builtins: [] }) }).find((t) => t.name === 'draft_skill')!
    const result = await tool.run(tool.parse.parse({ name: 'x', description: 'd', instructions: ' ' }), ctx([]))
    expect(result.isError).toBe(true)
  })
})

describe('the skills service', () => {
  it('sends a deleted skill to Recently Deleted, and refuses built-ins', () => {
    const h = harness()
    const s = h.service.save({ name: 'mine', description: 'Mine', instructions: 'Do it.' })
    h.service.remove(s.id)
    expect(h.trashed).toEqual([s.id])
    expect(h.service.list().some((x) => x.id === s.id)).toBe(false)
    const builtin = h.service.list({ source: 'builtin' })[0]!
    expect(() => h.service.remove(builtin.id)).toThrow(/Built-in/)
  })

  it('deletes outright while Recently Deleted is not in yet', () => {
    const h = harness({ trash: () => { throw new Error(NOT_YET) } })
    const s = h.service.save({ name: 'mine', description: 'Mine', instructions: 'Do it.' })
    h.service.remove(s.id)
    expect(h.store.get(s.id)).toBeUndefined()
  })

  it('runs a skill as /name in a new chat, as its companion', () => {
    const h = harness()
    const s = h.service.save({ name: 'mine', description: 'Mine', instructions: 'Do it.', owner: 'ava' })
    const chatId = h.service.run(s.id)
    expect(h.host.startedChats[0]).toMatchObject({ chatId, text: '/mine', options: { companionId: 'ava' } })
    expect(() => h.service.run(s.id, 'nobody')).toThrow(/no longer exists/)
  })

  it('imports a .md, rejecting empty files and name clashes with the reason', async () => {
    const h = harness()
    const good = join(dir, 'Price Check.md')
    writeFileSync(good, '# Price check\nCompare the price on three shops.')
    h.picks.open = good
    const imported = await h.service.importFile()
    expect(imported).toMatchObject({ name: 'price-check', description: 'Price check', owner: SHARED_OWNER })
    await expect(h.service.importFile()).rejects.toThrow(/already exists/)
    const empty = join(dir, 'empty.md')
    writeFileSync(empty, '   ')
    h.picks.open = empty
    await expect(h.service.importFile()).rejects.toThrow(/empty/)
    h.picks.open = null
    expect(await h.service.importFile()).toBeNull()
  })

  it('exports SKILL.md, or the whole folder when it has files', async () => {
    const h = harness()
    const s = h.service.save({ name: 'mine', description: 'Mine', instructions: 'Do it.' })
    h.picks.save = join(dir, 'out.md')
    expect(await h.service.exportFile(s.id)).toBe(h.picks.save)
    expect(readFileSync(h.picks.save, 'utf8')).toMatch(/name: mine/)
    h.service.addFile(s.id, 'notes.txt', Buffer.from('hi').toString('base64'))
    expect(h.events).toContainEqual({ type: 'skill-files', skillId: s.id })
    h.picks.folder = join(dir)
    const out = await h.service.exportFile(s.id)
    expect(readFileSync(join(out!, 'notes.txt'), 'utf8')).toBe('hi')
  })

  it('reveals a skill’s folder in Finder, but not a built-in', () => {
    const h = harness()
    const s = h.service.save({ name: 'mine', description: 'Mine', instructions: 'Do it.' })
    h.service.reveal(s.id)
    expect(h.revealed[0]).toMatch(/mine[\\/]SKILL\.md$/)
    expect(() => h.service.reveal(h.service.list({ source: 'builtin' })[0]!.id)).toThrow(/Duplicate/)
  })
})

describe('the Skills page’s filters', () => {
  const skill = (over: Partial<Skill>): Skill => ({ id: 'x', name: 'x', description: '', instructions: '', steps: [], owner: SHARED_OWNER, source: 'user', builtinVersion: null, createdAt: 0, updatedAt: 0, lastUsedAt: null, files: [], ...over })
  const list = [
    skill({ id: 'a', name: 'alpha', updatedAt: 10, lastUsedAt: 5 }),
    skill({ id: 'b', name: 'bravo', owner: 'ava', updatedAt: 30, description: 'flights' }),
    skill({ id: 'c', name: 'charlie', source: 'builtin', builtinVersion: '1', lastUsedAt: 50 }),
  ]

  it('groups yours, companions’ and built-in', () => {
    expect(list.map((s) => skillSegment(s))).toEqual(['yours', 'companions', 'builtin'])
    expect(filterSkills(list, { source: 'companions' }).map((s) => s.id)).toEqual(['b'])
  })

  it('searches, filters by owner and date, and sorts', () => {
    expect(filterSkills(list, { query: 'flights' }).map((s) => s.id)).toEqual(['b'])
    expect(filterSkills(list, { owner: 'ava' }).map((s) => s.id)).toEqual(['b'])
    expect(filterSkills(list, { updatedSince: 20 }).map((s) => s.id)).toEqual(['b'])
    expect(filterSkills(list, { sort: 'recent-use' }).map((s) => s.id)).toEqual(['c', 'a', 'b'])
    expect(filterSkills(list, { sort: 'recent-update' }).map((s) => s.id)).toEqual(['b', 'a', 'c'])
    expect(filterSkills(list, { sort: 'name' }).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })
})

// ---- the editor's logic (renderer, companion-card/logic/skills.ts) ----
import * as F from '../src/renderer/src/companion-card/logic/skills'

describe('the skill form', () => {
  const form = (patch: Partial<F.SkillForm> = {}): F.SkillForm => ({ name: 'trip-plan', description: 'Plans a trip.', instructions: 'Plan it.', steps: [], owner: SHARED_OWNER, ...patch })

  it('gives each field its own message', () => {
    expect(F.skillFormErrors(form())).toEqual({})
    expect(F.skillFormErrors(form({ name: '' })).name).toMatch(/\/name/)
    expect(F.skillFormErrors(form({ name: '-bad' })).name).toMatch(/lowercase/)
    expect(F.skillFormErrors(form({ description: ' ' })).description).toMatch(/what the skill is for/)
    expect(F.skillFormErrors(form({ description: 'x'.repeat(501) })).description).toMatch(/500/)
    expect(F.skillFormErrors(form({ instructions: '' })).instructions).toMatch(/add a step/)
    expect(F.skillFormErrors(form({ instructions: '', steps: [{ id: 's', title: 'Go', instructions: '' }] }))).toEqual({})
  })

  it('notices real changes only', () => {
    expect(F.skillFormDirty(form(), form({ description: ' Plans a trip. ' }))).toBe(false)
    expect(F.skillFormDirty(form(), form({ steps: [{ id: 's', title: '', instructions: '' }] }))).toBe(false)
    expect(F.skillFormDirty(form(), form({ owner: 'ava' }))).toBe(true)
  })

  it('moves steps and makes unique ids', () => {
    expect(F.moveStep(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(F.moveStep(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
    const ids = new Set(Array.from({ length: 20 }, () => F.newStepId([])))
    expect(ids.size).toBe(20)
  })

  it('labels sizes and update windows', () => {
    expect(F.fileSizeLabel(900)).toBe('900 B')
    expect(F.fileSizeLabel(12_000)).toBe('12 KB')
    expect(F.fileSizeLabel(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(F.updatedSince('any', 1000)).toBeUndefined()
    expect(F.updatedSince('week', 10 * 86_400_000)).toBe(3 * 86_400_000)
  })

  it('builds the save input without empty steps', () => {
    expect(F.skillFormInput(form({ steps: [{ id: 's1', title: ' Go ', instructions: '' }, { id: 's2', title: '', instructions: '' }] }), 'id1')).toEqual({ id: 'id1', name: 'trip-plan', description: 'Plans a trip.', instructions: 'Plan it.', owner: SHARED_OWNER, steps: [{ id: 's1', title: 'Go', instructions: '' }] })
  })
})

describe('an edit without steps keeps them', () => {
  it('keeps steps when older callers leave them out', () => {
    const store = new SkillStore(dir, { builtins: [] })
    const s = store.save({ name: 'stepped', description: 'd', instructions: 'i', steps: [{ id: 'a', title: 'One', instructions: 'x' }] })
    expect(store.save({ id: s.id, name: 'stepped', description: 'd', instructions: 'i', owner: 'ava' }).steps).toHaveLength(1)
    expect(store.save({ id: s.id, name: 'stepped', description: 'd', instructions: 'i', steps: [] }).steps).toHaveLength(0)
  })
})
