/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, webContents: { getAllWebContents: () => [] }, dialog: {}, clipboard: {}, shell: {}, nativeImage: {} }))

import type { TaskRow } from '@shared/dialogs'
import { MARKDOWN_FN_SOURCE, markdownLink } from '@shared/pageMarkdown'
import { QR_MAX_TEXT, qrBitmap, qrDataUrl, qrMatrix, qrSvg } from '@shared/qr'
import { textFragmentUrl } from '@shared/textFragment'
import { isMarkupSource, prettyHtml, sourceLines, tokenizeLine, viewSourceTarget, viewSourceUrl } from '@shared/viewSource'
import { safeFileName } from '../src/main/pageActions'
import { buildRows } from '../src/main/taskManager'
import { formatCpu, keepSelection, moveSelection, nextSort, sortTasks, totals } from '../src/renderer/src/overlay/surfaces/menus/task-manager/taskLogic'

// Page actions and tools: copy as Markdown (OV-05), the link to a
// highlight, the QR code, view source and the task manager.

// A tiny DOM with only what the converter reads.
type FakeNode = { nodeType: number; nodeValue?: string; tagName?: string; childNodes: FakeNode[]; getAttribute(name: string): string | null }
const text = (value: string): FakeNode => ({ nodeType: 3, nodeValue: value, childNodes: [], getAttribute: () => null })
const el = (tagName: string, attrs: Record<string, string> = {}, ...kids: (FakeNode | string)[]): FakeNode => ({
  nodeType: 1,
  tagName: tagName.toUpperCase(),
  childNodes: kids.map((k) => (typeof k === 'string' ? text(k) : k)),
  getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name]! : null),
})
// The converter is page-side source by design; the test evaluates the same text.
const toMarkdown = new Function(`return (${MARKDOWN_FN_SOURCE})`)() as (root: FakeNode, title: string, url: string) => string

describe('copy page as Markdown', () => {
  it('converts headings, emphasis, links, lists, code and tables', () => {
    const root = el(
      'main',
      {},
      el('h2', {}, 'Getting started'),
      el('p', {}, 'Read ', el('strong', {}, 'this'), ' and ', el('a', { href: '/docs?a=1' }, 'the docs'), '.'),
      el('ul', {}, el('li', {}, 'One'), el('li', {}, 'Two', el('ol', {}, el('li', {}, 'Nested')))),
      el('pre', {}, el('code', { class: 'language-js' }, 'let x = 1\n')),
      el('table', {}, el('tr', {}, el('th', {}, 'A'), el('th', {}, 'B')), el('tr', {}, el('td', {}, '1'), el('td', {}, '2|3'))),
      el('script', {}, 'alert(1)'),
      el('p', { hidden: '' }, 'secret'),
    )
    const md = toMarkdown(root, 'Guide', 'https://ex.test/start')
    expect(md).toContain('# Guide')
    expect(md).toContain('<https://ex.test/start>')
    expect(md).toContain('## Getting started')
    expect(md).toContain('Read **this** and [the docs](https://ex.test/docs?a=1).')
    expect(md).toContain('- One\n- Two\n  1. Nested')
    expect(md).toContain('```js\nlet x = 1\n```')
    expect(md).toContain('| A | B |\n| --- | --- |\n| 1 | 2\\|3 |')
    expect(md).not.toContain('alert(1)')
    expect(md).not.toContain('secret')
  })

  it('drops script links, keeps blockquotes and escapes Markdown characters in text', () => {
    const md = toMarkdown(el('div', {}, el('a', { href: 'javascript:void 0' }, 'Run'), el('blockquote', {}, el('p', {}, 'Quoted *star*'))), '', '')
    expect(md).toContain('Run')
    expect(md).not.toContain('javascript:')
    expect(md).toContain('> Quoted \\*star\\*')
  })

  it('makes a Markdown link with brackets and parentheses escaped', () => {
    expect(markdownLink('A [b] c', 'https://x.test/a (1)')).toBe('[A \\[b\\] c](https://x.test/a%20%281%29)')
    expect(markdownLink('  ', 'https://x.test')).toBe('[https://x.test](https://x.test)')
  })
})

describe('link to highlight', () => {
  it('quotes short selections whole and long ones by their ends', () => {
    expect(textFragmentUrl('https://a.test/p#old', 'hello  world')).toBe('https://a.test/p#:~:text=hello%20world')
    const long = 'one two three four five six seven eight nine ten eleven twelve'
    expect(textFragmentUrl('https://a.test/', long)).toBe('https://a.test/#:~:text=one%20two%20three%20four,nine%20ten%20eleven%20twelve')
    expect(textFragmentUrl('https://a.test/', 'a-b')).toContain('a%2Db')
  })

  it('refuses when there is no link to make', () => {
    expect(textFragmentUrl('apex://chats', 'x')).toBeNull()
    expect(textFragmentUrl('https://a.test/', '   ')).toBeNull()
    expect(textFragmentUrl('not a url', 'x')).toBeNull()
  })
})

describe('QR code', () => {
  it('draws a square code as SVG and as a bitmap', () => {
    const m = qrMatrix('https://apex.test/page')
    expect(m.length).toBeGreaterThanOrEqual(21)
    expect(m.every((row) => row.length === m.length)).toBe(true)
    // Finder pattern corner.
    expect(m[0]![0]).toBe(true)
    const svg = qrSvg(m)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain(`viewBox="0 0 ${m.length + 8} ${m.length + 8}"`)
    expect(qrDataUrl('https://apex.test').startsWith('data:image/svg+xml')).toBe(true)
    const bmp = qrBitmap(m, 2)
    expect(bmp.width).toBe((m.length + 8) * 2)
    expect(bmp.data.length).toBe(bmp.width * bmp.height * 4)
  })

  it('refuses empty and overlong text', () => {
    expect(() => qrMatrix('')).toThrow()
    expect(() => qrMatrix('x'.repeat(QR_MAX_TEXT + 1))).toThrow()
  })
})

