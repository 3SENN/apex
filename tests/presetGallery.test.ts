/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { INTERNAL_PAGES, internalTitle, parseInternalUrl, presetUrl } from '@shared/url'
import { EN } from '@shared/i18n/en'
import { NL } from '@shared/i18n/nl'
import { companionFromPreset, presetStats, routineSkill } from '../src/renderer/src/companion-card/logic/presetProfile'

// The preset gallery (apex://presets) and a preset's profile.

describe('preset routes', () => {
  it('addresses the gallery and one profile', () => {
    expect(presetUrl()).toBe('apex://presets')
    expect(presetUrl('pip')).toBe('apex://presets/pip')
    expect(parseInternalUrl('apex://presets')).toMatchObject({ page: 'presets', id: null })
    expect(parseInternalUrl('apex://presets/pip')).toMatchObject({ page: 'presets', id: 'pip' })
    expect(parseInternalUrl('apex://presets/../etc')).toBeNull()
    expect(INTERNAL_PAGES.presets).toBeTruthy()
    expect(internalTitle('apex://presets/pip').title).toBe(INTERNAL_PAGES.presets)
  })
})

describe('preset profile logic', () => {
  const detail = {
    presetId: 'sage',
    starterSkills: [{ name: 'fine-print', description: 'd', instructions: 'i' }],
    starterRoutines: [{ name: 'Morning', prompt: 'Use /fine-print on it.', schedule: { kind: 'daily' as const, time: '08:00', days: [1] } }],
    version: '2',
  }

  it('finds the companion made from a preset, skipping hidden ones', () => {
    const items = [
      { id: 'a', persona: 'sage', hidden: true },
      { id: 'b', persona: 'pip', hidden: false },
      { id: 'c', persona: 'sage', hidden: false },
    ]
    expect(companionFromPreset(items, 'sage')?.id).toBe('c')
    expect(companionFromPreset(items, 'bolt')).toBeNull()
  })

  it('fills the four stat tiles', () => {
    const stats = presetStats(detail, [{ persona: 'sage' }, { persona: 'sage' }, { persona: 'pip' }])
    expect(stats).toEqual([
      { id: 'skills', value: '1' },
      { id: 'routines', value: '1' },
      { id: 'yours', value: '2' },
      { id: 'version', value: 'v2' },
    ])
    expect(presetStats({ ...detail, version: null }, []).at(-1)).toEqual({ id: 'version', value: 'v1' })
  })

  it('names the skill a routine runs', () => {
    expect(routineSkill('Use /fine-print on the page.')).toBe('fine-print')
    expect(routineSkill('/tab-tidy now')).toBe('tab-tidy')
    expect(routineSkill('Look at https://a.b/c and summarise')).toBeNull()
    expect(routineSkill('No skill here')).toBeNull()
  })
})

describe('gallery strings', () => {
  it('have Dutch for every key', () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith('galleries.'))
    expect(keys.length).toBeGreaterThan(40)
    for (const k of keys) expect(NL[k as keyof typeof NL], k).toBeTruthy()
  })
})
