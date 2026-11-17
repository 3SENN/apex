/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { arrivalDelays, ARRIVAL_MS, buildIdeaPages, buildInbox, clampPage, IDEAS_PER_PAGE, inboxUnread, pagerState, type IdeaSources } from '../src/renderer/src/components/newtab/newtabLogic'

const sources = (over: Partial<IdeaSources> = {}): IdeaSources => ({ companionName: 'Pip', skills: [], routines: [], tabs: [], dismissed: new Set(), ...over })

describe('ideas card (DS-109)', () => {
  it('starts with Atelier’s own starters, four rows a page', () => {
    const pages = buildIdeaPages(sources())
    expect(pages.length).toBeGreaterThanOrEqual(2)
    for (const page of pages) expect(page.ideas.length).toBeLessThanOrEqual(IDEAS_PER_PAGE)
    expect(pages[0]!.ideas).toHaveLength(IDEAS_PER_PAGE)
    expect(pages[0]!.description).toContain('Pip')
  })

  it('adds pages from your tabs, skills and routines, built locally', () => {
    const pages = buildIdeaPages(
      sources({
        tabs: [
          { id: 't1', title: 'Weather in Ghent', url: 'https://weather.example/ghent' },
          { id: 't2', title: 'Trains', url: 'https://trains.example' },
          { id: 't3', title: 'Settings', url: 'atelier://settings' },
        ],
        skills: [{ id: 's1', name: 'recap', description: '' }],
        routines: [{ id: 'r1', name: 'Morning news', prompt: 'Three headlines', enabled: true }],
      }),
    )
    const tabs = pages.find((p) => p.id === 'tabs')!
    expect(tabs.ideas.map((i) => i.label)).toEqual(['Summarise Weather in Ghent', 'Summarise Trains', 'Compare two of my tabs'])
    expect(tabs.ideas.every((i) => i.oneShot)).toBe(true)
    const skills = pages.find((p) => p.id === 'skills')!
    expect(skills.ideas[0]).toMatchObject({ label: '/recap', oneShot: false })
    expect(skills.seeAll?.url).toBe('atelier://skills')
    expect(pages.find((p) => p.id === 'routines')!.ideas[0]).toMatchObject({ prompt: 'Three headlines', oneShot: true })
  })

  it('leaves out dismissed ideas and drops pages that empty out', () => {
    const all = buildIdeaPages(sources({ skills: [{ id: 's1', name: 'recap', description: '' }] }))
    const first = all[0]!.ideas[0]!.id
    const after = buildIdeaPages(sources({ skills: [{ id: 's1', name: 'recap', description: '' }], dismissed: new Set([first, 'skill:s1']) }))
    expect(after.flatMap((p) => p.ideas).some((i) => i.id === first)).toBe(false)
    expect(after.some((p) => p.id === 'skills')).toBe(false)
  })

  it('pages on the strip with previous disabled at the start and next at the end (DS-142)', () => {
    expect(pagerState(0, 3)).toEqual({ canPrev: false, canNext: true })
    expect(pagerState(2, 3)).toEqual({ canPrev: true, canNext: false })
    expect(pagerState(0, 1)).toEqual({ canPrev: false, canNext: false })
    expect(clampPage(5, 3)).toBe(2)
    expect(clampPage(-1, 3)).toBe(0)
    expect(clampPage(2, 0)).toBe(0)
  })
})

describe('notifications inbox (DS-112)', () => {
  const inbox = buildInbox({
    chats: [
      { id: 'c1', title: 'Fill the form', updatedAt: 300, needsInput: true },
      { id: 'c2', title: 'Quiet chat', updatedAt: 900, needsInput: false },
    ],
    runs: [
      { id: 'r1', routineId: 'daily', chatId: 'c9', startedAt: 100, finishedAt: 200, status: 'ok', read: true },
      { id: 'r2', routineId: 'daily', chatId: null, startedAt: 400, finishedAt: 500, status: 'error', read: false },
      { id: 'r3', routineId: 'gone', chatId: null, startedAt: 600, finishedAt: null, status: 'running', read: false },
    ],
    routineNames: new Map([['daily', 'Morning news']]),
  })

  it('lists pending approvals and finished routine results, newest first', () => {
    expect(inbox.map((i) => i.id)).toEqual(['run:r2', 'chat:c1', 'run:r1'])
    expect(inbox[0]).toMatchObject({ title: 'Morning news', detail: 'Something went wrong', unread: true })
    expect(inbox[1]).toMatchObject({ kind: 'approval', chatId: 'c1', unread: true })
  })

  it('counts unread for the dot; approvals always count', () => {
    expect(inboxUnread(inbox)).toBe(2)
    expect(inboxUnread([])).toBe(0)
  })
})

describe('staged arrival (DS-111)', () => {
  it('brings the composer before the figure and the ideas card last, at once under Reduce Motion', () => {
    const d = arrivalDelays(false)
    expect(d.composer).toBeLessThan(d.figure)
    expect(d.figure).toBeLessThan(d.ideas)
    expect(d.ideas).toBeLessThan(d.inbox)
    expect(ARRIVAL_MS.ideas).toBeGreaterThanOrEqual(800)
    expect(Object.values(arrivalDelays(true)).every((v) => v === 0)).toBe(true)
  })
})
