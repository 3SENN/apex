/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Readability, isProbablyReaderable } from '@mozilla/readability'
import { READER_LIMITS, articleText, countWords, isReaderBlock, readingMinutes, sameDocument, type ReaderArticle, type ReaderElement, type ReaderNode, type ReaderTag } from '@shared/reader'

// Reader extraction (RD-01, RD-02): Mozilla Readability on a clone of the
// document, so the page itself is never touched, then a walk that keeps only
// Apex's allowed elements and attributes. The result is plain data (text and
// small objects), never HTML: the chrome builds the view from it with React,
// so nothing from the page can run, style or submit anything there. No
// electron import, so the tests run it on fixture documents.

/** Elements kept as they are (b and i read as strong and em; h1 drops a level below the reader's own title). */
const KEEP: Readonly<Record<string, ReaderTag>> = {
  p: 'p', h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6', div: 'div', blockquote: 'blockquote', pre: 'pre', hr: 'hr', br: 'br',
  ul: 'ul', ol: 'ol', li: 'li', dl: 'dl', dt: 'dt', dd: 'dd', figure: 'figure', figcaption: 'figcaption', img: 'img',
  table: 'table', caption: 'caption', thead: 'thead', tbody: 'tbody', tfoot: 'tfoot', tr: 'tr', th: 'th', td: 'td',
  a: 'a', em: 'em', i: 'em', strong: 'strong', b: 'strong', u: 'u', s: 's', strike: 's', sub: 'sub', sup: 'sup', small: 'small',
  mark: 'mark', code: 'code', tt: 'code', kbd: 'kbd', samp: 'code', var: 'em', q: 'q', cite: 'cite', abbr: 'abbr', time: 'time',
  del: 'del', ins: 'ins', details: 'details', summary: 'summary',
}
/** Sectioning elements read as plain blocks. */
const AS_BLOCK = new Set(['section', 'article', 'main', 'header', 'footer', 'aside', 'center', 'hgroup', 'address'])
/** Never carried over, with everything inside. */
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button',
  'select', 'option', 'optgroup', 'textarea', 'svg', 'canvas', 'video', 'audio', 'source', 'track', 'link', 'meta', 'base', 'math',
  'dialog', 'slot', 'map', 'area', 'head', 'title', 'nav', 'menu', 'portal', 'fencedframe',
])
/** Containers where text between children is only whitespace from the markup. */
const NO_TEXT = new Set<ReaderTag>(['ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr'])
const TABLE_ROWS = new Set<ReaderTag>(['thead', 'tbody', 'tfoot', 'caption'])
const ID = /^[A-Za-z0-9_:.-]{1,64}$/
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i

interface Budget {
  nodes: number
  chars: number
}

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

function cleanMeta(value: string | null | undefined, max: number = READER_LIMITS.meta): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim()
  return text ? clip(text, max) : null
}

function resolve(raw: string, base: string): URL | null {
  try {
    return new URL(raw.trim(), base)
  } catch {
    return null
  }
}

/** The largest candidate of a srcset ("a.jpg 480w, b.jpg 960w" or "a.jpg 1x, b.jpg 2x"). */
export function bestSrcset(srcset: string | null): string | null {
  if (!srcset) return null
  let best: { url: string; size: number } | null = null
  for (const part of srcset.split(/,\s+/)) {
    const [url, descriptor] = part.trim().split(/\s+/)
    if (!url) continue
    const size = descriptor ? Number.parseFloat(descriptor) * (descriptor.endsWith('x') ? 1000 : 1) : 1
    if (!best || (Number.isFinite(size) && size > best.size)) best = { url, size: Number.isFinite(size) ? size : 1 }
  }
  return best?.url ?? null
}

/** An image address the reader may load: http(s), or a small inline image. */
export function imageSource(el: Element, base: string): string | null {
  const src = el.getAttribute('src')
  const placeholder = !src || /^data:/i.test(src.trim())
  const candidates = placeholder ? [bestSrcset(el.getAttribute('srcset')), el.getAttribute('data-src'), src] : [src, bestSrcset(el.getAttribute('srcset'))]
  for (const raw of candidates) {
    if (!raw) continue
    const value = raw.trim()
    if (/^data:/i.test(value)) {
      if (value.length <= READER_LIMITS.dataImage && DATA_IMAGE.test(value)) return value
      continue
    }
    const url = resolve(value, base)
    if (url && (url.protocol === 'https:' || url.protocol === 'http:') && url.href.length <= READER_LIMITS.url) return url.href
  }
  return null
}

