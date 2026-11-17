/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Page translation in the page (TR-07 to TR-09): which text a page offers for
// translation, how it goes out in batches, and how it comes back. Text nodes
// are changed in place, so the markup, links, styles and listeners stay as
// they are; title, alt, placeholder and aria-label are translated too. Code,
// pre, inputs, contenteditable and anything marked translate="no" or
// .notranslate are left alone. Every change is recorded, so Show original puts
// back exactly what was there (unless the page has since changed that text
// itself). It works on a minimal node shape, so tests drive it without a browser.
import { TRANSLATE_BATCH_CHARS, TRANSLATE_BATCH_ITEMS, TRANSLATE_TEXT_MAX } from '@shared/translate'

export interface TNode {
  nodeType: number
  nodeName: string
  parentNode: TNode | null
  childNodes: ArrayLike<TNode>
}
export interface TText extends TNode {
  data: string
}
export interface TElement extends TNode {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  shadowRoot?: TNode | null
}

const ELEMENT = 1
const TEXT = 3
const DOCUMENT = 9
const FRAGMENT = 11

/** Never looked into, attributes included. */
const NO_CONTENT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK'])
/** Their attributes may be translated, their contents never. */
const SKIP_CONTENT = new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT', 'SELECT', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'VIDEO', 'AUDIO'])
/** Translated attributes, and the elements each applies to (null: any). */
const ATTRIBUTES: ReadonlyArray<[string, ReadonlySet<string> | null]> = [
  ['title', null],
  ['aria-label', null],
  ['alt', new Set(['IMG', 'AREA', 'INPUT'])],
  ['placeholder', new Set(['INPUT', 'TEXTAREA'])],
]
export const TRANSLATED_ATTRIBUTES = ATTRIBUTES.map(([name]) => name)

const LETTER = /\p{L}/u

export type Segment = { kind: 'text'; node: TText } | { kind: 'attr'; el: TElement; name: string }

interface Applied {
  original: string
  applied: string
}

/** Leading and trailing white space stay where they were; only the middle is translated. */
export function splitSpace(value: string): { lead: string; core: string; trail: string } {
  const lead = /^\s*/.exec(value)?.[0] ?? ''
  if (lead.length === value.length) return { lead: value, core: '', trail: '' }
  const trail = /\s*$/.exec(value)?.[0] ?? ''
  return { lead, core: value.slice(lead.length, value.length - trail.length), trail }
}

/** Text worth translating: it has letters (numbers, symbols and white space stay as they are). */
export function translatable(core: string): boolean {
  return core.length > 0 && LETTER.test(core)
}

/** A text longer than one request allows, cut at sentence ends (or hard, when a sentence is longer still). */
export function chunkText(core: string, max = TRANSLATE_TEXT_MAX): string[] {
  if (core.length <= max) return [core]
  const sentences = core.split(/(?<=[.!?。！？])\s+/u)
  const out: string[] = []
  let current = ''
  const push = (piece: string): void => {
    for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max))
  }
  for (const s of sentences) {
    if (current && current.length + 1 + s.length > max) {
      out.push(current)
      current = ''
    }
    if (s.length > max) push(s)
    else current = current ? `${current} ${s}` : s
  }
  if (current) out.push(current)
  return out
}

/** Unique texts in order, cut into batches of at most `items` texts and `chars` characters (a longer text goes alone). */
export function makeBatches(texts: readonly string[], items = TRANSLATE_BATCH_ITEMS, chars = TRANSLATE_BATCH_CHARS): string[][] {
  const out: string[][] = []
  let batch: string[] = []
  let size = 0
  const seen = new Set<string>()
  for (const text of texts) {
    if (seen.has(text)) continue
    seen.add(text)
    if (batch.length > 0 && (batch.length >= items || size + text.length > chars)) {
      out.push(batch)
      batch = []
      size = 0
    }
    batch.push(text)
    size += text.length
  }
  if (batch.length > 0) out.push(batch)
  return out
}

const tagOf = (node: TNode): string => node.nodeName.toUpperCase()

function editable(el: TElement): boolean | null {
  const v = el.getAttribute('contenteditable')
  if (v === null) return null
  return v.toLowerCase() !== 'false'
}

/** The element's own say on translation: false for translate="no" or .notranslate, true for translate="yes", null when it says nothing. */
function ownTranslate(el: TElement): boolean | null {
  const t = el.getAttribute('translate')?.toLowerCase()
  if (t === 'no') return false
  if (/(^|\s)notranslate(\s|$)/.test(el.getAttribute('class') ?? '')) return false
  if (t === 'yes' || t === '') return true
  return null
}

function hiddenInput(el: TElement): boolean {
  return tagOf(el) === 'INPUT' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden'
}

