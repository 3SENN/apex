/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reader (RD-01 to RD-06): Apex's calm reading view of a web article. The page
// preload runs Mozilla Readability on a clone of the document and sends the
// article as a small tree of allowed elements (never HTML), main keeps it per
// tab, and the chrome draws it over the tab's pane while the page waits
// hidden underneath. Shared by the preload, main and the chrome.

/** Page preload ↔ main channels (the preload's isolated world only). */
export const READER_CHANNEL = {
  /** page → main: whether the page reads as an article ({ url, readerable }). */
  state: 'apex-reader:state',
  /** main → page: extract the article now ({ requestId }). */
  extract: 'apex-reader:extract',
  /** page → main: the extraction's answer. */
  result: 'apex-reader:result',
  /** main → page: look again (the address changed inside the page). */
  check: 'apex-reader:check',
} as const

/** The elements a reader article may hold; everything else is unwrapped or dropped. */
export const READER_TAGS = [
  'p', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'blockquote', 'pre', 'hr', 'br',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'figure', 'figcaption', 'img',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'a', 'em', 'strong', 'u', 's', 'sub', 'sup', 'small', 'mark', 'code', 'kbd', 'q', 'cite', 'abbr', 'time', 'del', 'ins',
  'details', 'summary',
] as const

export type ReaderTag = (typeof READER_TAGS)[number]

export interface ReaderElement {
  tag: ReaderTag
  /** a: an http(s) or mailto address, resolved against the page. */
  href?: string
  /** a: a jump inside the article (the target's `id`). */
  anchor?: string
  /** img: an http(s) address or a small data:image URL. */
  src?: string
  alt?: string
  width?: number
  height?: number
  /** ol: the first number. */
  start?: number
  colSpan?: number
  rowSpan?: number
  /** A jump target inside the article; the chrome prefixes it so it never clashes with its own ids. */
  id?: string
  /** abbr: the expansion. */
  title?: string
  children?: ReaderNode[]
}

/** Text, or an allowed element. */
export type ReaderNode = string | ReaderElement

export interface ReaderArticle {
  url: string
  title: string
  byline: string | null
  siteName: string | null
  excerpt: string | null
  /** BCP 47, from the page. */
  lang: string | null
  dir: 'ltr' | 'rtl' | null
  publishedTime: string | null
  words: number
  minutes: number
  body: ReaderNode[]
}

/** What a tab's TabInfo says about the reader: absent when the page isn't an article. */
export type ReaderTabState = 'available' | 'open'

export const READER_LIMITS = {
  /** Elements and text runs in one article. */
  nodes: 40_000,
  depth: 48,
  /** Characters of article text. */
  chars: 600_000,
  url: 4096,
  /** A data:image source; larger inline images are left out. */
  dataImage: 262_144,
  meta: 1024,
  title: 512,
  attr: 512,
  id: 64,
} as const

/** Services.reader (window-scoped: tab ids are the window's own). */
export interface ReaderServices {
  reader: {
    /** Opens the reader on a tab, or closes it; resolves to whether it is open now. */
    toggle(tabId: string): Promise<boolean>
    /** Extracts the article (again) and shows it; throws when the page has none. */
    open(tabId: string): Promise<boolean>
    close(tabId: string): void
    /** The article an open reader shows; null when the tab isn't in the reader. */
    article(tabId: string): ReaderArticle | null
  }
}

export type PageReaderState = { url: string; readerable: boolean }
export type PageReaderRequest = { requestId: number }
export type PageReaderResult = { requestId: number; ok: true; article: ReaderArticle } | { requestId: number; ok: false; error: string }

// ---- reading time ----

/** Average silent reading speed in words a minute. */
export const WORDS_PER_MINUTE = 230
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu

/** Words in a text; scripts without spaces count about one word per two characters. */
export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  const rest = cjk > 0 ? text.replace(CJK, ' ') : text
  const words = rest.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)?.length ?? 0
  return words + Math.ceil(cjk / 2)
}

/** Whole minutes to read, at least one. */
export function readingMinutes(words: number, wpm = WORDS_PER_MINUTE): number {
  return Math.max(1, Math.round(words / wpm))
}

// ---- text ----

const BLOCKS = new Set<ReaderTag>(['p', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'blockquote', 'pre', 'li', 'dt', 'dd', 'figure', 'figcaption', 'table', 'caption', 'tr', 'details', 'summary', 'ul', 'ol', 'dl'])

/** Whether an element starts its own block (a paragraph, a heading, a list item). */
export function isReaderBlock(tag: ReaderTag): boolean {
  return BLOCKS.has(tag)
}

/**
 * The article as plain text: one paragraph per block, list items with a
 * dash, table cells with tabs. For read aloud and for the companion.
 */
export function articleText(body: readonly ReaderNode[]): string {
  const out: string[] = []
  let line = ''
  const flush = (): void => {
    const text = line.replace(/[ \u00a0]+/g, ' ').trim()
    if (text) out.push(text)
    line = ''
  }
  const walk = (nodes: readonly ReaderNode[], pre: boolean): void => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        line += pre ? node : node.replace(/\s+/g, ' ')
        continue
      }
      if (node.tag === 'img') {
        continue
      }
      if (node.tag === 'br') {
        if (pre) line += '\n'
        else flush()
        continue
      }
      if (node.tag === 'hr') {
        flush()
        continue
      }
      if (node.tag === 'td' || node.tag === 'th') {
        if (line.trim()) line += '\t'
        walk(node.children ?? [], pre)
        continue
      }
      const block = isReaderBlock(node.tag)
      if (block) flush()
      if (node.tag === 'li') line += '- '
      walk(node.children ?? [], pre || node.tag === 'pre')
      if (block) flush()
    }
  }
  walk(body, false)
  flush()
  return out.join('\n\n')
}

/** The text handed to a chat: the title, who wrote it, the address and the article. */
export function articleForChat(article: Pick<ReaderArticle, 'title' | 'byline' | 'siteName' | 'url' | 'body'>, maxChars = 200_000): string {
  const head = [article.title, [article.byline, article.siteName].filter(Boolean).join(' · '), article.url].filter((s) => s && s.trim())
  const text = `${head.join('\n')}\n\n${articleText(article.body)}`
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** Counts the elements and text runs in a body (main's size check). */
export function countNodes(nodes: readonly ReaderNode[]): number {
  let n = 0
  const stack: ReaderNode[] = [...nodes]
  while (stack.length > 0) {
    const node = stack.pop()!
    n++
    if (typeof node !== 'string' && node.children) stack.push(...node.children)
  }
  return n
}

/** Only web pages and local files can open in the reader. */
export function readerAllowedUrl(url: string): boolean {
  return /^(https?|file):/i.test(url)
}

/** Two addresses name the same document (the fragment doesn't count). */
export function sameDocument(a: string, b: string): boolean {
  const strip = (u: string): string => u.replace(/#.*$/, '')
  return strip(a) === strip(b)
}
