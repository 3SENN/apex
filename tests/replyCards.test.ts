/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { createKeyedRegistry } from '../src/renderer/src/chat/logic/cardRegistry'
import { approxTokens, artifactFormat, compactionLines, memoryOpLabel, partialKey, suggestionsLocked, tabCardState } from '../src/renderer/src/chat/logic/replyCards'

// Reply cards (CH-26, CH-27): the registry's dispatch by kind, the
// compaction divider's wording, when next steps lock, and the small rules
// the tab, artifact, memory and partial cards follow.

describe('card registry dispatch', () => {
  it('returns the card for a kind and null for kinds the log draws itself', () => {
    const cards = createKeyedRegistry<string, string>()
    cards.register('compaction', 'CompactionCard')
    expect(cards.get('compaction')).toBe('CompactionCard')
    expect(cards.get('assistant')).toBeNull()
    expect(cards.has('assistant')).toBe(false)
  })

  it('lets a later card replace an earlier one, and an unregister only removes its own', () => {
    const cards = createKeyedRegistry<string, string>()
    const offStub = cards.register('connector-needed', 'Stub')
    const offReal = cards.register('connector-needed', 'Real')
    offStub()
    expect(cards.get('connector-needed')).toBe('Real')
    offReal()
    expect(cards.get('connector-needed')).toBeNull()
  })
})

describe('the compaction divider (CH-26)', () => {
  it('rounds token counts to two significant digits', () => {
    expect(approxTokens(12_345, 'en')).toBe('12,000')
    expect(approxTokens(160_000, 'en')).toBe('160,000')
    expect(approxTokens(42, 'en')).toBe('42')
  })

  it('says what triggered it and about how much it replaced', () => {
    expect(compactionLines({ trigger: 'auto', thresholdTokens: 150_000, replacedTokens: 98_765 }, 'en')).toEqual({
      why: 'It grew past about 150,000 tokens, so the earlier part was summarized.',
      replaced: 'The summary stands in for about 99,000 tokens.',
    })
    expect(compactionLines({ trigger: 'auto', thresholdTokens: null, replacedTokens: null }).why).toBe('It grew long, so the earlier part was summarized.')
    expect(compactionLines({ trigger: 'manual', thresholdTokens: 150_000, replacedTokens: 0 })).toEqual({ why: 'You asked for it, so the earlier part was summarized.', replaced: null })
  })
})

describe('next steps (CH-27, DS-63)', () => {
  const items = [
    { kind: 'user' as const, id: 'u1' },
    { kind: 'assistant' as const, id: 'r1' },
    { kind: 'suggestions' as const, id: 's1' },
  ]

  it('stay live on the latest reply and lock while running or once you sent again', () => {
    expect(suggestionsLocked(items, 's1', false)).toBe(false)
    expect(suggestionsLocked(items, 's1', true)).toBe(true)
    expect(suggestionsLocked([...items, { kind: 'user', id: 'u2' }], 's1', false)).toBe(true)
    expect(suggestionsLocked([...items, { kind: 'suggestions', id: 's2' }], 's1', false)).toBe(true)
    expect(suggestionsLocked(items, 'missing', false)).toBe(true)
  })
})

describe('tab, artifact, memory and partial cards (CH-27)', () => {
  it('knows whether the opened tab is showing, open or closed', () => {
    expect(tabCardState('t1', ['t1', 't2'], 't1')).toBe('active')
    expect(tabCardState('t2', ['t1', 't2'], 't1')).toBe('open')
    expect(tabCardState('t3', ['t1'], 't1')).toBe('closed')
  })

  it('names the artifact format from its name or media type', () => {
    expect(artifactFormat('chart.svg', 'text/plain')).toBe('SVG')
    expect(artifactFormat('page', 'text/html')).toBe('HTML')
    expect(artifactFormat('notes.md', '')).toBe('MD')
    expect(artifactFormat('data.csv', '')).toBe('CSV')
    expect(artifactFormat('blob', 'application/octet-stream')).toBe('TXT')
  })

  it('labels memory changes and picks the partial notice for each reason', () => {
    expect(memoryOpLabel('saved')).toBe('Saved')
    expect(memoryOpLabel('forgotten')).toBe('Forgot')
    expect(partialKey('step-limit')).toBe('composer.card.partial.step-limit')
    expect(partialKey('cut-off')).toBe('composer.card.partial.cut-off')
  })
})
