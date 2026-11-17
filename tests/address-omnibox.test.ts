/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  copyValue,
  dedupeGroups,
  flattenGroups,
  frecency,
  groupJump,
  inlineCompletion,
  isStrongCandidate,
  matchRanges,
  stepSelection,
  textScore,
  typedForm,
  withinOneEdit,
  type OmniboxGroup,
  type OmniboxProvider,
} from '@shared/omnibox'
import type { HistoryEntry, HistoryStore } from '../src/main/history'
import { completeFromHistory, omnibox, omniboxDrafts } from '../src/main/omnibox'

const now = Date.UTC(2026, 9, 29, 12)

function fakeHistory(entries: HistoryEntry[], picks: Record<string, string> = {}): HistoryStore {
  return {
    entries: () => entries.values(),
    pickFor: (input: string) => picks[input.trim().toLowerCase()] ?? null,
  } as unknown as HistoryStore
}

const entry = (url: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ url, title: '', visits: 1, lastVisit: now - DAY_MS, ...extra }) as HistoryEntry

describe('ranking', () => {
  it('types addresses without scheme, www or a trailing slash', () => {
    expect(typedForm('https://www.example.com/')).toBe('example.com')
    expect(typedForm('http://news.example.org/a/b')).toBe('news.example.org/a/b')
  })

  it('scores address prefixes over title prefixes over word starts', () => {
    const address = textScore('Something', 'https://github.com/', 'git')
    const title = textScore('Gitlab docs', 'https://example.com/', 'git')
    const word = textScore('The git book', 'https://example.com/', 'git')
    expect(address).toBeGreaterThan(title)
    expect(title).toBeGreaterThan(word)
    expect(textScore('Nothing', 'https://example.com/', 'zzz')).toBe(0)
  })

  it('merges overlapping highlight ranges and can keep word starts only', () => {
    expect(matchRanges('Hello world', 'wor')).toEqual([[6, 9]])
    expect(matchRanges('aaa', 'aa')).toEqual([[0, 3]])
    expect(matchRanges('subway way', 'way', true)).toEqual([[7, 10]])
  })

  it('weighs visits, recency and typed counts', () => {
    const base = { url: 'https://a.test/', visits: 1, lastVisit: now }
    expect(frecency(base, 0, now)).toBe(0)
    expect(frecency({ ...base, visits: 30 }, 50, now)).toBeGreaterThan(frecency(base, 50, now))
    expect(frecency({ ...base, typed: 3 }, 50, now)).toBeGreaterThan(frecency(base, 50, now))
    expect(frecency(base, 50, now)).toBeGreaterThan(frecency({ ...base, lastVisit: now - 20 * DAY_MS }, 50, now))
  })

  it('dedupes a page that an earlier group already shows, keeping typed and suggestion rows', () => {
    const groups: OmniboxGroup[] = [
      { group: 'typed', rows: [{ id: 't', group: 'typed', title: 'example.com', action: { kind: 'navigate', url: 'https://example.com/' } }] },
      { group: 'tabs', rows: [{ id: 'a', group: 'tabs', title: 'Example', url: 'https://example.com/', action: { kind: 'switch-tab', tabId: '1' } }] },
      { group: 'history', rows: [{ id: 'b', group: 'history', title: 'Example', url: 'https://www.example.com', action: { kind: 'navigate', url: 'https://www.example.com' } }] },
    ]
    const out = dedupeGroups(groups)
    expect(out.map((g) => g.group)).toEqual(['typed', 'tabs'])
    expect(flattenGroups(out)).toHaveLength(2)
  })
})

describe('inline completion (SH-35)', () => {
  it('completes only strong candidates', () => {
    const recent = [now - 1000, now - 2000, now - 3000]
    expect(isStrongCandidate({ url: 'u', visits: 3, lastVisit: now, visitTimes: recent }, now)).toBe(true)
    expect(isStrongCandidate({ url: 'u', visits: 3, lastVisit: now, visitTimes: [now - 8 * DAY_MS, now, now] }, now)).toBe(false)
    expect(isStrongCandidate({ url: 'u', visits: 1, lastVisit: now, typed: 2 }, now)).toBe(true)
    expect(isStrongCandidate({ url: 'u', visits: 1, lastVisit: now }, now, true)).toBe(true)
    expect(inlineCompletion('gith', [{ url: 'https://github.com/', strong: false }])).toBeNull()
  })

  it('extends what was typed with the rest of the address', () => {
    const c = inlineCompletion('gith', [{ url: 'https://github.com/', strong: true }])
    expect(c).toEqual({ input: 'gith', text: 'github.com', url: 'https://github.com/', typo: false })
    // Typed case is kept; nothing completes for spaces, schemes or a full match.
    expect(inlineCompletion('GitH', [{ url: 'https://github.com/', strong: true }])?.text).toBe('GitHub.com')
    expect(inlineCompletion('git hub', [{ url: 'https://github.com/', strong: true }])).toBeNull()
    expect(inlineCompletion('https://gi', [{ url: 'https://github.com/', strong: true }])).toBeNull()
    expect(inlineCompletion('github.com', [{ url: 'https://github.com/', strong: true }])).toBeNull()
  })

  it('tolerates one typo on the host as a hint', () => {
    expect(withinOneEdit('gihtub', 'github')).toBe(true)
    expect(withinOneEdit('gthub', 'github')).toBe(true)
    expect(withinOneEdit('gxthub', 'github')).toBe(true)
    expect(withinOneEdit('gxxhub', 'github')).toBe(false)
    const c = inlineCompletion('gihtub', [{ url: 'https://github.com/', strong: true }])
    expect(c?.typo).toBe(true)
    expect(c?.url).toBe('https://github.com/')
    // Too short to guess at.
    expect(inlineCompletion('gtb', [{ url: 'https://github.com/', strong: true }])).toBeNull()
  })

  it('prefers what was picked for the same input in the last day', () => {
    const history = fakeHistory(
      [entry('https://github.com/', { visits: 50, typed: 5 }), entry('https://gist.github.com/', { visits: 1 })],
      { gi: 'https://gist.github.com/' },
    )
    expect(completeFromHistory(history, 'gi', now)?.url).toBe('https://gist.github.com/')
    expect(completeFromHistory(history, 'gith', now)?.url).toBe('https://github.com/')
    expect(completeFromHistory(null, 'gi', now)).toBeNull()
  })
})

