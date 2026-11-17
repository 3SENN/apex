/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { REPORT_FILES_MAX_BYTES, REPORT_IMAGE_MAX_BYTES, REPORT_MAX_BYTES, REPORT_MAX_FILES, REPORT_MAX_IMAGES, matchesLogQuery, pageLogEntries, type LogEntry, type PickedReportFile, type ReportEstimate } from '../src/shared/diagnostics'
import { addFiles, addImages, baseName, dataUrlSize, initialDraft, isDirty, isSaveAndEmailKey, saveBlock, toReportDraft, type DraftImage } from '../src/renderer/src/diagnostics/logic/draft'
import { estimateKey, formatSize, overLimit, shownEstimate, withImages } from '../src/renderer/src/diagnostics/logic/estimate'
import {
  EMPTY_FILTER,
  LOG_PAGE,
  appendLive,
  atBottom,
  copyText,
  formatLogLine,
  isFiltered,
  moveSelection,
  prependOlder,
  sourcesOf,
  toLogQuery,
  toggleLevel,
  visibleRange,
} from '../src/renderer/src/diagnostics/logic/logFilter'

// The diagnostics renderer logic: atelier://logs filters, live lines, the virtualized
// window and keyboard selection, and the problem report's
// draft limits and size line (OV-30).

const at = (h: number, m: number, s = 0, ms = 0): number => new Date(2026, 9, 29, h, m, s, ms).getTime()
const entry = (over: Partial<LogEntry> = {}): LogEntry => ({ t: at(14, 3, 7, 120), level: 'info', source: 'main', message: 'Window opened', ...over })

describe('log query filters', () => {
  const entries: LogEntry[] = [
    entry({ t: 1, level: 'debug', source: 'agent', message: 'Turn started' }),
    entry({ t: 2, level: 'info', source: 'main', message: 'Window opened', data: { count: 2 } }),
    entry({ t: 3, level: 'warn', source: 'chrome', message: 'Slow frame', data: { origin: 'https://example.test' } }),
    entry({ t: 4, level: 'error', source: 'crash', message: 'Renderer gone', data: { reason: 'oom', code: null } }),
  ]

  it('matches levels, sources, text (message, source and data, any case) and time', () => {
    expect(entries.filter((e) => matchesLogQuery(e, { levels: ['warn', 'error'] })).map((e) => e.t)).toEqual([3, 4])
    expect(entries.filter((e) => matchesLogQuery(e, { sources: ['agent'] })).map((e) => e.t)).toEqual([1])
    expect(entries.filter((e) => matchesLogQuery(e, { text: 'WINDOW' })).map((e) => e.t)).toEqual([2])
    expect(entries.filter((e) => matchesLogQuery(e, { text: 'oom' })).map((e) => e.t)).toEqual([4])
    expect(entries.filter((e) => matchesLogQuery(e, { text: 'chrome' })).map((e) => e.t)).toEqual([3])
    expect(entries.filter((e) => matchesLogQuery(e, { text: 'null' })).map((e) => e.t)).toEqual([])
    expect(entries.filter((e) => matchesLogQuery(e, { before: 3 })).map((e) => e.t)).toEqual([1, 2])
    expect(entries.filter((e) => matchesLogQuery(e, { levels: [], sources: [], text: '  ' }))).toHaveLength(4)
  })

  it('pages back from the newest lines', () => {
    expect(pageLogEntries(entries, { limit: 2 })).toEqual({ entries: entries.slice(2), hasMore: true })
    expect(pageLogEntries(entries, { limit: 2, before: 3 })).toEqual({ entries: entries.slice(0, 2), hasMore: false })
  })

  it('builds the query main receives from the filter bar', () => {
    expect(toLogQuery(EMPTY_FILTER)).toEqual({ limit: LOG_PAGE })
    expect(toLogQuery({ text: '  slow ', levels: ['warn'], source: 'chrome' }, { before: 9, limit: 50 })).toEqual({ limit: 50, levels: ['warn'], sources: ['chrome'], text: 'slow', before: 9 })
    // Every level chip on is the same as none.
    expect(toLogQuery({ ...EMPTY_FILTER, levels: ['debug', 'info', 'warn', 'error'] }).levels).toBeUndefined()
    expect(toLogQuery({ ...EMPTY_FILTER, text: 'x'.repeat(900) }).text).toHaveLength(500)
    expect(isFiltered(EMPTY_FILTER)).toBe(false)
    expect(isFiltered({ ...EMPTY_FILTER, text: ' ' })).toBe(false)
    expect(isFiltered({ ...EMPTY_FILTER, source: 'agent' })).toBe(true)
  })

  it('toggles level chips in a stable order', () => {
    expect(toggleLevel([], 'error')).toEqual(['error'])
    expect(toggleLevel(['error'], 'debug')).toEqual(['debug', 'error'])
    expect(toggleLevel(['debug', 'error'], 'debug')).toEqual(['error'])
  })

  it('appends live lines only when they match, keeping the newest', () => {
    const list = [entry({ t: 1 }), entry({ t: 2 })]
    expect(appendLive(list, entry({ t: 3, level: 'debug' }), { ...EMPTY_FILTER, levels: ['error'] })).toBeNull()
    expect(appendLive(list, entry({ t: 3 }), EMPTY_FILTER, 2)?.map((e) => e.t)).toEqual([2, 3])
    expect(prependOlder([entry({ t: 0 })], list, 2).map((e) => e.t)).toEqual([0, 1])
  })

  it('offers known sources and the ones seen, sorted', () => {
    expect(sourcesOf([entry({ source: 'zeta' }), entry({ source: 'main' })], ['main', 'agent'])).toEqual(['agent', 'main', 'zeta'])
  })

  it('formats copy text one line per entry, data last', () => {
    const line = formatLogLine(entry({ level: 'warn', data: { origin: 'https://example.test', ok: false, code: null } }))
    expect(line).toBe('2026-10-29 14:03:07.120 WARN  [main] Window opened origin=https://example.test ok=false code=null')
    expect(copyText([entry(), entry({ message: 'Second' })]).split('\n')).toHaveLength(2)
  })
})

