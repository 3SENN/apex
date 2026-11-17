/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { countWords } from './reveal'

// A small Markdown parser for replies. It returns a tree that Markdown.tsx
// turns into React elements, so nothing is ever set as HTML: raw tags in a
// reply stay text, and links keep only safe schemes.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'br' }

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][]; align: Array<'left' | 'center' | 'right' | null> }
  | { kind: 'rule' }

export interface ListItem {
  /** A task-list box ("- [x] done"); null for a plain item. */
  checked: boolean | null
  children: Block[]
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const BULLET = /^( *)([-*+])\s+(.*)$/
const ORDERED = /^( *)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Parses a reply into blocks. Unclosed constructs (mid-stream) degrade to text. */
export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'))
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) body.push(lines[i++] ?? '')
      i++ // the closing fence (or the end while streaming)
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = Math.min(4, heading[1]?.length ?? 1) as 1 | 2 | 3 | 4
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2] ?? '') })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) body.push(QUOTE.exec(lines[i++] ?? '')?.[1] ?? '')
      blocks.push({ kind: 'quote', children: parseBlocks(body) })
      continue
    }
    if (BULLET.exec(line) || ORDERED.exec(line)) {
      const [list, next] = parseList(lines, i)
      blocks.push(list)
      i = next
      continue
    }
    if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1] ?? '').map((cell) => {
        const c = cell.trim()
        if (c.startsWith(':') && c.endsWith(':')) return 'center' as const
        if (c.endsWith(':')) return 'right' as const
        if (c.startsWith(':')) return 'left' as const
        return null
      })
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(splitRow(lines[i++] ?? '').map(parseInline))
      }
      blocks.push({ kind: 'table', head: head.map(parseInline), rows, align })
      continue
    }
    // A paragraph runs until a blank line or the start of another block.
    const body: string[] = [line]
    i++
    while (i < lines.length) {
      const next = lines[i] ?? ''
      if (!next.trim() || FENCE.test(next) || HEADING.test(next) || RULE.test(next) || QUOTE.test(next) || BULLET.test(next) || ORDERED.test(next)) break
      body.push(next)
      i++
    }
    blocks.push({ kind: 'paragraph', children: parseInline(joinLines(body)) })
  }
  return blocks
}