/** Where a link goes: the web, mail, or a jump inside the article; null for anything else (javascript:, file:). */
export function linkTarget(raw: string | null, base: string, page: string): { href: string } | { anchor: string } | null {
  if (!raw) return null
  const value = raw.trim()
  if (value.startsWith('#')) {
    const id = safeDecode(value.slice(1))
    return id && ID.test(id) ? { anchor: id } : null
  }
  const url = resolve(value, base)
  if (!url || url.href.length > READER_LIMITS.url) return null
  if (url.protocol === 'mailto:') return { href: url.href }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hash && sameDocument(url.href, page)) {
    const id = safeDecode(url.hash.slice(1))
    if (id && ID.test(id)) return { anchor: id }
  }
  return { href: url.href }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function dimension(el: Element, name: string): number | undefined {
  const n = Number.parseInt(el.getAttribute(name) ?? '', 10)
  return Number.isFinite(n) && n > 0 && n <= 20_000 ? n : undefined
}

function span(el: Element, name: string): number | undefined {
  const n = Number.parseInt(el.getAttribute(name) ?? '', 10)
  return Number.isFinite(n) && n > 1 && n <= 1000 ? n : undefined
}

function hidden(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true
  const style = (el.getAttribute('style') ?? '').replace(/\s+/g, '').toLowerCase()
  return style.includes('display:none') || style.includes('visibility:hidden')
}

/**
 * Converts the children of an article element into reader nodes. Every
 * element outside the allowed set is unwrapped (its text stays) or dropped
 * with its contents; attributes are only the few the reader needs.
 */
export function toReaderNodes(root: Node, base: string, page: string, budget: Budget = { nodes: READER_LIMITS.nodes, chars: READER_LIMITS.chars }): ReaderNode[] {
  const out: ReaderNode[] = []
  for (const child of Array.from(root.childNodes)) out.push(...convert(child, base, page, budget, 0, false, null))
  return tidy(out, null, true)
}

function convert(node: Node, base: string, page: string, budget: Budget, depth: number, pre: boolean, parent: ReaderTag | null): ReaderNode[] {
  if (budget.nodes <= 0 || budget.chars <= 0) return []
  if (node.nodeType === 3) {
    let text = node.nodeValue ?? ''
    if (!pre) text = text.replace(/\s+/g, ' ')
    if (!text || (parent && NO_TEXT.has(parent) && !text.trim())) return []
    text = clip(text, budget.chars)
    budget.chars -= text.length
    budget.nodes--
    return [text]
  }
  if (node.nodeType !== 1) return []
  const el = node as Element
  const name = el.localName.toLowerCase()
  if (DROP.has(name) || hidden(el)) return []
  const tag: ReaderTag | null = KEEP[name] ?? (AS_BLOCK.has(name) ? 'div' : null)
  const kids = (as: ReaderTag | null, edges = false): ReaderNode[] => {
    if (depth >= READER_LIMITS.depth) {
      const text = clip((el.textContent ?? '').replace(/\s+/g, ' '), budget.chars)
      budget.chars -= text.length
      return text.trim() ? [text] : []
    }
    const list: ReaderNode[] = []
    for (const child of Array.from(el.childNodes)) list.push(...convert(child, base, page, budget, depth + 1, pre || as === 'pre', as ?? parent))
    return tidy(list, as, edges)
  }
  if (!tag) return kids(parent)
  const id = el.getAttribute('id') ?? (name === 'a' ? el.getAttribute('name') : null)
  const own: Partial<ReaderElement> = id && ID.test(id) ? { id } : {}
  if (tag === 'img') {
    const src = imageSource(el, base)
    if (!src) return []
    budget.nodes--
    const alt = cleanMeta(el.getAttribute('alt'), READER_LIMITS.attr)
    const width = dimension(el, 'width')
    const height = dimension(el, 'height')
    return [{ tag, src, ...(alt ? { alt } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}), ...own }]
  }
  if (tag === 'br' || tag === 'hr') {
    budget.nodes--
    return [{ tag }]
  }
  if (tag === 'a') {
    const target = linkTarget(el.getAttribute('href'), base, page)
    const children = kids(parent)
    // A link Apex won't follow keeps its text; one that is a jump target keeps its id.
    if (!target) return own.id ? [{ tag, ...own, children }] : children
    budget.nodes--
    return [{ tag, ...target, ...own, children }]
  }
  budget.nodes--
  const children = kids(tag, isReaderBlock(tag) && tag !== 'pre')
  const element: ReaderElement = { tag, ...own, children }
  if (tag === 'ol') {
    const start = Number.parseInt(el.getAttribute('start') ?? '', 10)
    if (Number.isFinite(start) && start !== 1 && Math.abs(start) <= 1_000_000) element.start = start
  }
  if (tag === 'td' || tag === 'th') {
    const colSpan = span(el, 'colspan')
    const rowSpan = span(el, 'rowspan')
    if (colSpan) element.colSpan = colSpan
    if (rowSpan) element.rowSpan = rowSpan
  }
  if (tag === 'abbr') {
    const title = cleanMeta(el.getAttribute('title'), READER_LIMITS.attr)
    if (title) element.title = title
  }
  // Empty wrappers carry nothing (an emptied div, a paragraph whose image was dropped).
  if (children.length === 0 && tag !== 'td' && tag !== 'th' && !own.id) return []
  return [element]
}