/** Whether text under `node` may be translated, judged from its ancestors (for nodes the page adds later). */
export function contextAllows(node: TNode): boolean {
  let decided: boolean | null = null
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (p.nodeType !== ELEMENT) continue
    const el = p as TElement
    const tag = tagOf(el)
    // The document's <title> is translated with the page (it sits in <head>, which otherwise is not).
    if (tag === 'TITLE') return decided ?? true
    if (NO_CONTENT.has(tag) || SKIP_CONTENT.has(tag)) return false
    // contenteditable="false" inside an editable region is still in it: the region above decides.
    if (editable(el) === true) return false
    if (decided === null) decided = ownTranslate(el)
  }
  return decided ?? true
}

/**
 * The segments under `roots` that are not translated yet, in document order.
 * `allowRoot`: whether the roots' own context allows translation (contextAllows).
 */
export function collectSegments(roots: readonly TNode[], isApplied: (s: Segment) => boolean = () => false, allowRoot: (root: TNode) => boolean = () => true): Segment[] {
  const out: Segment[] = []
  const stack: Array<{ node: TNode; ok: boolean }> = []
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i]!, ok: allowRoot(roots[i]!) })
  while (stack.length > 0) {
    const { node, ok } = stack.pop()!
    if (node.nodeType === TEXT) {
      if (!ok) continue
      const seg: Segment = { kind: 'text', node: node as TText }
      if (translatable(splitSpace((node as TText).data).core) && !isApplied(seg)) out.push(seg)
      continue
    }
    let childOk = ok
    if (node.nodeType === ELEMENT) {
      const el = node as TElement
      const tag = tagOf(el)
      if (NO_CONTENT.has(tag) || editable(el) === true) continue
      const own = ownTranslate(el)
      const here = own ?? ok
      if (here && !hiddenInput(el)) {
        for (const [name, only] of ATTRIBUTES) {
          if (only && !only.has(tag)) continue
          const value = el.getAttribute(name)
          if (value === null || !translatable(splitSpace(value).core)) continue
          const seg: Segment = { kind: 'attr', el, name }
          if (!isApplied(seg)) out.push(seg)
        }
      }
      if (SKIP_CONTENT.has(tag)) continue
      childOk = here
      const shadow = el.shadowRoot
      if (shadow) stack.push({ node: shadow, ok: childOk })
    } else if (node.nodeType !== DOCUMENT && node.nodeType !== FRAGMENT) {
      continue
    }
    const children = node.childNodes
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, ok: childOk })
  }
  return out
}

/** Plain text from the translatable part of the page, for detecting its language. */
export function sampleText(roots: readonly TNode[], max: number): string {
  let out = ''
  for (const seg of collectSegments(roots)) {
    if (seg.kind !== 'text') continue
    const core = splitSpace(seg.node.data).core
    out = out ? `${out} ${core}` : core
    if (out.length >= max) return out.slice(0, max)
  }
  return out
}

export type TranslateTexts = (texts: string[]) => Promise<string[]>

export interface TranslateProgress {
  done: number
  total: number
}

/** One mutation as MutationObserver reports it (only the fields used here). */
export interface MutationLike {
  type: string
  target: TNode
  addedNodes?: ArrayLike<TNode>
  attributeName?: string | null
}

/**
 * Translates and restores one document. start() translates from the
 * originals; more() translates what the page added since; restore() puts
 * every original back. A run that a newer start or a restore replaced stops
 * at its next batch.
 */
export class DomTranslator {
  readonly #texts = new Map<TText, Applied>()
  readonly #attrs = new Map<TElement, Map<string, Applied>>()
  #cache = new Map<string, string>()
  #engine: TranslateTexts | null = null
  /** The current run's token: a restore or a newer start replaces it, and older runs stop at their next batch. */
  #session: object | null = null
  readonly #items: number
  readonly #chars: number

  constructor(opts: { items?: number; chars?: number } = {}) {
    this.#items = opts.items ?? TRANSLATE_BATCH_ITEMS
    this.#chars = opts.chars ?? TRANSLATE_BATCH_CHARS
  }

  get active(): boolean {
    return this.#engine !== null
  }

  /** How many texts are translated in the page right now. */
  get size(): number {
    let n = this.#texts.size
    for (const m of this.#attrs.values()) n += m.size
    return n
  }

  #current(seg: Segment): string | null {
    return seg.kind === 'text' ? seg.node.data : seg.el.getAttribute(seg.name)
  }