/** Lines of one paragraph: a trailing double space or backslash is a hard break. */
function joinLines(lines: string[]): string {
  return lines
    .map((l, idx) => (idx < lines.length - 1 && (/ {2,}$/.test(l) || l.endsWith('\\')) ? `${l.replace(/(?: {2,}|\\)$/, '')}\u2028` : l.trim()))
    .join(' ')
    .replace(/\u2028 /g, '\u2028')
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

interface Marker {
  indent: number
  ordered: boolean
  number: number
  rest: string
}

function marker(line: string): Marker | null {
  const bullet = BULLET.exec(line)
  if (bullet) return { indent: bullet[1]?.length ?? 0, ordered: false, number: 1, rest: bullet[3] ?? '' }
  const ordered = ORDERED.exec(line)
  if (ordered) return { indent: ordered[1]?.length ?? 0, ordered: true, number: Number(ordered[2]), rest: ordered[3] ?? '' }
  return null
}

/** A list from line `start`; nested items are those indented past the marker. */
function parseList(lines: string[], start: number): [Block, number] {
  const first = marker(lines[start] ?? '')
  if (!first) return [{ kind: 'paragraph', children: [] }, start + 1]
  const items: ListItem[] = []
  let i = start
  while (i < lines.length) {
    const m = marker(lines[i] ?? '')
    if (!m || m.indent > first.indent + 1 || m.ordered !== first.ordered) break
    const body: string[] = [m.rest]
    i++
    // Continuation: indented lines (including deeper lists), and a single blank line followed by indented text.
    while (i < lines.length) {
      const next = lines[i] ?? ''
      if (!next.trim()) {
        const after = lines[i + 1] ?? ''
        if (after.trim() && indentOf(after) > first.indent) {
          body.push('')
          i++
          continue
        }
        break
      }
      const nm = marker(next)
      if (nm && nm.indent <= first.indent + 1) break
      // An unindented block start ends the list; plain text continues the item lazily.
      if (!nm && indentOf(next) <= first.indent && (FENCE.test(next) || HEADING.test(next) || RULE.test(next) || QUOTE.test(next))) break
      body.push(nm ? next.slice(Math.min(nm.indent, first.indent + 2)) : next.replace(/^\s{1,4}/, ''))
      i++
    }
    let checked: boolean | null = null
    const task = /^\[([ xX])\]\s+/.exec(body[0] ?? '')
    if (task) {
      checked = task[1] !== ' '
      body[0] = (body[0] ?? '').slice(task[0].length)
    }
    items.push({ checked, children: parseBlocks(body) })
    // A blank line between items keeps the list going.
    if (!(lines[i] ?? '').trim()) {
      let j = i
      while (j < lines.length && !(lines[j] ?? '').trim()) j++
      const nm = marker(lines[j] ?? '')
      if (nm && nm.indent <= first.indent + 1 && nm.ordered === first.ordered) i = j
    }
  }
  return [{ kind: 'list', ordered: first.ordered, start: first.number, items }, i]
}

function indentOf(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0
}

const SAFE_LINK = /^(https?:|mailto:)/i
/** A link to one of the person's tabs, by its id (`[Flights](tab:t12)`): clicking it goes to that tab. */
export const TAB_LINK = /^tab:(t\d{1,9})$/

/** Only web, mail and tab links survive; anything else (javascript:, file:) stays text. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim()
  if (SAFE_LINK.test(trimmed) || TAB_LINK.test(trimmed)) return trimmed
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`
  return null
}

/** Inline Markdown: code, links, bold, italic, strikethrough, bare URLs and hard breaks. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = (): void => {
    if (text) out.push({ kind: 'text', text })
    text = ''
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i] ?? ''
    if (ch === '\\' && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(source[i + 1] ?? '')) {
      text += source[i + 1]
      i += 2
      continue
    }
    if (ch === '\u2028') {
      flush()
      out.push({ kind: 'br' })
      i++
      continue
    }
    if (ch === '`') {
      const run = /^`+/.exec(source.slice(i))?.[0] ?? '`'
      const end = source.indexOf(run, i + run.length)
      if (end !== -1) {
        flush()
        out.push({ kind: 'code', text: source.slice(i + run.length, end).replace(/^ (.+) $/, '$1') })
        i = end + run.length
        continue
      }
    }
    if (ch === '[') {
      const link = matchLink(source, i)
      if (link) {
        const href = safeHref(link.href)
        flush()
        if (href) out.push({ kind: 'link', href, children: parseInline(link.label) })
        else out.push(...parseInline(link.label))
        i = link.end
        continue
      }
    }
    if ((ch === '*' || ch === '_' || ch === '~') && source[i + 1] === ch) {
      const delim = ch + ch
      const end = findClose(source, i + 2, delim)
      if (end !== -1 && end > i + 2) {
        flush()
        const children = parseInline(source.slice(i + 2, end))
        out.push(ch === '~' ? { kind: 'del', children } : { kind: 'strong', children })
        i = end + 2
        continue
      }
    }
    if ((ch === '*' || ch === '_') && source[i + 1] !== ch && source[i + 1] !== ' ' && source[i + 1] !== undefined) {
      // Snake_case words keep their underscores.
      const wordBefore = ch === '_' && /\w/.test(source[i - 1] ?? '')
      const end = wordBefore ? -1 : findClose(source, i + 1, ch)
      if (end !== -1 && source[end - 1] !== ' ' && !(ch === '_' && /\w/.test(source[end + 1] ?? ''))) {
        flush()
        out.push({ kind: 'em', children: parseInline(source.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if ((ch === 'h' || ch === 'w') && !/[\w/]/.test(source[i - 1] ?? '')) {
      const url = /^(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"*_~]/i.exec(source.slice(i))?.[0]
      if (url) {
        const href = safeHref(url)
        if (href) {
          flush()
          out.push({ kind: 'link', href, children: [{ kind: 'text', text: url }] })
          i += url.length
          continue
        }
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

function findClose(source: string, from: number, delim: string): number {
  let i = from
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === '`') {
      const end = source.indexOf('`', i + 1)
      if (end !== -1) {
        i = end + 1
        continue
      }
    }
    if (source.startsWith(delim, i) && (delim.length > 1 || source[i + 1] !== delim)) return i
    if (delim.length === 1 && source.startsWith(delim + delim, i)) {
      const inner = findClose(source, i + 2, delim + delim)
      if (inner !== -1) {
        i = inner + 2
        continue
      }
    }
    i++
  }
  return -1
}

function matchLink(source: string, start: number): { label: string; href: string; end: number } | null {
  let depth = 0
  let i = start
  for (; i < source.length; i++) {
    if (source[i] === '[') depth++
    else if (source[i] === ']') {
      depth--
      if (depth === 0) break
    }
  }
  if (depth !== 0 || source[i + 1] !== '(') return null
  // URLs can hold balanced parentheses (Wikipedia pages); the link ends at the one that closes.
  let close = -1
  let parens = 0
  for (let j = i + 2; j < source.length; j++) {
    if (source[j] === '(') parens++
    else if (source[j] === ')') {
      if (parens === 0) {
        close = j
        break
      }
      parens--
    }
  }
  if (close === -1) return null
  const href = source.slice(i + 2, close).trim().split(/\s+/)[0] ?? ''
  return { label: source.slice(start + 1, i), href: href.replace(/^<|>$/g, ''), end: close + 1 }
}

/** The plain text a tree shows (tests, and screen-reader summaries). */
export function markdownText(blocks: readonly Block[]): string {
  const inline = (nodes: readonly Inline[]): string =>
    nodes.map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : n.kind === 'br' ? '\n' : inline(n.children))).join('')
  return blocks
    .map((b): string => {
      switch (b.kind) {
        case 'paragraph':
        case 'heading':
          return inline(b.children)
        case 'code':
          return b.text
        case 'quote':
          return markdownText(b.children)
        case 'list':
          return b.items.map((item) => markdownText(item.children)).join('\n')
        case 'table':
          return [b.head, ...b.rows].map((row) => row.map(inline).join('\t')).join('\n')
        case 'rule':
          return ''
      }
    })
    .join('\n\n')
}

/**
 * Words the renderer animates, in its drawing order: each run of letters in
 * text, and each code span or code block as one unit. Markdown.tsx counts the
 * same way, so the word-reveal record lines up with what is drawn.
 */
export function countMarkdownWords(blocks: readonly Block[]): number {
  const inline = (nodes: readonly Inline[]): number =>
    nodes.reduce((n, node) => {
      if (node.kind === 'text') return n + countWords(node.text)
      if (node.kind === 'code') return n + 1
      if (node.kind === 'br') return n
      return n + inline(node.children)
    }, 0)
  return blocks.reduce((n, block): number => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        return n + inline(block.children)
      case 'code':
        return n + 1
      case 'quote':
        return n + countMarkdownWords(block.children)
      case 'list':
        return n + block.items.reduce((m, item) => m + countMarkdownWords(item.children), 0)
      case 'table':
        return n + [block.head, ...block.rows].reduce((m, row) => m + row.reduce((k, cell) => k + inline(cell), 0), 0)
      case 'rule':
        return n
    }
  }, 0)
}
