/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A small Markdown subset for the guides Apex ships (first-week/guides/*.md):
// headings, paragraphs, lists, tips (> quotes), bold, italics, code and
// links to Apex pages. It returns a tree the chrome renders as React
// elements, so guide text never goes through innerHTML.

export type GuideInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: GuideInline[] }
  | { type: 'em'; children: GuideInline[] }
  | { type: 'code'; text: string }
  /** Only apex:// targets become links; anything else stays as its label. */
  | { type: 'link'; href: string; children: GuideInline[] }

export type GuideBlock =
  | { type: 'heading'; level: 1 | 2 | 3; children: GuideInline[] }
  | { type: 'paragraph'; children: GuideInline[] }
  | { type: 'list'; ordered: boolean; items: GuideInline[][] }
  | { type: 'tip'; children: GuideInline[] }

const LIST_ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/

export function parseGuide(source: string): GuideBlock[] {
  const blocks: GuideBlock[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let tip: string[] = []

  const flush = (): void => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) })
    if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items.map(parseInline) })
    if (tip.length) blocks.push({ type: 'tip', children: parseInline(tip.join(' ')) })
    paragraph = []
    list = null
    tip = []
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flush()
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, children: parseInline(heading[2]!.trim()) })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      if (paragraph.length || list) flush()
      tip.push(quote[1]!.trim())
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2]!)
      if (paragraph.length || tip.length || (list && list.ordered !== ordered)) flush()
      list ??= { ordered, items: [] }
      list.items.push(item[3]!.trim())
      continue
    }
    // An indented line continues the current list item; anything else joins the paragraph.
    if (list && /^\s+/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    if (list || tip.length) flush()
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

/** The first level-1 heading's text, used as the guide's title. */
export function guideTitle(blocks: readonly GuideBlock[]): string | null {
  const heading = blocks.find((b) => b.type === 'heading' && b.level === 1)
  return heading && heading.type === 'heading' ? inlineText(heading.children) : null
}

export function inlineText(nodes: readonly GuideInline[]): string {
  return nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : inlineText(n.children))).join('')
}

export function parseInline(text: string): GuideInline[] {
  const out: GuideInline[] = []
  let buffer = ''
  const pushText = (): void => {
    if (buffer) out.push({ type: 'text', text: buffer })
    buffer = ''
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    if (rest.startsWith('`')) {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        pushText()
        out.push({ type: 'code', text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (rest.startsWith('**')) {
      const end = text.indexOf('**', i + 2)
      if (end > i + 2) {
        pushText()
        out.push({ type: 'strong', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if ((rest.startsWith('*') || rest.startsWith('_')) && !/\s/.test(rest.charAt(1))) {
      const mark = rest.charAt(0)
      const end = text.indexOf(mark, i + 1)
      if (end > i + 1 && !/\s/.test(text.charAt(end - 1))) {
        pushText()
        out.push({ type: 'em', children: parseInline(text.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if (rest.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)
      if (link) {
        pushText()
        const children = parseInline(link[1]!)
        if (link[2]!.startsWith('apex://')) out.push({ type: 'link', href: link[2]!, children })
        else out.push(...children)
        i += link[0].length
        continue
      }
    }
    buffer += text.charAt(i)
    i++
  }
  pushText()
  return out
}