  #record(seg: Segment): Applied | undefined {
    return seg.kind === 'text' ? this.#texts.get(seg.node) : this.#attrs.get(seg.el)?.get(seg.name)
  }

  readonly isApplied = (seg: Segment): boolean => {
    const rec = this.#record(seg)
    return rec !== undefined && rec.applied === this.#current(seg)
  }

  #write(seg: Segment, original: string, value: string): void {
    if (seg.kind === 'text') {
      seg.node.data = value
      this.#texts.set(seg.node, { original, applied: value })
    } else {
      seg.el.setAttribute(seg.name, value)
      let m = this.#attrs.get(seg.el)
      if (!m) this.#attrs.set(seg.el, (m = new Map()))
      m.set(seg.name, { original, applied: value })
    }
  }

  /** Translates the page from its originals with `engine` (a new target starts over: the old translation is restored first). */
  async start(roots: readonly TNode[], engine: TranslateTexts, onProgress?: (p: TranslateProgress) => void): Promise<TranslateProgress | null> {
    if (this.active) this.restore()
    this.#engine = engine
    this.#session = {}
    this.#cache = new Map()
    return this.#run(roots, () => true, onProgress)
  }

  /** Translates what the page added or changed since (from a MutationObserver), while translated. */
  async more(roots: readonly TNode[], onProgress?: (p: TranslateProgress) => void): Promise<TranslateProgress | null> {
    if (!this.active || roots.length === 0) return null
    return this.#run(roots, contextAllows, onProgress)
  }

  async #run(roots: readonly TNode[], allowRoot: (root: TNode) => boolean, onProgress?: (p: TranslateProgress) => void): Promise<TranslateProgress | null> {
    const session = this.#session
    const engine = this.#engine
    if (!engine || !session) return null
    const segments = collectSegments(roots, this.isApplied, allowRoot)
    // What each segment held when collected: one the page changes meanwhile is left for the observer.
    const items = segments.map((seg) => {
      const value = this.#current(seg) ?? ''
      const parts = splitSpace(value)
      return { seg, value, parts, chunks: chunkText(parts.core), done: false }
    })
    const total = items.length
    let done = 0
    const apply = (): void => {
      for (const item of items) {
        if (item.done || !item.chunks.every((c) => this.#cache.has(c))) continue
        if (this.#current(item.seg) === item.value && !this.isApplied(item.seg)) {
          const translated = item.chunks.map((c) => this.#cache.get(c)!).join(' ')
          this.#write(item.seg, item.value, item.parts.lead + translated + item.parts.trail)
        }
        item.done = true
        done++
      }
    }
    apply()
    const wanted = items.flatMap((i) => (i.done ? [] : i.chunks)).filter((c) => !this.#cache.has(c))
    for (const batch of makeBatches(wanted, this.#items, this.#chars)) {
      const out = await engine(batch)
      // A start() and the more() runs of the same session share it; a restore or a newer start ends them.
      if (this.#session !== session) return null
      if (out.length !== batch.length) throw new Error('A translation came back with the wrong number of texts.')
      batch.forEach((text, i) => this.#cache.set(text, out[i] ?? text))
      apply()
      onProgress?.({ done, total })
    }
    apply()
    return { done, total }
  }

  /**
   * What the page changed while translated: text it rewrote becomes the new
   * original (and is translated again); our own writes are recognised and
   * skipped. Returns the nodes to hand to more().
   */
  changed(mutations: readonly MutationLike[]): TNode[] {
    if (!this.active) return []
    const roots = new Set<TNode>()
    for (const m of mutations) {
      if (m.type === 'characterData' && m.target.nodeType === TEXT) {
        const node = m.target as TText
        const rec = this.#texts.get(node)
        if (rec && rec.applied === node.data) continue
        if (rec) this.#texts.delete(node)
        roots.add(node)
      } else if (m.type === 'childList') {
        const added = m.addedNodes ?? []
        for (let i = 0; i < added.length; i++) roots.add(added[i]!)
      } else if (m.type === 'attributes' && m.attributeName && TRANSLATED_ATTRIBUTES.includes(m.attributeName) && m.target.nodeType === ELEMENT) {
        const el = m.target as TElement
        const rec = this.#attrs.get(el)?.get(m.attributeName)
        if (rec && rec.applied === el.getAttribute(m.attributeName)) continue
        if (rec) this.#attrs.get(el)?.delete(m.attributeName)
        roots.add(el)
      }
    }
    // A root inside another root is collected with it.
    return [...roots].filter((node) => {
      for (let p = node.parentNode; p; p = p.parentNode) if (roots.has(p)) return false
      return true
    })
  }

  /** Puts every original back, except text the page has itself replaced since; stops any run. */
  restore(): number {
    this.#session = null
    this.#engine = null
    let restored = 0
    for (const [node, rec] of this.#texts) {
      if (node.data === rec.applied) {
        node.data = rec.original
        restored++
      }
    }
    for (const [el, m] of this.#attrs) {
      for (const [name, rec] of m) {
        if (el.getAttribute(name) === rec.applied) {
          el.setAttribute(name, rec.original)
          restored++
        }
      }
    }
    this.#texts.clear()
    this.#attrs.clear()
    this.#cache.clear()
    return restored
  }
}
