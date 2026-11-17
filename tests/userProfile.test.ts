/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DESTINATIONS, type Destination } from '../src/shared/url'
import {
  emptyProfile,
  habitRoutine,
  habitWhen,
  matchApps,
  profileFromAnswers,
  profileMemoryNote,
  profileSchema,
  workspacePlan,
  type PlanContext,
  type UserProfile,
} from '../src/shared/userProfile'

const DIRECTORY = [
  { id: 'notion', name: 'Notion', site: 'notion.so', category: 'work' },
  { id: 'atlassian', name: 'Atlassian', site: 'atlassian.com', category: 'work' },
  { id: 'github', name: 'GitHub', site: 'github.com', category: 'code' },
  { id: 'linear', name: 'Linear', site: 'linear.app', category: 'code' },
  { id: 'vercel', name: 'Vercel', site: 'vercel.com', category: 'code' },
  { id: 'figma', name: 'Figma', site: 'figma.com', category: 'design' },
  { id: 'canva', name: 'Canva', site: 'canva.com', category: 'design' },
]
const SKILLS = ['weekly-review', 'meeting-prep', 'research-brief', 'reading-digest', 'compare-options', 'price-watch', 'document-outline', 'trip-plan', 'brand-kit', 'page-summary']
const CTX: PlanContext = { directory: DIRECTORY, skills: SKILLS, companionId: 'companion-1', timeZone: 'Europe/Amsterdam' }
const DEFAULTS = Object.fromEntries(DESTINATIONS.map((d) => [d, ['chats', 'routines', 'connectors', 'skills', 'meetings'].includes(d)])) as Record<Destination, boolean>
const shown = (plan: { destinations: Record<Destination, boolean> }): string[] => DESTINATIONS.filter((d) => plan.destinations[d])

const profile = (patch: Partial<UserProfile>): UserProfile => ({ ...emptyProfile(1), ...patch })
const weekly = { what: 'Plan the week', prompt: 'Help me plan my week from my calendar and open tabs.', days: [1], time: '09:00', skill: 'weekly-review' }

describe('your profile', () => {
  it('checks a profile, and turns the setup cards into one', () => {
    expect(profileSchema.safeParse(emptyProfile(5)).success).toBe(true)
    expect(profileSchema.safeParse({ ...emptyProfile(5), techLevel: 'wizard' }).success).toBe(false)
    expect(profileSchema.safeParse({ ...emptyProfile(5), habits: [{ ...weekly, time: '9am' }] }).success).toBe(false)
    const p = profileFromAnswers({ 'call-you': ' Sam ', work: 'I run a small bakery', 'use-cases': ['meetings', 'shopping', 'Bookkeeping'], 'reply-style': 'short', 'hands-on': 'simple' }, 7)
    expect(p).toMatchObject({ updatedAt: 7, name: 'Sam', work: 'I run a small bakery', interests: ['meetings', 'shopping'], goals: ['Bookkeeping'], replyStyle: 'short', techLevel: 'simple' })
    expect(profileSchema.safeParse(p).success).toBe(true)
  })

  it('writes the About me note companions read, only from what you said', () => {
    expect(profileMemoryNote(emptyProfile(1))).toBeNull()
    const note = profileMemoryNote(profile({ name: 'Sam', techLevel: 'technical', habits: [weekly], apps: ['Notion', 'Gmail'] }))!
    expect(note).toContain('- Name: Sam')
    expect(note).toContain('technical, skip the basics')
    expect(note).toContain('Plan the week (Mondays at 09:00)')
    expect(note).toContain('- Uses: Notion, Gmail')
    expect(habitWhen({ days: [1, 2, 3, 4, 5], time: '08:30' })).toBe('weekdays at 08:30')
    expect(habitWhen({ days: [], time: '18:00' })).toBe('every day at 18:00')
  })

  it('matches the apps you named to connectors, and leaves the rest for later', () => {
    expect(matchApps(['Notion', 'jira', 'Gmail', 'figma.com', 'x'], DIRECTORY)).toEqual(['notion', 'atlassian', 'figma'])
    expect(matchApps(['GitHub', 'github'], DIRECTORY)).toEqual(['github'])
  })

  it('offers a habit as a routine on its days, with its skill only when Apex has it', () => {
    expect(habitRoutine(weekly, CTX)).toEqual({ name: 'Plan the week', prompt: weekly.prompt, schedule: { kind: 'daily', time: '09:00', days: [1] }, companionId: 'companion-1', timeZone: 'Europe/Amsterdam', skillId: 'weekly-review' })
    expect(habitRoutine({ ...weekly, skill: 'made-up', days: [5, 1, 5] }, CTX)).not.toHaveProperty('skillId')
    expect(habitRoutine({ ...weekly, days: [5, 1, 5] }, CTX).schedule).toEqual({ kind: 'daily', time: '09:00', days: [1, 5] })
  })
})

describe('the workspace your profile asks for', () => {
  it('keeps today’s defaults when the profile says nothing', () => {
    const plan = workspacePlan(emptyProfile(1), CTX, DEFAULTS)
    expect(plan.destinations).toEqual(DEFAULTS)
    expect(plan.showcase).toHaveLength(6)
    expect(plan.routines).toEqual([])
    expect(plan.connectors).toEqual([])
  })

  it('keeps a technical sidebar to chats and what they do on a rhythm, with no showcase', () => {
    const plan = workspacePlan(profile({ techLevel: 'technical', interests: ['coding', 'research'], habits: [weekly] }), CTX, DEFAULTS)
    expect(shown(plan)).toEqual(['chats', 'routines'])
    expect(plan.showcase).toEqual([])
    expect(plan.guided).toBe(false)
    expect(plan.connectors).toEqual(['github', 'linear', 'vercel'])
    expect(plan.routines.map((r) => r.draft.name)).toEqual(['Plan the week'])
  })

  it('gives a simple setup only what it picked, the guides, and no app it didn’t name', () => {
    const plan = workspacePlan(profile({ techLevel: 'simple', interests: ['meetings', 'shopping', 'design'] }), CTX, DEFAULTS)
    expect(shown(plan)).toEqual(['chats', 'meetings', 'guides'])
    expect(plan.guided).toBe(true)
    expect(plan.connectors).toEqual([])
    expect(plan.skills).toEqual(['meeting-prep', 'compare-options', 'price-watch', 'brand-kit'])
    expect(plan.showcase).toEqual(['tabs', 'meetings', 'memory'])
  })

  it('shows a mixed setup the rows its interests and apps need, and the apps it named first', () => {
    const plan = workspacePlan(profile({ techLevel: 'mixed', interests: ['writing', 'projects', 'design'], apps: ['Notion'] }), CTX, DEFAULTS)
    expect(shown(plan)).toEqual(['chats', 'skills', 'workspace'])
    expect(plan.connectors).toEqual(['notion'])
    expect(plan.showcase).toEqual(['tabs', 'documents', 'memory'])
  })
})
