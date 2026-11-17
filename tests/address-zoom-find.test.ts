/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOSED_FIND, FIND_SEED_MAX, findCount, findSeed } from '@shared/find'
import { bubbleText, canPeek, linkOpenFor } from '@shared/links'
import { looksLikeAddress, omniboxToUrl } from '@shared/url'
import { peekHeaderParts, peekLayout, PEEK_HEADER_PX } from '@shared/peekLayout'
import { ZoomStore, stepZoom, zoomKey, ZOOM_MAX, ZOOM_MIN } from '../src/main/zoom'
import { STILL_LOADING_MS, barLayout, dispositionFor, droppedText, fittingCount, stillLoading } from '../src/renderer/src/components/address'

describe('zoom (SH-45, SH-38)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('steps in 10% within 25–500%, snapping onto the grid first', () => {
    expect(stepZoom(100, 1)).toBe(110)
    expect(stepZoom(100, -1)).toBe(90)
    expect(stepZoom(95, 1)).toBe(100)
    expect(stepZoom(95, -1)).toBe(90)
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    expect(stepZoom(Number.NaN, 1)).toBe(110)
  })

  it('keys web pages by host and local files together', () => {
    expect(zoomKey('https://Docs.Example.com/a?b')).toBe('docs.example.com')
    expect(zoomKey('file:///tmp/a.html')).toBe('file')
    expect(zoomKey('atelier://settings')).toBeNull()
    expect(zoomKey('not a url')).toBeNull()
  })

  it('saves per-host levels to zoom.json, dropping 100%', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-zoom-'))
    dirs.push(dir)
    const store = ZoomStore.forDataDir(dir)
    expect(store.persistent).toBe(true)
    store.set('example.com', 130)
    store.set('other.test', 100)
    store.set('big.test', 9000)
    const saved = JSON.parse(readFileSync(join(dir, 'zoom.json'), 'utf8')) as { hosts: Record<string, number> }
    expect(saved.hosts).toEqual({ 'example.com': 130, 'big.test': ZOOM_MAX })
    const reloaded = ZoomStore.forDataDir(dir)
    expect(reloaded.get('example.com')).toBe(130)
    expect(reloaded.get('unknown.test')).toBe(100)
  })

  it('keeps private sessions in memory only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-zoom-'))
    dirs.push(dir)
    const store = new ZoomStore(null)
    store.set('example.com', 150)
    expect(store.persistent).toBe(false)
    expect(store.get('example.com')).toBe(150)
    expect(existsSync(join(dir, 'zoom.json'))).toBe(false)
  })
})

describe('find (SH-44)', () => {
  it('seeds from one line of the selection, never from passwords', () => {
    expect(findSeed('  hello   world \nsecond line', false)).toBe('hello world')
    expect(findSeed('\n\n  later line', false)).toBe('later line')
    expect(findSeed('secret', true)).toBe('')
  })

  it('cuts long selections near 250 characters at a word', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const seed = findSeed(long, false)
    expect(seed.length).toBeLessThanOrEqual(FIND_SEED_MAX)
    expect(long.startsWith(seed)).toBe(true)
    expect(seed.endsWith(' ')).toBe(false)
    expect(findSeed('x'.repeat(400), false)).toHaveLength(FIND_SEED_MAX)
  })

  it('shows n of m, no matches, searching, or nothing', () => {
    expect(findCount(CLOSED_FIND)).toEqual({ kind: 'none' })
    expect(findCount({ ...CLOSED_FIND, query: 'a', searching: true })).toEqual({ kind: 'searching' })
    expect(findCount({ ...CLOSED_FIND, query: 'a' })).toEqual({ kind: 'no-matches' })
    expect(findCount({ ...CLOSED_FIND, query: 'a', matches: 4, active: 0 })).toEqual({ kind: 'count', active: 1, matches: 4 })
  })
})

