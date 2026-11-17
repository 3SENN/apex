/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { describeHost, displayHost, lookalikeOf, middleTruncate, mixesScripts, skeleton } from '@shared/domains'
import {
  BUILT_IN_SEARCH_ENGINES,
  customEngineId,
  engineFaviconUrl,
  engineSearchUrl,
  parseSuggestions,
  resolveEngine,
  templateProblem,
  validateCustomEngine,
} from '@shared/searchEngines'
import { charsetOf, parseLinkPreview } from '../src/main/linkPreviewParse'
import { pillParts } from '../src/renderer/src/components/address'

describe('lookalike domains', () => {
  it('strips www and finds the registrable domain', () => {
    const d = displayHost('https://www.docs.example.co.uk/path')
    expect(d.display).toBe('docs.example.co.uk')
    expect(d.registrable).toBe('example.co.uk')
    expect(d.display.slice(...d.registrableRange)).toBe('example.co.uk')
    expect(d.lookalike).toBe(false)
    expect(displayHost('not a url').display).toBe('')
  })

  it('shows safe Unicode hosts decoded', () => {
    const d = describeHost('xn--mnchen-3ya.de')
    expect(d.display).toBe('münchen.de')
    expect(d.punycodeWarning).toBe(true)
    expect(d.lookalike).toBe(false)
  })

  it('keeps punycode and flags a host that imitates a popular domain', () => {
    // "аpple.com" with a Cyrillic а.
    const host = new URL('https://аpple.com/').hostname
    const d = describeHost(host)
    expect(d.lookalike).toBe(true)
    expect(d.lookalikeOf).toBe('apple.com')
    expect(d.display.startsWith('xn--')).toBe(true)
    expect(lookalikeOf('apple.com')).toBeNull()
    expect(lookalikeOf('g00gle.com')).toBe('google.com')
    expect(skeleton('rnicrosoft')).toBe('microsoft')
  })

  it('flags labels that mix scripts', () => {
    expect(mixesScripts('pаypal')).toBe(true)
    expect(mixesScripts('paypal')).toBe(false)
    expect(mixesScripts('例え')).toBe(false)
  })

  it('middle-truncates long hosts, and the pill warns on lookalikes', () => {
    expect(middleTruncate('a'.repeat(10), 20)).toBe('a'.repeat(10))
    const cut = middleTruncate('abcdefghijklmnopqrstuvwxyz', 11)
    expect(cut).toHaveLength(11)
    expect(cut).toContain('…')
    expect(pillParts('https://аpple.com/', 'Apple', null).lookalike).toBe(true)
    expect(pillParts('https://www.apple.com/', 'Apple', null)).toMatchObject({ host: 'apple.com', lookalike: false })
  })
})

describe('search engines (ST-31)', () => {
  it('validates custom templates', () => {
    expect(templateProblem('')).toBe('empty')
    expect(templateProblem('not a url')).toBe('invalid')
    expect(templateProblem('http://example.com/?q=%s')).toBe('https')
    expect(templateProblem('https://example.com/search')).toBe('placeholder')
    expect(templateProblem('https://example.com/search?q=%s')).toBeNull()
  })

  it('builds a custom engine with a free id, or says what is missing', () => {
    expect(validateCustomEngine('', 'https://x.test/?q=%s', [])).toEqual({ nameError: true, problem: null })
    expect(validateCustomEngine('Mine', 'http://x.test/?q=%s', [])).toEqual({ nameError: false, problem: 'https' })
    const first = validateCustomEngine('  My   Search ', 'https://x.test/?q=%s', [])
    expect(first).toEqual({ engine: { id: 'my-search', name: 'My Search', template: 'https://x.test/?q=%s' } })
    const second = validateCustomEngine('My Search', 'https://y.test/?q=%s', [{ id: 'my-search', name: 'My Search', template: 'https://x.test/?q=%s' }])
    expect('engine' in second && second.engine.id).toBe('my-search-2')
    expect(customEngineId(BUILT_IN_SEARCH_ENGINES[0]?.id ?? 'google', [])).not.toBe(BUILT_IN_SEARCH_ENGINES[0]?.id)
  })

  it('resolves ids, falling back to the first built-in engine', () => {
    const first = BUILT_IN_SEARCH_ENGINES[0]
    expect(resolveEngine('missing', []).id).toBe(first?.id)
    const custom = { id: 'mine', name: 'Mine', template: 'https://x.test/?q=%s' }
    expect(resolveEngine('mine', [custom]).template).toBe(custom.template)
    expect(resolveEngine('mine', [{ ...custom, template: 'http://x.test/?q=%s' }]).id).toBe(first?.id)
    expect(engineSearchUrl(custom, 'a b&c')).toBe('https://x.test/?q=a%20b%26c')
    expect(engineFaviconUrl(custom)).toBe('https://x.test/favicon.ico')
  })

  it('reads suggestion responses without the query or repeats', () => {
    expect(parseSuggestions(['pizza', ['pizza', 'pizza near me', 'Pizza Near Me', 'pizza dough']], 'pizza')).toEqual(['pizza near me', 'pizza dough'])
    expect(parseSuggestions([{ phrase: 'a' }, { phrase: 'b' }], 'x')).toEqual(['a', 'b'])
    expect(parseSuggestions({ nope: true }, 'x')).toEqual([])
    expect(parseSuggestions(['q', Array.from({ length: 20 }, (_, i) => `s${i}`)], 'q')).toHaveLength(5)
  })
})

describe('link preview parser', () => {
  it('prefers og and twitter tags, falling back to the title', () => {
    const html = `<html><head>
      <title>Plain &amp; title</title>
      <meta property="og:title" content="OG &quot;Title&quot;">
      <meta name='description' content='A description'>
      <meta property="og:site_name" content="Example Site">
      <meta property="og:image" content="/img/card.png">
    </head><body><meta property="og:title" content="ignored"></body></html>`
    const p = parseLinkPreview(html, 'https://www.example.com/a')
    expect(p.title).toBe('OG "Title"')
    expect(p.description).toBe('A description')
    expect(p.siteName).toBe('Example Site')
    expect(p.domain).toBe('example.com')
    expect(p.imageUrl).toBe('https://www.example.com/img/card.png')
    expect(p.image).toBeNull()
    expect(parseLinkPreview('<title> Only <b>title</b> </title>', 'https://x.test/').title).toBe('Only title')
  })

  it('keeps https images only, caps text and reads the charset', () => {
    const p = parseLinkPreview(`<meta property="og:image" content="http://x.test/a.png"><meta name="description" content="${'word '.repeat(200)}">`, 'http://x.test/')
    expect(p.imageUrl).toBeNull()
    expect((p.description ?? '').length).toBeLessThanOrEqual(300)
    expect(charsetOf('text/html; charset="ISO-8859-1"')).toBe('iso-8859-1')
    expect(charsetOf(null)).toBe('utf-8')
  })
})
