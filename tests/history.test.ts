/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HistoryStore, pickKey, rankHistory, type HistoryEntry } from '../src/main/history'
import { completeFromHistory } from '../src/main/omnibox'

const now = Date.UTC(2026, 9, 28)
const day = 86_400_000
const entry = (url: string, title: string, visits = 1, daysAgo = 0): HistoryEntry => ({ url, title, visits, lastVisit: now - daysAgo * day })

describe('rankHistory', () => {
  const entries = [
    entry('https://github.com/example/reverse-proxy', 'Reverse proxy: a guide', 3, 1),
    entry('https://www.github.com/', 'GitHub', 40, 0),
    entry('https://news.ycombinator.com/', 'Hacker News', 10, 2),
    entry('https://example.com/git-guide', 'A guide to git', 1, 60),
  ]

  it('prefers URL prefix matches, then visit count', () => {
    const ranked = rankHistory(entries, 'git', now).map((e) => e.url)
    expect(ranked[0]).toBe('https://www.github.com/')
    expect(ranked).toContain('https://example.com/git-guide')
  })

  it('matches words in titles', () => {
    expect(rankHistory(entries, 'hacker', now)[0]?.url).toBe('https://news.ycombinator.com/')
    expect(rankHistory(entries, 'reverse', now)[0]?.url).toBe('https://github.com/example/reverse-proxy')
  })

  it('returns nothing for empty or unmatched queries', () => {
    expect(rankHistory(entries, '  ', now)).toEqual([])
    expect(rankHistory(entries, 'zzzz', now)).toEqual([])
  })

  it('honors the limit', () => {
    expect(rankHistory(entries, 'h', now, 2)).toHaveLength(2)
  })
})

// SH-35: typed counts, the last pick per input, visit times
describe('HistoryStore command-bar memory', () => {
  const withStore = (fn: (store: HistoryStore, dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-history-'))
    try {
      const store = new HistoryStore(dir)
      fn(store, dir)
      store.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('counts an address typed before its visit', () => {
    withStore((store) => {
      store.noteTyped('https://typed.test/')
      store.record('https://typed.test/', 'Typed')
      store.noteTyped('https://typed.test/')
      expect(store.get('https://typed.test/')).toMatchObject({ visits: 1, typed: 2 })
      expect(store.get('https://typed.test/')?.visitTimes).toHaveLength(1)
    })
  })

  it('remembers the pick for an input for a day', () => {
    withStore((store) => {
      const at = Date.UTC(2026, 9, 29)
      store.notePick('  GH ', 'https://github.com/', at)
      store.notePick('x', 'apex://settings', at)
      expect(pickKey(' GH ')).toBe(pickKey('gh'))
      expect(store.pickFor('gh', at + 1000)).toBe('https://github.com/')
      expect(store.pickFor('gh', at + 2 * day)).toBeNull()
      expect(store.pickFor('x', at)).toBeNull()
    })
  })

  it('completes typed-often addresses inline', () => {
    withStore((store) => {
      store.noteTyped('https://often.test/')
      store.record('https://often.test/', 'Often')
      store.noteTyped('https://often.test/')
      store.record('https://once.test/', 'Once')
      expect(completeFromHistory(store, 'oft')?.url).toBe('https://often.test/')
      expect(completeFromHistory(store, 'onc')).toBeNull()
      store.remove('https://often.test/')
      expect(completeFromHistory(store, 'oft')).toBeNull()
    })
  })
})