describe('view source', () => {
  it('round-trips the address and only accepts web pages', () => {
    const url = viewSourceUrl('https://a.test/x?y=1&z=2')
    expect(url).toBe('apex://view-source?url=https%3A%2F%2Fa.test%2Fx%3Fy%3D1%26z%3D2')
    expect(viewSourceTarget(url)).toBe('https://a.test/x?y=1&z=2')
    expect(viewSourceTarget('apex://view-source?url=file%3A%2F%2F%2Fetc%2Fpasswd')).toBeNull()
    expect(viewSourceTarget('apex://view-source')).toBeNull()
    expect(viewSourceTarget('apex://history')).toBeNull()
  })

  it('pretty-prints markup and keeps script text as it came', () => {
    const out = prettyHtml('<html><body><div><p>Hi</p></div><script>if (a<b) {x()}</script></body></html>')
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThan(4)
    expect(out).toContain('if (a<b) {x()}')
    expect(lines.some((l) => /^\s{2,}<p>/.test(l))).toBe(true)
  })

  it('colours tags, attributes, values and comments', () => {
    const kinds = tokenizeLine('<a href="/x" data-y=1>link</a><!-- note -->').map((t) => t.kind)
    expect(kinds).toEqual(['tag', 'attr', 'value', 'attr', 'value', 'tag', 'text', 'tag', 'tag', 'comment'])
    expect(tokenizeLine('plain text')).toEqual([{ kind: 'text', text: 'plain text' }])
  })

  it('pretty-prints and colours only markup', () => {
    expect(isMarkupSource('text/html; charset=utf-8', '')).toBe(true)
    expect(isMarkupSource('application/javascript', '<x>')).toBe(false)
    expect(isMarkupSource('', '  <!doctype html>')).toBe(true)
    expect(sourceLines('a\r\nb\rc', false, false)).toEqual(['a', 'b', 'c'])
    expect(sourceLines('<div><p>x</p></div>', true, false)).toEqual(['<div><p>x</p></div>'])
  })
})

describe('page actions', () => {
  it('makes safe file names from titles', () => {
    expect(safeFileName('a/b: c?*')).toBe('a b c')
    expect(safeFileName('   ')).toBe('page')
    expect(safeFileName('x'.repeat(300)).length).toBe(120)
  })
})

describe('task manager', () => {
  const row = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({ id, kind: 'tab', title: id, icon: null, pid: 1, memoryBytes: 0, cpuPercent: 0, canEnd: true, ...over })

  it('names processes by what they serve and orders them', () => {
    const rows = buildRows(
      [
        { pid: 10, type: 'Browser', cpuPercent: 1.234, memoryKb: 100 },
        { pid: 11, type: 'GPU', cpuPercent: 0, memoryKb: 50 },
        { pid: 12, type: 'Tab', cpuPercent: 3, memoryKb: 300 },
        { pid: 13, type: 'Utility', serviceName: 'Network Service', cpuPercent: 0, memoryKb: 20 },
      ],
      [{ id: 'tab:t1', kind: 'tab', title: 'Tab: News', icon: null, pid: 12, canEnd: true }],
    )
    expect(rows.map((r) => r.id)).toEqual(['browser', 'gpu', 'tab:t1', 'pid:13'])
    expect(rows[0]).toMatchObject({ memoryBytes: 100 * 1024, cpuPercent: 1.2, canEnd: false })
    expect(rows[2]).toMatchObject({ title: 'Tab: News', canEnd: true })
    expect(rows[3]!.title).toBe('Network Service')
  })

  it('sorts by a column and flips on a second press', () => {
    const rows = [row('a', { memoryBytes: 5, title: 'b' }), row('b', { memoryBytes: 9, title: 'a' })]
    expect(sortTasks(rows, null).map((r) => r.id)).toEqual(['a', 'b'])
    const s1 = nextSort(null, 'memory')
    expect(s1).toEqual({ key: 'memory', dir: 'desc' })
    expect(sortTasks(rows, s1).map((r) => r.id)).toEqual(['b', 'a'])
    expect(nextSort(s1, 'memory').dir).toBe('asc')
    expect(sortTasks(rows, nextSort(null, 'title')).map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('totals memory and moves and keeps the selection', () => {
    const rows = [row('a', { memoryBytes: 1024, cpuPercent: 1.05 }), row('b', { memoryBytes: 2048, cpuPercent: 2 }), row('c')]
    expect(totals(rows)).toEqual({ count: 3, memoryBytes: 3072, cpuPercent: 3.1 })
    expect(formatCpu(0.04)).toBe('0.0')
    expect(formatCpu(12.36)).toBe('12.4')
    expect(moveSelection(rows, null, 'ArrowDown')).toBe('a')
    expect(moveSelection(rows, 'a', 'ArrowUp')).toBe('a')
    expect(moveSelection(rows, 'a', 'End')).toBe('c')
    expect(moveSelection(rows, 'c', 'ArrowDown')).toBe('c')
    expect(moveSelection(rows, 'a', 'x')).toBeUndefined()
    expect(moveSelection([], null, 'ArrowDown')).toBeNull()
    expect(keepSelection(rows, 'b')).toBe('b')
    expect(keepSelection(rows, 'gone')).toBeNull()
  })
})