const flows = (node: ReaderNode | undefined): boolean => node !== undefined && (typeof node === 'string' || !isReaderBlock(node.tag))

/**
 * Joins neighbouring text runs, drops the markup's whitespace between blocks
 * (and at the edges of a block, with `edges`), and puts loose table rows into
 * a body, as the HTML parser would.
 */
function tidy(nodes: ReaderNode[], parent: ReaderTag | null, edges = false): ReaderNode[] {
  const merged: ReaderNode[] = []
  for (const node of nodes) {
    const last = merged[merged.length - 1]
    if (typeof node === 'string' && typeof last === 'string') merged[merged.length - 1] = last + node
    else merged.push(node)
  }
  const joined = merged.filter((node, i) => {
    if (typeof node !== 'string' || node.trim()) return true
    const before = merged[i - 1]
    const after = merged[i + 1]
    if (edges && (before === undefined || after === undefined)) return false
    return (before === undefined || flows(before)) && (after === undefined || flows(after))
  })
  if (parent !== 'table') return joined
  const out: ReaderNode[] = []
  let rows: ReaderElement | null = null
  for (const node of joined) {
    if (typeof node === 'string') continue
    if (TABLE_ROWS.has(node.tag)) {
      rows = null
      out.push(node)
    } else {
      if (!rows) {
        rows = { tag: 'tbody', children: [] }
        out.push(rows)
      }
      rows.children!.push(node)
    }
  }
  return out
}

/**
 * The header already shows the byline: a short paragraph near the top that
 * only repeats it ("By Mara Okafor") goes. Only the first few blocks are looked at.
 */
export function dropBylineEcho(body: ReaderNode[], byline: string | null): ReaderNode[] {
  if (!byline) return body
  const name = byline.toLowerCase()
  const echoes = (el: ReaderElement): boolean => {
    if (el.tag !== 'p' && el.tag !== 'div') return false
    const kids = el.children ?? []
    if (!kids.every((k) => typeof k === 'string' || (k.tag !== 'img' && !isReaderBlock(k.tag)))) return false
    const text = articleText([el]).toLowerCase().replace(/\s+/g, ' ').trim()
    return text.length <= name.length + 12 && (text === name || text === `by ${name}` || text.replace(/^by\s+/, '') === name)
  }
  let looked = 0
  const strip = (nodes: ReaderNode[]): { nodes: ReaderNode[]; done: boolean } => {
    const out: ReaderNode[] = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      if (looked >= 4) return { nodes: [...out, ...nodes.slice(i)], done: true }
      if (typeof node === 'string') {
        out.push(node)
        continue
      }
      if (echoes(node)) return { nodes: [...out, ...nodes.slice(i + 1)], done: true }
      if (node.tag === 'div' && node.children) {
        const inner = strip(node.children)
        out.push({ ...node, children: inner.nodes })
        if (inner.done) return { nodes: [...out, ...nodes.slice(i + 1)], done: true }
        continue
      }
      if (isReaderBlock(node.tag)) looked++
      out.push(node)
    }
    return { nodes: out, done: false }
  }
  return strip(body).nodes
}

/** The page reads as an article (Firefox's own test, on the live page; it reads and never changes it). */
export function pageReaderable(doc: Document): boolean {
  return isProbablyReaderable(doc)
}

/** The article in `doc`, or null when Readability finds none. The page itself is left alone. */
export function extractArticle(doc: Document, pageUrl: string): ReaderArticle | null {
  const clone = doc.cloneNode(true) as Document
  const parsed = new Readability<Node>(clone, { serializer: (node) => node }).parse()
  if (!parsed?.content) return null
  const base = (typeof doc.baseURI === 'string' && doc.baseURI) || pageUrl
  const byline = cleanMeta(parsed.byline, READER_LIMITS.title)
  const body = dropBylineEcho(toReaderNodes(parsed.content, base, pageUrl), byline)
  if (body.length === 0) return null
  const words = countWords(articleText(body))
  if (words === 0) return null
  const lang = cleanMeta(parsed.lang ?? doc.documentElement?.getAttribute('lang'), 35)
  const dir = parsed.dir === 'rtl' || parsed.dir === 'ltr' ? parsed.dir : null
  return {
    url: clip(pageUrl, READER_LIMITS.url),
    title: cleanMeta(parsed.title, READER_LIMITS.title) ?? cleanMeta(doc.title, READER_LIMITS.title) ?? '',
    byline,
    siteName: cleanMeta(parsed.siteName, READER_LIMITS.title),
    excerpt: cleanMeta(parsed.excerpt),
    lang: lang && LANG.test(lang) ? lang : null,
    dir,
    publishedTime: cleanMeta(parsed.publishedTime, 64),
    words,
    minutes: readingMinutes(words),
    body,
  }
}