describe('the log list window and keys', () => {
  it('draws only the rows in view, with some to spare', () => {
    expect(visibleRange(0, 200, 20, 1000, 4)).toEqual({ start: 0, end: 15 })
    expect(visibleRange(2000, 200, 20, 1000, 4)).toEqual({ start: 96, end: 115 })
    expect(visibleRange(20_000, 200, 20, 1000, 4)).toEqual({ start: 996, end: 1000 })
    expect(visibleRange(0, 200, 20, 0)).toEqual({ start: 0, end: 0 })
  })

  it('knows when it is pinned to the latest line', () => {
    expect(atBottom(780, 200, 1000)).toBe(true)
    expect(atBottom(700, 200, 1000)).toBe(false)
  })

  it('moves the selection with arrows, pages, Home and End', () => {
    expect(moveSelection('ArrowDown', null, 10, 5)).toBe(9)
    expect(moveSelection('ArrowUp', 0, 10, 5)).toBe(0)
    expect(moveSelection('ArrowDown', 3, 10, 5)).toBe(4)
    expect(moveSelection('PageDown', 8, 10, 5)).toBe(9)
    expect(moveSelection('PageUp', 3, 10, 5)).toBe(0)
    expect(moveSelection('Home', 5, 10, 5)).toBe(0)
    expect(moveSelection('End', 0, 10, 5)).toBe(9)
    expect(moveSelection('a', 3, 10, 5)).toBeNull()
    expect(moveSelection('ArrowDown', null, 0, 5)).toBeNull()
  })
})

