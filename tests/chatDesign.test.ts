/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { LogItem } from '../src/renderer/src/agentLog'
import { composerHint, composerState, fitsOneLine, primaryButton, primaryLabel, toggleStep, voiceUnavailable } from '../src/renderer/src/chat/logic/composer'
import { countMarkdownWords, markdownText, parseInline, parseMarkdown, safeHref, type Block } from '../src/renderer/src/chat/logic/markdown'
import { BATCH_STAGGER_CAP_MS, WORD_FADE_MS, WORD_STAGGER_MS, advanceReveal, countWords, newReveal, splitWords, wordDelay } from '../src/renderer/src/chat/logic/reveal'
import {
  FOLLOW_GRACE_MS,
  SMOOTH_JUMP_MAX,
  edgeFades,
  formatTimer,
  formatWorked,
  isUpwardIntent,
  jumpBehavior,
  shouldFollow,
  waitingSize,
} from '../src/renderer/src/chat/logic/view'
import { activityLine, replyParts, stepHost, stepKind, workHosts, workSummary, type ToolItem } from '../src/renderer/src/chat/logic/work'

const tool = (id: string, label: string, state: ToolItem['state'] = 'done'): ToolItem => ({ kind: 'tool', id, label, state })

describe('markdown (DS-51)', () => {
  it('renders a list without any raw "- " left in the text', () => {
    const blocks = parseMarkdown('Here is the plan:\n\n- Book the train\n- Pack light\n  - Socks\n- Leave early')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list'])
    const list = blocks[1] as Extract<Block, { kind: 'list' }>
    expect(list.items).toHaveLength(3)
    expect(list.items[1]?.children.map((b) => b.kind)).toEqual(['paragraph', 'list'])
    expect(markdownText(blocks)).not.toMatch(/(^|\n)\s*- /)
  })

  it('parses ordered lists with their start number, headings, quotes, rules and code', () => {
    const blocks = parseMarkdown('## Steps\n\n3. three\n4. four\n\n> quoted\n\n---\n\n```ts\nconst a = 1\n```')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'quote', 'rule', 'code'])
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true, start: 3 })
    expect(blocks[4]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1' })
  })

  it('keeps an unclosed code fence as code while it streams', () => {
    expect(parseMarkdown('```\nhalf')).toEqual([{ kind: 'code', lang: '', text: 'half' }])
  })

  it('parses inline bold, italic, code, links and bare URLs', () => {
    expect(parseInline('a **b** _c_ `d` [e](https://e.com) https://f.com.')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'd' },
      { kind: 'text', text: ' ' },
      { kind: 'link', href: 'https://e.com', children: [{ kind: 'text', text: 'e' }] },
      { kind: 'text', text: ' ' },
      { kind: 'link', href: 'https://f.com', children: [{ kind: 'text', text: 'https://f.com' }] },
      { kind: 'text', text: '.' },
    ])
  })

  it('never makes an unsafe link and keeps raw HTML as text', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ kind: 'text', text: 'x' }])
    expect(markdownText(parseMarkdown('<img src=x onerror=alert(1)>'))).toBe('<img src=x onerror=alert(1)>')
  })

  it('leaves snake_case and lone asterisks alone', () => {
    expect(markdownText(parseMarkdown('use snake_case_names and 2 * 3'))).toBe('use snake_case_names and 2 * 3')
  })

  it('parses tables and task lists', () => {
    const [table] = parseMarkdown('| A | B |\n|---|--:|\n| 1 | 2 |')
    expect(table).toMatchObject({ kind: 'table', align: [null, 'right'] })
    const [tasks] = parseMarkdown('- [x] done\n- [ ] not yet')
    expect(tasks).toMatchObject({ kind: 'list', items: [{ checked: true }, { checked: false }] })
  })

  it('counts words the way the renderer draws them', () => {
    const blocks = parseMarkdown('Hello **big** world\n\n- one `code`\n\n```\nx y z\n```')
    // Hello, big, world, one, `code` (one unit), the code block (one unit).
    expect(countMarkdownWords(blocks)).toBe(6)
  })
})

