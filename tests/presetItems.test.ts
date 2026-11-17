/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { EN } from '@shared/i18n/en'
import { NL } from '@shared/i18n/nl'
import { adjacentPresetItem, presetItem, routineStarterSkill, routinesUsingSkill, skillDetailBody } from '../src/renderer/src/companion-card/logic/presetProfile'

// A preset's detail views, one per starter skill or routine, opened
// from its profile and walked in the profile's order.

const detail = {
  starterSkills: [
    { name: 'fine-print', description: 'Reads the small print', instructions: 'Find the clauses.\n\nList them plainly.', steps: [{ id: 's1', title: 'Find', instructions: 'Scan the page.' }, { id: 's2', title: ' ', instructions: ' ' }] },
    { name: 'tab-tidy', description: 'Tidies tabs', instructions: '' },
  ],
  starterRoutines: [
    { name: 'Morning read', prompt: 'Use /fine-print on today’s terms.', schedule: { kind: 'daily' as const, time: '08:00', days: [1] } },
    { name: 'Weekly tidy', prompt: 'Tidy up.', skillId: 'tab-tidy', schedule: { kind: 'daily' as const, time: '09:00', days: [5] } },
    { name: 'Elsewhere', prompt: 'Run /not-brought now.', schedule: { kind: 'daily' as const, time: '10:00', days: [2] } },
  ],
}

describe('preset detail views', () => {
  it('finds a starter with its place in the profile order', () => {
    expect(presetItem(detail, { kind: 'skill', name: 'tab-tidy' })).toMatchObject({ kind: 'skill', position: 2, total: 5 })
    expect(presetItem(detail, { kind: 'routine', name: 'Morning read' })).toMatchObject({ kind: 'routine', position: 3, total: 5 })
    expect(presetItem(detail, { kind: 'routine', name: 'fine-print' })).toBeNull()
    expect(presetItem(detail, { kind: 'skill', name: 'gone' })).toBeNull()
    expect(presetItem(detail, null)).toBeNull()
  })

  it('walks skills, then routines, stopping at either end', () => {
    expect(adjacentPresetItem(detail, { kind: 'skill', name: 'fine-print' }, -1)).toBeNull()
    expect(adjacentPresetItem(detail, { kind: 'skill', name: 'fine-print' }, 1)).toEqual({ kind: 'skill', name: 'tab-tidy' })
    expect(adjacentPresetItem(detail, { kind: 'skill', name: 'tab-tidy' }, 1)).toEqual({ kind: 'routine', name: 'Morning read' })
    expect(adjacentPresetItem(detail, { kind: 'routine', name: 'Elsewhere' }, 1)).toBeNull()
    expect(adjacentPresetItem(detail, { kind: 'routine', name: 'missing' }, 1)).toBeNull()
  })

  it('lays out a skill’s steps and instructions, dropping blank steps', () => {
    const body = skillDetailBody(detail.starterSkills[0]!)
    expect(body.paragraphs).toEqual(['Find the clauses.', 'List them plainly.'])
    expect(body.steps).toEqual([{ id: 's1', n: 1, title: 'Find', text: 'Scan the page.' }])
    expect(skillDetailBody(detail.starterSkills[1]!)).toEqual({ paragraphs: [], steps: [] })
  })

  it('links skills and the routines that run them, both ways', () => {
    expect(routinesUsingSkill(detail, 'fine-print')).toEqual(['Morning read'])
    expect(routinesUsingSkill(detail, 'tab-tidy')).toEqual(['Weekly tidy'])
    expect(routineStarterSkill(detail, detail.starterRoutines[0]!)).toBe('fine-print')
    expect(routineStarterSkill(detail, detail.starterRoutines[1]!)).toBe('tab-tidy')
    // A skill the preset doesn't bring along has no view to link to.
    expect(routineStarterSkill(detail, detail.starterRoutines[2]!)).toBeNull()
  })

  it('has English and Dutch for every detail-view string', () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith('galleries.presets.item.'))
    expect(keys.length).toBe(20)
    for (const k of keys) expect(NL[k as keyof typeof NL], k).toBeTruthy()
  })
})