describe('keys and copying (SH-36)', () => {
  it('steps selection; up from the first row restores what you typed', () => {
    expect(stepSelection(-1, 3, 1, false)).toBe(0)
    expect(stepSelection(0, 3, -1, false)).toBe(-1)
    expect(stepSelection(2, 3, 1, false)).toBe(2)
    expect(stepSelection(2, 3, 1, true)).toBe(-1)
    expect(stepSelection(-1, 3, -1, true)).toBe(2)
    expect(stepSelection(0, 0, 1, true)).toBe(-1)
  })

  it('copies the whole URL for an untouched address and the selection otherwise', () => {
    expect(copyValue('example.com/a', [0, 13], 'https://example.com/a')).toBe('https://example.com/a')
    expect(copyValue('https://example.com/a', [8, 15], 'https://example.com/a')).toBe('example')
    expect(copyValue('something else', [0, 14], 'https://example.com/a')).toBe('something else')
  })

  it('jumps between universal-search groups', () => {
    const groups: OmniboxGroup[] = [
      { group: 'tabs', rows: [{ id: '1', group: 'tabs', title: 'a', action: { kind: 'switch-tab', tabId: '1' } }, { id: '2', group: 'tabs', title: 'b', action: { kind: 'switch-tab', tabId: '2' } }] },
      { group: 'chats', rows: [{ id: '3', group: 'chats', title: 'c', action: { kind: 'open-internal', url: 'apex://chat/c' } }] },
    ]
    expect(groupJump(groups, 0, 1)).toBe(2)
    expect(groupJump(groups, 2, -1)).toBe(0)
    expect(groupJump(groups, 2, 1)).toBe(2)
    expect(groupJump([], 0, 1)).toBe(-1)
  })
})

describe('provider registry and drafts', () => {
  const ctx = { windowId: 1, signal: new AbortController().signal }
  const provider = (id: string, group: string, order: number, rows: string[], fail = false): OmniboxProvider => ({
    id,
    group,
    order,
    maxRows: 2,
    query: async () => {
      if (fail) throw new Error('offline')
      return rows.map((r) => ({ id: `${id}:${r}`, group, title: r, url: `https://${r}/`, action: { kind: 'navigate' as const, url: `https://${r}/` } }))
    },
  })

  it('orders groups by provider order, caps rows and survives a failing provider', async () => {
    const offs = [
      omnibox.registerProvider(provider('test-b', 'test-b', 9002, ['b.test'])),
      omnibox.registerProvider(provider('test-a', 'test-a', 9001, ['a1.test', 'a2.test', 'a3.test'])),
      omnibox.registerProvider(provider('test-x', 'test-x', 9003, [], true)),
    ]
    try {
      const groups = (await omnibox.query('x', ctx)).filter((g) => g.group.startsWith('test-'))
      expect(groups.map((g) => g.group)).toEqual(['test-a', 'test-b'])
      expect(groups[0]?.rows).toHaveLength(2)
      expect(() => omnibox.registerProvider(provider('test-a', 'test-a', 1, []))).toThrow()
    } finally {
      for (const off of offs) off()
    }
    expect(omnibox.providers().some((p) => p.id.startsWith('test-'))).toBe(false)
  })

  it('keeps unfinished text per tab and forgets it with the tab', () => {
    omniboxDrafts.set('t1', 'half typed')
    omniboxDrafts.set('t2', '   ')
    expect(omniboxDrafts.get('t1')).toBe('half typed')
    expect(omniboxDrafts.get('t2')).toBeNull()
    omniboxDrafts.set('t1', 'x'.repeat(5000))
    expect(omniboxDrafts.get('t1')?.length).toBe(2048)
    omniboxDrafts.forget('t1')
    expect(omniboxDrafts.get('t1')).toBeNull()
  })
})