describe('word reveal (DS-56)', () => {
  it('settles text seen for the first time unless it streams in live', () => {
    expect(newReveal(12, false, 0)).toEqual({ shown: 12, batches: [] })
    expect(newReveal(3, true, 100)).toEqual({ shown: 3, batches: [{ start: 0, at: 100 }] })
  })

  it('adds a batch for new words and drops finished ones', () => {
    let rec = newReveal(0, false, 0)
    rec = advanceReveal(rec, 4, 1000)
    expect(rec.batches).toEqual([{ start: 0, at: 1000 }])
    const same = advanceReveal(rec, 4, 1010)
    expect(same).toBe(rec)
    rec = advanceReveal(rec, 9, 1140)
    expect(rec.batches).toEqual([{ start: 0, at: 1000 }, { start: 4, at: 1140 }])
    rec = advanceReveal(rec, 9, 1140 + BATCH_STAGGER_CAP_MS + WORD_FADE_MS + 1)
    expect(rec.batches).toEqual([])
    expect(rec.shown).toBe(9)
  })

  it('staggers words within a batch, caps the stagger and never replays settled words', () => {
    const rec = { shown: 100, batches: [{ start: 10, at: 1000 }] }
    expect(wordDelay(rec, 5, 1000)).toBeNull()
    expect(wordDelay(rec, 10, 1000)).toBe(0)
    expect(wordDelay(rec, 13, 1000)).toBe(3 * WORD_STAGGER_MS)
    expect(wordDelay(rec, 99, 1000)).toBe(BATCH_STAGGER_CAP_MS)
  })

  it('continues a fade on a view that mounted later instead of restarting it', () => {
    const rec = { shown: 20, batches: [{ start: 0, at: 1000 }] }
    expect(wordDelay(rec, 0, 1100)).toBe(-100)
    // Long finished by the time this view mounted: plain text.
    expect(wordDelay(rec, 0, 1000 + WORD_FADE_MS + 10)).toBeNull()
  })

  it('resets when the text gets shorter (edit and resend)', () => {
    expect(advanceReveal({ shown: 10, batches: [{ start: 5, at: 1 }] }, 3, 2)).toEqual({ shown: 3, batches: [] })
  })

  it('splits words without losing characters', () => {
    const parts = splitWords('one  two\nthree')
    expect(parts.map((p) => p.text).join('')).toBe('one  two\nthree')
    expect(parts.filter((p) => p.word)).toHaveLength(3)
    expect(countWords('  a b  ')).toBe(2)
  })
})

describe('reading position (DS-61)', () => {
  it('treats ↑, Page Up, Home and ⇧Space as wanting to look up', () => {
    expect(isUpwardIntent({ key: 'ArrowUp' })).toBe(true)
    expect(isUpwardIntent({ key: 'PageUp' })).toBe(true)
    expect(isUpwardIntent({ key: 'Home' })).toBe(true)
    expect(isUpwardIntent({ key: ' ', shiftKey: true })).toBe(true)
    expect(isUpwardIntent({ key: ' ' })).toBe(false)
    expect(isUpwardIntent({ key: 'ArrowDown' })).toBe(false)
  })

  it('does not stick again during the grace period after letting go', () => {
    const atBottom = { scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }
    expect(shouldFollow(atBottom, 1000, 1000 + FOLLOW_GRACE_MS - 1)).toBe(false)
    expect(shouldFollow(atBottom, 1000, 1000 + FOLLOW_GRACE_MS + 1)).toBe(true)
    expect(shouldFollow({ ...atBottom, scrollTop: 100 }, 0, 10_000)).toBe(false)
  })

  it('jumps smoothly when near and instantly when far or under Reduce Motion', () => {
    expect(jumpBehavior(400, false)).toBe('smooth')
    expect(jumpBehavior(SMOOTH_JUMP_MAX + 1, false)).toBe('instant')
    expect(jumpBehavior(10, true)).toBe('instant')
  })

  it('shows edge fades only where content is hidden, and only with messages', () => {
    expect(edgeFades({ scrollTop: 0, clientHeight: 100, scrollHeight: 300 }, true)).toEqual({ top: false, bottom: false })
    expect(edgeFades({ scrollTop: 200, clientHeight: 100, scrollHeight: 300 }, true)).toEqual({ top: true, bottom: false })
    expect(edgeFades({ scrollTop: 50, clientHeight: 100, scrollHeight: 300 }, false)).toEqual({ top: false, bottom: false })
  })
})