describe('the problem report draft', () => {
  const image = (id: string, bytes: number): DraftImage => ({ id, name: `${id}.png`, dataUrl: 'data:image/png;base64,AAAA', bytes })
  const file = (token: string, bytes: number): PickedReportFile => ({ token, name: `${token}.txt`, bytes })

  it('takes up to five images, refusing ones over 5 MB', () => {
    const many = Array.from({ length: REPORT_MAX_IMAGES + 2 }, (_, i) => image(`i${i}`, 10))
    const added = addImages([], [image('big', REPORT_IMAGE_MAX_BYTES + 1), ...many])
    expect(added.images).toHaveLength(REPORT_MAX_IMAGES)
    expect(added.problems).toEqual([{ kind: 'image-too-large', name: 'big.png' }, { kind: 'too-many-images' }])
    expect(addImages([], [image('edge', REPORT_IMAGE_MAX_BYTES)]).problems).toEqual([])
  })

  it('takes up to ten files and 25 MB in all, a file picked twice once', () => {
    const ten = Array.from({ length: REPORT_MAX_FILES + 1 }, (_, i) => file(`f${i}`, 1))
    const added = addFiles([], ten)
    expect(added.files).toHaveLength(REPORT_MAX_FILES)
    expect(added.problems).toEqual([{ kind: 'too-many-files' }])
    expect(addFiles([file('a', 1)], [file('a', 1)]).files).toHaveLength(1)
    const big = addFiles([file('a', REPORT_FILES_MAX_BYTES - 10)], [file('b', 11), file('c', 10)])
    expect(big.files.map((f) => f.token)).toEqual(['a', 'c'])
    expect(big.problems).toEqual([{ kind: 'files-too-large' }])
  })

  it('reads data URL sizes', () => {
    expect(dataUrlSize('data:image/png;base64,AAAA')).toBe(3)
    expect(dataUrlSize('data:image/png;base64,AAA=')).toBe(2)
    expect(dataUrlSize('data:image/png;base64,AA==')).toBe(1)
    expect(dataUrlSize('nonsense')).toBe(0)
  })

  it('asks before discarding only when something was added', () => {
    const empty = initialDraft(false)
    expect(isDirty(empty)).toBe(false)
    expect(isDirty({ ...empty, description: '  ' })).toBe(false)
    expect(isDirty({ ...empty, description: 'It froze' })).toBe(true)
    expect(isDirty({ ...empty, files: [file('a', 1)] })).toBe(true)
    expect(initialDraft(true).includeCrash).toBe(true)
  })

  it('sends only the switches that apply', () => {
    const state = { ...initialDraft(true), description: 'It froze', includeChat: true, includeScreenshot: true, images: [image('a', 3)], files: [file('t1', 1)] }
    const chatId = '0b8c1d2e-0000-4000-8000-000000000001'
    expect(toReportDraft(state, { chatId, tabId: 'tab-1' })).toEqual({
      description: 'It froze',
      images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }],
      fileTokens: ['t1'],
      includeChatId: chatId,
      includeScreenshotTabId: 'tab-1',
      includeCrashDumps: true,
    })
    const none = toReportDraft(state, { chatId: null, tabId: null }, { withImages: false, crashAvailable: false })
    expect(none).toMatchObject({ images: [], includeChatId: null, includeScreenshotTabId: null, includeCrashDumps: false })
    expect(toReportDraft({ ...state, includeChat: false }, { chatId, tabId: null }).includeChatId).toBeNull()
  })

  it('blocks saving without a description or over the limit', () => {
    const empty = initialDraft(false)
    expect(saveBlock(empty, false)).toBe('description')
    expect(saveBlock({ ...empty, description: 'x' }, true)).toBe('too-large')
    expect(saveBlock({ ...empty, description: 'x' }, false)).toBeNull()
  })

  it('saves and emails on ⌘↩ (Ctrl+Enter off macOS) only', () => {
    const key = { key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
    expect(isSaveAndEmailKey({ ...key, metaKey: true }, true)).toBe(true)
    expect(isSaveAndEmailKey({ ...key, ctrlKey: true }, true)).toBe(false)
    expect(isSaveAndEmailKey({ ...key, ctrlKey: true }, false)).toBe(true)
    expect(isSaveAndEmailKey({ ...key, metaKey: true, shiftKey: true }, true)).toBe(false)
    expect(isSaveAndEmailKey(key, true)).toBe(false)
    expect(baseName('/Users/me/Downloads/Atelier problem report 2026-10-29 14.03.zip')).toBe('Atelier problem report 2026-10-29 14.03.zip')
    expect(baseName('C:\\Users\\me\\a.zip')).toBe('a.zip')
  })
})

describe('the size line', () => {
  const base: ReportEstimate = { bytes: 1000, overLimit: false, parts: [{ kind: 'system', bytes: 400 }, { kind: 'logs', bytes: 600 }] }

  it('adds pasted images to main’s estimate and checks the limit', () => {
    expect(withImages(base, 0)).toBe(base)
    const more = withImages(base, 500)
    expect(more.bytes).toBe(1500)
    expect(more.parts.find((p) => p.kind === 'images')?.bytes).toBe(500)
    expect(withImages(base, REPORT_MAX_BYTES).overLimit).toBe(true)
    expect(withImages(base, REPORT_MAX_BYTES - 1000).overLimit).toBe(false)
  })

  it('re-estimates on what changes the size, not on every keystroke', () => {
    const draft = { description: 'a', images: [], fileTokens: [], includeChatId: null, includeScreenshotTabId: null, includeCrashDumps: false }
    expect(estimateKey(draft, 0)).toBe(estimateKey({ ...draft, description: 'ab' }, 0))
    expect(estimateKey(draft, 0)).not.toBe(estimateKey({ ...draft, includeCrashDumps: true }, 0))
    expect(estimateKey(draft, 0)).not.toBe(estimateKey({ ...draft, description: 'x'.repeat(2048) }, 0))
  })

  it('keeps the last estimate while busy and stays blocked when it was over', () => {
    const over = { ...base, overLimit: true }
    expect(shownEstimate({ kind: 'idle' })).toBeNull()
    expect(shownEstimate({ kind: 'busy', last: base })).toBe(base)
    expect(overLimit({ kind: 'busy', last: over })).toBe(true)
    expect(overLimit({ kind: 'ready', estimate: base })).toBe(false)
    expect(overLimit({ kind: 'error' })).toBe(false)
  })

  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(25 * 1024 * 1024)).toBe('25 MB')
  })
})
