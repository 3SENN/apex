/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { libraryFilesUrl, parseInternalUrl, resolveInternalUrl, internalQuery, destinationOf } from '@shared/url'
import { EN } from '@shared/i18n/en'
import { NL } from '@shared/i18n/nl'
import { coCard } from '@shared/i18n/en/coCard'
import { SKELETON_DELAY_MS, SKELETON_HOLD_MS, routineMatches, shouldTakeFocus, skeletonWindow, skillUseMatches, sortRoutines } from '../src/renderer/src/companion-card/logic/listTemplate'
import { TAB_BUTTON_GAP, TAB_BUTTON_PADDING, TAB_ROW, TAB_ROW_PADDING, underlineFor } from '../src/renderer/src/companion-card/logic/cardLayout'

describe('skills filter (DS-113)', () => {
  it('keeps every skill, the used ones or the unused ones', () => {
    const used = { lastUsedAt: 1_000 }
    const fresh = { lastUsedAt: null }
    expect([used, fresh].filter((s) => skillUseMatches(s, 'all'))).toHaveLength(2)
    expect([used, fresh].filter((s) => skillUseMatches(s, 'used'))).toEqual([used])
    expect([used, fresh].filter((s) => skillUseMatches(s, 'unused'))).toEqual([fresh])
  })
})

describe('routines search and sort (DS-113)', () => {
  const r = (name: string, nextRunAt: number | null, enabled = true, prompt = '') => ({ name, prompt, enabled, nextRunAt })

  it('matches every word in the name or the prompt', () => {
    expect(routineMatches(r('Morning brief', null, true, 'Summarise the news'), 'brief news')).toBe(true)
    expect(routineMatches(r('Morning brief', null), 'weekly')).toBe(false)
    expect(routineMatches(r('Anything', null), '  ')).toBe(true)
  })

  it('sorts soonest first, with paused and unscheduled ones after, by name', () => {
    const list = [r('Zeta', 300), r('Alpha', null), r('Beta', 100), r('Gamma', 50, false), r('Delta', 100)]
    expect(sortRoutines(list, 'next').map((x) => x.name)).toEqual(['Beta', 'Delta', 'Zeta', 'Alpha', 'Gamma'])
    expect(sortRoutines(list, 'name').map((x) => x.name)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma', 'Zeta'])
  })

  it('returns a copy', () => {
    const list = [r('b', 2), r('a', 1)]
    sortRoutines(list, 'name')
    expect(list.map((x) => x.name)).toEqual(['b', 'a'])
  })
})

describe('loading skeleton timing (DS-106)', () => {
  it('never shows for data that beats the delay', () => {
    expect(skeletonWindow(0)).toBeNull()
    expect(skeletonWindow(SKELETON_DELAY_MS)).toBeNull()
  })

  it('shows after the delay and holds at least the hold time', () => {
    expect(skeletonWindow(SKELETON_DELAY_MS + 10)).toEqual({ from: SKELETON_DELAY_MS, until: SKELETON_DELAY_MS + SKELETON_HOLD_MS })
    expect(skeletonWindow(900)).toEqual({ from: SKELETON_DELAY_MS, until: 900 })
  })
})

describe('list search focus on a tab switch (DS-36)', () => {
  const el = (role: string | null, focusVisible: boolean) => ({ getAttribute: (name: string) => (name === 'role' ? role : null), matches: (q: string) => q === ':focus-visible' && focusVisible }) as unknown as Pick<Element, 'getAttribute' | 'matches'>

  it('takes focus after a click or when nothing is focused', () => {
    expect(shouldTakeFocus(null)).toBe(true)
    expect(shouldTakeFocus(el('tab', false))).toBe(true)
    expect(shouldTakeFocus(el(null, true))).toBe(true)
  })

  it('leaves focus on a tab walked to with the keyboard', () => {
    expect(shouldTakeFocus(el('tab', true))).toBe(false)
  })
})

describe('tab row geometry (DS-36)', () => {
  it('puts the first 36 px button 16 px into the row with 12 px padding and 10 px gaps', () => {
    expect(TAB_ROW.start).toBe(TAB_ROW_PADDING + TAB_BUTTON_PADDING)
    expect(TAB_ROW.gap).toBe(2 * TAB_BUTTON_PADDING + TAB_BUTTON_GAP)
    expect(TAB_ROW.iconBox).toBe(22)
  })

  it('makes the underline exactly the active button', () => {
    const widths = [52, 38, 60]
    const first = underlineFor(widths, 0)!
    expect(first.left).toBe(TAB_ROW_PADDING)
    expect(first.width).toBe(TAB_BUTTON_PADDING + 52 + TAB_ROW.iconBox + TAB_BUTTON_PADDING)
    // The second button starts after the first (label only, no icon) and the gap.
    const second = underlineFor(widths, 1)!
    expect(second.left).toBe(TAB_ROW_PADDING + (TAB_BUTTON_PADDING + 52 + TAB_BUTTON_PADDING) + TAB_BUTTON_GAP)
  })
})

describe('Open in Library (DS-115)', () => {
  it('narrows Library › Files to one companion and keeps that through the redirect', () => {
    const url = libraryFilesUrl('pip')
    expect(url).toBe('atelier://library/files?companion=pip')
    expect(resolveInternalUrl(url)).toBe(url)
    expect(internalQuery(resolveInternalUrl(url)!, 'companion')).toBe('pip')
    expect(destinationOf(url)).toBe('files')
    expect(parseInternalUrl(url)).toMatchObject({ page: 'library', section: 'files' })
  })

  it('drops an unsafe companion id and other sections keep their redirect', () => {
    expect(libraryFilesUrl(null)).toBe('atelier://library/files')
    expect(resolveInternalUrl('atelier://library/files?companion=../x')).toBe('atelier://library/files')
    expect(resolveInternalUrl('atelier://library/skills?companion=pip')).toBe('atelier://skills')
  })
})

describe('card strings', () => {
  it('has every card key in English and Dutch', () => {
    for (const key of Object.keys(coCard) as Array<keyof typeof coCard>) {
      expect(EN[key]).toBe(coCard[key])
      expect(NL[key], key).toBeTruthy()
    }
  })
})
