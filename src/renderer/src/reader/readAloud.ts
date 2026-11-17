/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pickVoice, resumeOffset, speechQueue, wordRange, type QueueState, type VoiceLike } from './logic/speech'

// Read aloud in the reader (RD-06): the system voices through
// speechSynthesis, one utterance per paragraph, starting at the first
// paragraph in view. Boundary events mark the spoken word with the CSS
// Custom Highlight API, so the article's DOM is never changed, and the page
// follows along. Pause keeps the word; Resume and a speed change start again
// at that word.

/** Elements that read as one utterance each. */
const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, dt, dd, blockquote, figcaption, pre, caption, th, td, summary, [data-reader-block]'
const WORD = 'atelier-reader-word'
const LINE = 'atelier-reader-line'

interface Segment {
  node: Text
  start: number
}

export interface SpeechBlock {
  el: Element
  text: string
  segments: Segment[]
}

/** The article's text in reading order, grouped by the block each run belongs to. */
export function collectBlocks(root: HTMLElement): SpeechBlock[] {
  const blocks: SpeechBlock[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('[data-reader-silent]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  let current: SpeechBlock | null = null
  const push = (): void => {
    if (current && current.text.trim()) blocks.push(current)
  }
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    const el = text.parentElement?.closest(BLOCKS) ?? root
    if (!current || current.el !== el) {
      push()
      current = { el, text: '', segments: [] }
    }
    current.segments.push({ node: text, start: current.text.length })
    current.text += text.data
  }
  push()
  return blocks
}

function pointAt(block: SpeechBlock, index: number): { node: Text; offset: number } | null {
  let seg: Segment | undefined
  for (const s of block.segments) {
    if (s.start <= index) seg = s
    else break
  }
  if (!seg) return null
  return { node: seg.node, offset: Math.min(seg.node.data.length, index - seg.start) }
}

function rangeOf(block: SpeechBlock, start: number, end: number): Range | null {
  const a = pointAt(block, start)
  const b = pointAt(block, Math.max(start, end))
  if (!a || !b) return null
  const range = document.createRange()
  try {
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
  } catch {
    return null
  }
  return range
}

const highlights = (): HighlightRegistry | null => (typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null)

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
}

export interface ReadAloudOptions {
  root: HTMLElement
  scroller: HTMLElement
  /** The article's language, for the automatic voice. */
  lang: string | null
  onChange(state: QueueState): void
  reducedMotion(): boolean
}

export class ReadAloud {
  readonly #o: ReadAloudOptions
  #blocks: SpeechBlock[] = []
  #state: QueueState = speechQueue.initial()
  #generation = 0
  #voiceUri: string | null = null
  #rate = 1
  #timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ReadAloudOptions) {
    this.#o = options
  }

  get state(): QueueState {
    return this.#state
  }

  setVoice(uri: string | null): void {
    if (uri === this.#voiceUri) return
    this.#voiceUri = uri
    if (this.#state.status === 'playing') this.#speak()
  }

  setRate(rate: number): void {
    if (rate === this.#rate) return
    this.#rate = rate
    if (this.#state.status === 'playing') this.#speak()
  }

  play(): void {
    if (!speechAvailable()) return
    if (this.#state.status === 'playing') return
    if (this.#state.status === 'idle') this.#blocks = collectBlocks(this.#o.root)
    if (this.#blocks.length === 0) return
    this.#set(speechQueue.play(this.#state, this.#state.status === 'idle' ? this.#firstInView() : null))
    this.#speak()
  }

  pause(): void {
    if (this.#state.status !== 'playing') return
    this.#generation++
    this.#cancel()
    this.#set(speechQueue.pause(this.#state))
  }

  stop(): void {
    const status = this.#state.status
    this.#generation++
    // Only our own speech: anything else Atelier is saying keeps going.
    if (status === 'playing') this.#cancel()
    this.#clear()
    if (status !== 'idle') this.#set(speechQueue.stop())
  }

  dispose(): void {
    this.stop()
  }

  #set(next: QueueState): void {
    this.#state = next
    this.#o.onChange(next)
  }

  #cancel(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    if (speechAvailable()) window.speechSynthesis.cancel()
  }

  #clear(): void {
    const registry = highlights()
    registry?.delete(WORD)
    registry?.delete(LINE)
  }

  /** The first block whose bottom is below the controls: reading starts where you are. */
  #firstInView(): number {
    const top = this.#o.scroller.getBoundingClientRect().top + 72
    const i = this.#blocks.findIndex((b) => b.el.getBoundingClientRect().bottom > top)
    return i < 0 ? 0 : i
  }

  #voice(): SpeechSynthesisVoice | null {
    const voices = window.speechSynthesis.getVoices()
    return pickVoice(voices as unknown as VoiceLike[], this.#voiceUri, this.#o.lang, navigator.language) as unknown as SpeechSynthesisVoice | null
  }

  #follow(el: Element): void {
    const scroller = this.#o.scroller
    const box = scroller.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top >= box.top + 80 && r.bottom <= box.bottom - 96) return
    const top = scroller.scrollTop + (r.top - box.top) - box.height / 3
    scroller.scrollTo({ top: Math.max(0, top), behavior: this.#o.reducedMotion() ? 'auto' : 'smooth' })
  }

  #mark(block: SpeechBlock, start: number, end: number): void {
    const registry = highlights()
    if (!registry || typeof Highlight === 'undefined') return
    const word = rangeOf(block, start, end)
    if (word) registry.set(WORD, new Highlight(word))
  }

  #speak(): void {
    const generation = ++this.#generation
    this.#cancel()
    const index = this.#state.position.block
    const block = this.#blocks[index]
    if (!block || !block.el.isConnected) {
      this.stop()
      return
    }
    const start = resumeOffset(block.text, this.#state.position.offset)
    const text = block.text.slice(start)
    const registry = highlights()
    registry?.delete(WORD)
    const line = rangeOf(block, 0, block.text.length)
    if (registry && line && typeof Highlight !== 'undefined') registry.set(LINE, new Highlight(line))
    this.#follow(block.el)
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = this.#voice()
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang || this.#o.lang || navigator.language
    utterance.rate = this.#rate
    utterance.onboundary = (e) => {
      if (generation !== this.#generation || (e.name && e.name !== 'word')) return
      const at = start + e.charIndex
      const range = wordRange(block.text, at, e.charLength)
      this.#state = speechQueue.word(this.#state, index, at)
      if (range) this.#mark(block, range[0], range[1])
    }
    utterance.onend = () => {
      if (generation !== this.#generation) return
      const next = speechQueue.finished(this.#state, this.#blocks.length)
      this.#set(next)
      if (next.status === 'playing') this.#speak()
      else this.#clear()
    }
    utterance.onerror = (e) => {
      if (generation !== this.#generation || e.error === 'interrupted' || e.error === 'canceled') return
      this.stop()
    }
    // Speaking right after cancel() can be dropped by the engine; the next task is safe.
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (generation === this.#generation) window.speechSynthesis.speak(utterance)
    }, 0)
  }
}