describe('status and duration (DS-54, DS-57)', () => {
  it('formats the live timer in tabular minutes and seconds', () => {
    expect(formatTimer(7_400)).toBe('0:07')
    expect(formatTimer(225_000)).toBe('3:45')
    expect(formatTimer(3_723_000)).toBe('1:02:03')
  })

  it('freezes into a duration line', () => {
    expect(formatWorked(12_000)).toBe('Took 12 s')
    expect(formatWorked(225_000)).toBe('Took 3 min 45 s')
    expect(formatWorked(120_000)).toBe('Took 2 min')
    expect(formatWorked(3_840_000)).toBe('Took 1 h 4 min')
    expect(formatWorked(100)).toBe('Took 1 s')
  })
})

describe('composer (DS-59, DS-60, DS-62)', () => {
  const base = { hasText: false, canSend: true, running: false, sending: false, editingQueued: false }

  it('follows the primary button state table', () => {
    // DS-59: at rest the voice button holds the slot, disabled until voice ships.
    expect(primaryButton(base)).toEqual({ action: 'voice', disabled: true, mic: 'main' })
    expect(primaryButton({ ...base, voice: 'idle', canSend: false })).toEqual({ action: 'voice', disabled: true, mic: 'main' })
    expect(voiceUnavailable('off', true)).toMatch(/later update/)
    expect(voiceUnavailable('idle', true)).toBeNull()
    expect(primaryButton({ ...base, voice: 'idle' })).toEqual({ action: 'voice', disabled: false, mic: 'main' })
    expect(primaryButton({ ...base, hasText: true })).toEqual({ action: 'send', disabled: false, mic: 'secondary' })
    expect(primaryButton({ ...base, hasText: true, canSend: false }).disabled).toBe(true)
    expect(primaryButton({ ...base, hasText: true, sending: true })).toEqual({ action: 'sending', disabled: true, mic: 'secondary' })
    expect(primaryButton({ ...base, running: true }).action).toBe('stop')
    expect(primaryButton({ ...base, running: true, hasText: true }).action).toBe('queue')
    expect(primaryButton({ ...base, editingQueued: true, hasText: true }).action).toBe('save')
    expect(primaryButton({ ...base, editingQueued: true }).disabled).toBe(true)
    expect(primaryButton({ ...base, voice: 'recording' }).action).toBe('send-transcript')
    expect(primaryButton({ ...base, creating: true })).toEqual({ action: 'busy', disabled: true, mic: 'hidden' })
    expect(primaryButton({ ...base, voice: 'transcribing', hasText: true })).toEqual({ action: 'busy', disabled: true, mic: 'hidden' })
    expect(primaryLabel('stop', 'Pip')).toBe('Stop Pip')
  })

  it('has distinct hints for an empty page, an empty panel and a follow-up', () => {
    const hint = (input: Parameters<typeof composerState>[0]): string => composerHint(composerState(input), 'Pip')
    const common = { hasApiKey: true, running: false, editingQueued: false }
    expect(hint({ ...common, empty: true, surface: 'page' })).toBe('What should Pip do? Type / for skills')
    expect(hint({ ...common, empty: true, surface: 'panel' })).toBe('Ask Pip about this page')
    expect(hint({ ...common, empty: false, surface: 'panel' })).toBe('Reply to Pip')
    expect(hint({ ...common, empty: true, surface: 'panel', running: true })).toBe('Pip is busy. What you send now goes out next')
  })

  it('compacts only for one-line drafts', () => {
    expect(fitsOneLine('short', 20)).toBe(true)
    expect(fitsOneLine('two\nlines', 20)).toBe(false)
    expect(fitsOneLine('x'.repeat(21), 20)).toBe(false)
  })

  it('toggles a suggested step in and out of the draft', () => {
    const once = toggleStep('', 'Book the hotel')
    expect(once).toBe('Book the hotel')
    const twice = toggleStep(once, 'Compare flights')
    expect(twice).toBe('Book the hotel\n\nCompare flights')
    expect(toggleStep(twice, 'Book the hotel')).toBe('Compare flights')
  })
})

