/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { detailsModel, detailsPrompt, sectionCount, visibleSections } from '../src/renderer/src/chat/logic/details'
import { FOLD_TILES_MAX, foldStack, type ToolItem } from '../src/renderer/src/chat/logic/work'

// The chat builder's pure rules: the work fold's tile stack (DS-55), the
// details panel's files section and the slot below its card (DS-49, DS-123).

const tool = (id: string, label: string, connector?: { id: string; name: string }): ToolItem =>
  ({ kind: 'tool', id, label, state: 'done', ...(connector ? { step: { connector } } : {}) }) as ToolItem

describe('foldStack (DS-55)', () => {
  it('shows connectors first, then the newest sites, with the rest as "+N more"', () => {
    const steps = [tool('1', 'Open a.com'), tool('2', 'Open b.com'), tool('3', 'Read c.com'), tool('4', 'Open d.com')]
    const stack = foldStack(steps, [{ id: 'gm', name: 'Mail' }])
    expect(stack.tiles).toEqual([
      { kind: 'connector', id: 'gm', name: 'Mail' },
      { kind: 'site', host: 'c.com' },
      { kind: 'site', host: 'd.com' },
    ])
    expect(stack.more).toBe(2)
  })

  it('counts a site once, at its newest place', () => {
    const stack = foldStack([tool('1', 'Open a.com'), tool('2', 'Open b.com'), tool('3', 'Open a.com')], [])
    expect(stack.tiles).toEqual([{ kind: 'site', host: 'b.com' }, { kind: 'site', host: 'a.com' }])
    expect(stack.more).toBe(0)
  })

  it('keeps to the cap with many connectors', () => {
    const connectors = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id }))
    const stack = foldStack([tool('1', 'Open x.com')], connectors)
    expect(stack.tiles).toHaveLength(FOLD_TILES_MAX)
    expect(stack.tiles.every((t) => t.kind === 'connector')).toBe(true)
    expect(stack.more).toBe(3)
  })

  it('falls back to one tile per kind of work', () => {
    const stack = foldStack([tool('1', 'Search the web for "x"'), tool('2', 'Click the button'), tool('3', 'Search the web for "y"')], [])
    expect(stack.tiles).toEqual([{ kind: 'work', step: 'search' }, { kind: 'work', step: 'act' }])
    expect(stack.more).toBe(0)
    expect(foldStack([], []).tiles).toEqual([{ kind: 'work', step: 'other' }])
  })
})

describe('details panel: files and the slot below the card (DS-49, DS-123)', () => {
  const empty = detailsModel({ items: [], details: {}, connectorIds: [], connectorNames: {}, routineId: null, usedTabIds: [] })

  it('shows the files section for what the chat holds, with that count', () => {
    expect(visibleSections(empty)).not.toContain('files')
    expect(visibleSections(empty, 3)).toContain('files')
    expect(sectionCount(empty, 'files', 3)).toBe(3)
    expect(sectionCount(empty, 'files')).toBe(0)
  })

  it('offers a way to connect when the chat cannot reply', () => {
    expect(detailsPrompt({ canSend: false, engine: 'api-key', spend: null })).toEqual({ kind: 'api-key', url: 'atelier://settings/model' })
  })

  it('mentions your own budget only once it is mostly used, and never on another engine', () => {
    const spend = (usd: number, budgetUsd: number | null) => ({ usd, budgetUsd })
    expect(detailsPrompt({ canSend: true, engine: 'api-key', spend: spend(5, 10) })).toBeNull()
    expect(detailsPrompt({ canSend: true, engine: 'api-key', spend: spend(8.5, 10) })).toEqual({ kind: 'budget', url: 'atelier://settings/you', usd: 8.5, budgetUsd: 10 })
    expect(detailsPrompt({ canSend: true, engine: 'api-key', spend: spend(50, null) })).toBeNull()
    expect(detailsPrompt({ canSend: true, engine: 'another-engine', spend: spend(9, 10) })).toBeNull()
    expect(detailsPrompt({ canSend: true, engine: 'api-key', spend: null })).toBeNull()
  })
})
