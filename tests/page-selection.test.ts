/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { cleanLinks, cleanSelection, normalizeQuote, quoteBlock, quotePreview, withQuote } from '../src/shared/quote'
import { sameSelection, selectionBlocked, selectionMessage } from '../src/preload/page/selectionRules'

const rect = { x: 10.4, y: 20.6, width: 100, height: 18 }

describe('selection rules in the page (OV-20)', () => {
  it('never reports inside fields, passwords or guarded inputs', () => {
    expect(selectionBlocked({ tag: 'INPUT', type: 'password', autocomplete: null, editable: false })).toBe(true)
    expect(selectionBlocked({ tag: 'INPUT', type: 'text', autocomplete: null, editable: false })).toBe(true)
    expect(selectionBlocked({ tag: 'TEXTAREA', type: null, autocomplete: null, editable: false })).toBe(true)
    expect(selectionBlocked({ tag: 'DIV', type: null, autocomplete: null, editable: true })).toBe(true)
    expect(selectionBlocked({ tag: 'SPAN', type: null, autocomplete: 'one-time-code', editable: false })).toBe(true)
    expect(selectionBlocked({ tag: 'P', type: null, autocomplete: null, editable: false })).toBe(false)
    expect(selectionBlocked(null)).toBe(false)
  })

  it('reports a real selection, rounded, with web links only', () => {
    const message = selectionMessage({ text: '  Hello   world \n\n\n\nagain ', collapsed: false, rect, links: ['https://a.example/', 'javascript:void(0)', 'https://a.example/', 'mailto:x@y.z'], url: 'https://site.example/page', blocked: false })
    expect(message).toEqual({ text: 'Hello world\n\nagain', rect: { x: 10, y: 21, width: 100, height: 18 }, links: ['https://a.example/'], url: 'https://site.example/page' })
  })

  it('clears for collapsed, blocked, empty or invisible selections', () => {
    const base = { text: 'x', collapsed: false, rect, links: [], url: 'https://a.example/', blocked: false }
    expect(selectionMessage({ ...base, collapsed: true })).toEqual({ cleared: true })
    expect(selectionMessage({ ...base, blocked: true })).toEqual({ cleared: true })
    expect(selectionMessage({ ...base, text: ' \n ' })).toEqual({ cleared: true })
    expect(selectionMessage({ ...base, rect: { x: 0, y: 0, width: 0, height: 0 } })).toEqual({ cleared: true })
    expect(selectionMessage({ ...base, rect: null })).toEqual({ cleared: true })
  })

  it('does not repeat itself', () => {
    const a = selectionMessage({ text: 'x', collapsed: false, rect, links: [], url: 'https://a.example/', blocked: false })
    expect(sameSelection(a, a)).toBe(true)
    expect(sameSelection(null, a)).toBe(false)
    expect(sameSelection({ cleared: true }, { cleared: true })).toBe(true)
    expect(sameSelection({ cleared: true }, a)).toBe(false)
  })
})

describe('quotes', () => {
  it('caps text and links', () => {
    expect(cleanSelection('a'.repeat(6000))).toHaveLength(5000)
    expect(cleanLinks(Array.from({ length: 30 }, (_, i) => `https://x.example/${i}`))).toHaveLength(20)
  })

  it('reads as a block quote with its source and links', () => {
    const quote = { text: 'First line\nSecond line', url: 'https://site.example/a', links: ['https://site.example/a', 'https://other.example/b'] }
    expect(quoteBlock(quote)).toBe('> First line\n> Second line\n\nSource: https://site.example/a\nLinks in the quote: https://other.example/b')
    expect(withQuote(quote, '  What does this mean? ')).toBe(`${quoteBlock(quote)}\n\nWhat does this mean?`)
    expect(withQuote(null, 'hi')).toBe('hi')
  })

  it('a page link alone is a source line', () => {
    expect(quoteBlock({ text: '', url: 'https://site.example/', links: [] })).toBe('Source: https://site.example/')
  })

  it('previews on one line', () => {
    expect(quotePreview('a\n\nb   c')).toBe('a b c')
    expect(quotePreview('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('normalizes what the service receives', () => {
    expect(normalizeQuote({ text: ' hi ', url: 'https://a.example', links: ['ftp://x', 'https://b.example'] })).toEqual({ text: 'hi', url: 'https://a.example/', links: ['https://b.example/'] })
  })
})