describe('links, peek and loading (SH-46, SH-43, SS-01)', () => {
  it('opens links by modifier', () => {
    const e = { button: 0, shiftKey: false, metaKey: false, ctrlKey: false }
    expect(linkOpenFor(e, true)).toBe('here')
    expect(linkOpenFor({ ...e, shiftKey: true }, true)).toBe('peek')
    expect(linkOpenFor({ ...e, metaKey: true }, true)).toBe('background-tab')
    expect(linkOpenFor({ ...e, metaKey: true, shiftKey: true }, true)).toBe('foreground-tab')
    expect(linkOpenFor({ ...e, button: 1 }, false)).toBe('background-tab')
    expect(linkOpenFor({ ...e, ctrlKey: true }, false)).toBe('background-tab')
  })

  it('peeks only web pages and files', () => {
    expect(canPeek('https://example.com/')).toBe(true)
    expect(canPeek('file:///tmp/a.pdf')).toBe(true)
    expect(canPeek('atelier://settings')).toBe(false)
    expect(canPeek('javascript:alert(1)')).toBe(false)
  })

  it('shows hovered links decoded and middle-truncated, keeping disguising characters encoded', () => {
    expect(bubbleText('https://example.com/caf%C3%A9')).toBe('https://example.com/café')
    expect(bubbleText('https://example.com/a%20b')).toBe('https://example.com/a%20b')
    const long = bubbleText(`https://example.com/${'a'.repeat(400)}`, 60)
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long).toContain('…')
  })

  it('lays the peek card and page out together', () => {
    const { card, page } = peekLayout({ width: 1400, height: 900 })
    expect(page.y).toBe(card.y + PEEK_HEADER_PX)
    expect(page.width).toBe(card.width)
    expect(card.x + card.width / 2).toBeCloseTo(700, 0)
    expect(peekHeaderParts('https://www.example.com/a?b=1')).toEqual({ host: 'example.com', path: '/a?b=1', secure: true, kind: 'web' })
    expect(peekHeaderParts('http://example.com/').secure).toBe(false)
  })

  it('shows Still loading only after 8 s of an unfinished load', () => {
    const t0 = 1_000_000
    expect(stillLoading('started', t0, t0 + STILL_LOADING_MS - 1)).toBe(false)
    expect(stillLoading('dom-ready', t0, t0 + STILL_LOADING_MS)).toBe(true)
    expect(stillLoading('finished', t0, t0 + 60_000)).toBe(false)
    expect(stillLoading('started', null, t0)).toBe(false)
  })
})

describe('typed addresses and drops (SH-36)', () => {
  it('gives typed hosts https, and local ones http', () => {
    expect(omniboxToUrl('example.com', 'google')).toBe('https://example.com/')
    expect(omniboxToUrl('localhost:5173', 'google')).toBe('http://localhost:5173/')
    expect(omniboxToUrl('10.0.0.2', 'google')).toBe('http://10.0.0.2/')
    expect(omniboxToUrl('printer.local', 'google')).toBe('http://printer.local/')
    expect(omniboxToUrl('8.8.8.8', 'google')).toBe('https://8.8.8.8/')
    expect(looksLikeAddress('nas.local:5000')).toBe(true)
    expect(looksLikeAddress('two words')).toBe(false)
  })

  it('takes the first link of a uri-list, else the text on one line', () => {
    const data = (types: Record<string, string>) => ({ getData: (t: string) => types[t] ?? '' })
    expect(droppedText(data({ 'text/uri-list': '# comment\nhttps://a.test/\nhttps://b.test/' }))).toBe('https://a.test/')
    expect(droppedText(data({ 'text/plain': '  best\n pizza  ' }))).toBe('best pizza')
    expect(droppedText(data({}))).toBe('')
  })
})

describe('bookmarks bar layout (SH-47)', () => {
  it('opens by click, modifier or middle button', () => {
    const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false }
    expect(dispositionFor(e)).toBe('here')
    expect(dispositionFor({ ...e, metaKey: true })).toBe('background')
    expect(dispositionFor({ ...e, ctrlKey: true, shiftKey: true })).toBe('foreground')
    expect(dispositionFor({ ...e, button: 1 })).toBe('background')
  })

  it('SH-47: shrinks the longest bookmark titles to a shared cap before any item overflows', () => {
    // Everything fits: no item is narrowed.
    expect(barLayout([60, 180, 90], 400)).toEqual({ count: 3, cap: 180 })
    // Tighter: the long one shrinks, the short ones keep their width.
    const tight = barLayout([60, 180, 90], 300)
    expect(tight.count).toBe(3)
    expect(60 + tight.cap + 90 + 6).toBeLessThanOrEqual(300)
    expect(60 + (tight.cap + 1) + 90 + 6).toBeGreaterThan(300)
    // Two long titles share the cap.
    expect(barLayout([180, 180, 40], 330)).toEqual({ count: 3, cap: 142 })
    // Below the floor, the last item goes behind the overflow button instead.
    expect(barLayout([180, 180, 180], 300)).toEqual({ count: 2, cap: 132 })
    expect(barLayout([180, 180, 180], 100).count).toBe(0)
    expect(barLayout([], 100)).toEqual({ count: 0, cap: 180 })
  })

  it('fits leading items and leaves room for the overflow button', () => {
    expect(fittingCount([100, 100, 100], 400)).toBe(3)
    expect(fittingCount([100, 100, 100], 300)).toBe(3)
    expect(fittingCount([100, 100, 100], 250)).toBe(2)
    expect(fittingCount([100, 100, 100], 220)).toBe(1)
    expect(fittingCount([], 100)).toBe(0)
  })
})
