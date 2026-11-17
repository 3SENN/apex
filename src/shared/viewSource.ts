/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// View source: atelier://view-source?url=<encoded>. The page fetches the
// document through main; these pure helpers build the address, pretty-print
// markup and split a line into tokens for colouring.

export function viewSourceUrl(url: string): string {
  return `atelier://view-source?url=${encodeURIComponent(url)}`
}

/** The page address an atelier://view-source URL shows, if it is a web page. */
export function viewSourceTarget(atelierUrl: string): string | null {
  const match = /^atelier:\/\/view-source\/?\?(.*)$/i.exec(atelierUrl)
  if (!match) return null
  const target = new URLSearchParams(match[1]).get('url')
  if (!target) return null
  try {
    const parsed = new URL(target)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', '!doctype'])
const RAW = new Set(['script', 'style', 'textarea', 'pre'])

/**
 * Re-indents HTML one tag per line, two spaces per level. Text inside
 * script, style, pre and textarea is kept as it was. Not a parser: good
 * enough to read minified pages.
 */
export function prettyHtml(source: string): string {
  const out: string[] = []
  let depth = 0
  let i = 0
  const push = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed) out.push('  '.repeat(Math.max(0, depth)) + trimmed)
  }
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt < 0) {
      push(source.slice(i))
      break
    }
    if (lt > i) push(source.slice(i, lt).replace(/\s+/g, ' '))
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      const stop = end < 0 ? source.length : end + 3
      push(source.slice(lt, stop))
      i = stop
      continue
    }
    const gt = tagEnd(source, lt)
    const tag = source.slice(lt, gt)
    i = gt
    const name = /^<\/?\s*([!a-zA-Z][\w:-]*)/.exec(tag)?.[1]?.toLowerCase() ?? ''
    if (tag.startsWith('</')) {
      depth--
      push(tag)
      continue
    }
    push(tag)
    if (RAW.has(name)) {
      const close = source.toLowerCase().indexOf(`</${name}`, i)
      const stop = close < 0 ? source.length : close
      const body = source.slice(i, stop)
      // Raw text keeps its own lines, indented one level in.
      for (const line of body.split('\n')) if (line.trim()) out.push('  '.repeat(depth + 1) + line.trimEnd().replace(/^\s+/, ''))
      i = stop
      depth++
      continue
    }
    if (!VOID.has(name) && !tag.endsWith('/>')) depth++
  }
  return out.join('\n')
}

/** Where the tag starting at `lt` ends, past quoted attribute values. */
function tagEnd(source: string, lt: number): number {
  let quote: string | null = null
  for (let j = lt + 1; j < source.length; j++) {
    const c = source[j]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return j + 1
  }
  return source.length
}

export type SourceToken = { kind: 'text' | 'tag' | 'attr' | 'value' | 'comment' | 'doctype'; text: string }

/** Splits one line of markup into tokens for colouring; a line that isn't markup is one text token. */
export function tokenizeLine(line: string): SourceToken[] {
  const tokens: SourceToken[] = []
  const re = /(<!--.*?(?:-->|$))|(<!doctype[^>]*>?)|(<\/?[a-zA-Z][\w:-]*)|(\s[\w:@.-]+)(?==)|(="[^"]*"?|='[^']*'?|=[^\s>]+)|(\/?>)/gi
  let last = 0
  let inTag = false
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const [text, comment, doctype, open, name, value, close] = m
    // Attribute names and values only count inside a tag.
    if ((name || value) && !inTag) continue
    if (m.index > last) tokens.push({ kind: 'text', text: line.slice(last, m.index) })
    if (comment) tokens.push({ kind: 'comment', text })
    else if (doctype) tokens.push({ kind: 'doctype', text })
    else if (open) {
      tokens.push({ kind: 'tag', text })
      inTag = true
    } else if (name) tokens.push({ kind: 'attr', text })
    else if (value) tokens.push({ kind: 'value', text })
    else if (close) {
      tokens.push({ kind: 'tag', text })
      inTag = false
    }
    last = m.index + text.length
  }
  if (last < line.length) tokens.push({ kind: 'text', text: line.slice(last) })
  return tokens
}

/** Markup gets pretty-printing and colours; scripts, styles and plain text are shown as they came. */
export function isMarkupSource(contentType: string, text: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type) return type === 'text/html' || type === 'application/xhtml+xml' || type.endsWith('+xml') || type === 'text/xml' || type === 'application/xml' || type === 'image/svg+xml'
  return /^\s*</.test(text)
}

/** How many lines the page draws at first, and adds per "Show more". */
export const SOURCE_LINES_STEP = 4000

/** The lines to draw: the source as it came, or re-indented when pretty-printing markup. */
export function sourceLines(text: string, pretty: boolean, markup: boolean): string[] {
  const shown = pretty && markup ? prettyHtml(text) : text
  return shown.replace(/\r\n?/g, '\n').split('\n')
}