describe('work fold (DS-55)', () => {
  it('folds consecutive steps and the thinking between them into one part', () => {
    const items: LogItem[] = [
      { kind: 'assistant', id: 't0', text: 'Let me look.', thinking: '' },
      tool('a', 'Open https://www.example.com/x'),
      { kind: 'assistant', id: 't1', text: '', thinking: 'hmm' },
      tool('b', 'Search the web for "trains"', 'running'),
      { kind: 'assistant', id: 't2', text: 'Found it.', thinking: '' },
    ]
    const parts = replyParts(items)
    expect(parts.map((p) => p.kind)).toEqual(['item', 'work', 'item'])
    const work = parts[1] as Extract<(typeof parts)[number], { kind: 'work' }>
    expect(work.items.map((i) => i.id)).toEqual(['a', 't1', 'b'])
    expect(work.running).toBe(true)
  })

  it('reads the kind and host of a step from its label', () => {
    expect(stepKind('Open https://example.com')).toBe('page')
    expect(stepKind('Read the page text')).toBe('page')
    expect(stepKind('Search the web for "x"')).toBe('search')
    expect(stepKind('Click ref_12 (button)')).toBe('act')
    expect(stepKind('Open a new tab')).toBe('tabs')
    expect(stepKind('Check memory')).toBe('memory')
    expect(stepHost('Open https://www.example.com/a?b=c')).toBe('example.com')
    expect(stepHost('Read news.example.org/today')).toBe('news.example.org')
    expect(stepHost('Click (10, 20)')).toBeNull()
    expect(workHosts([tool('1', 'Open https://a.com'), tool('2', 'Open https://b.com'), tool('3', 'Read https://a.com/x'), tool('4', 'Open https://c.com'), tool('5', 'Open https://d.com')])).toEqual(['a.com', 'c.com', 'd.com'])
  })

  it('says what is happening now and sums up what happened', () => {
    expect(activityLine([tool('1', 'Open https://a.com', 'running')], 'Pip')).toBe('Reading a.com')
    expect(activityLine([tool('1', 'Open https://a.com'), tool('2', 'Open https://b.com'), tool('3', 'Read the page', 'running')], 'Pip')).toBe('Reading 3 pages')
    expect(activityLine([tool('1', 'Search the web for "night trains"', 'running')], 'Pip')).toBe('Searching for “night trains”')
    expect(activityLine([], 'Pip')).toBe('Pip is on it')
    expect(workSummary([tool('1', 'Open https://a.com'), tool('2', 'Read the page'), tool('3', 'Search the web for "x"'), tool('4', 'Search the web for "y"')])).toBe('Read 2 pages and searched twice')
    expect(workSummary([tool('1', 'Click ref_1 (link)')])).toBe('Took one step on the page')
  })
})

describe('waiting companion (CO-20)', () => {
  it('stands up to about 200 px on the page and 140 px in the panel, smaller in short windows (DS-72)', () => {
    expect(waitingSize('page', null)).toBe(200)
    expect(waitingSize('page', 900)).toBe(200)
    expect(waitingSize('page', 700)).toBe(175)
    expect(waitingSize('page', 300)).toBe(150)
    expect(waitingSize('panel', 900)).toBe(140)
    expect(waitingSize('panel', 400)).toBe(104)
  })
})
