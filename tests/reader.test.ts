/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { articleForChat, articleText, countNodes, countWords, readingMinutes, sameDocument, type ReaderArticle, type ReaderElement, type ReaderNode } from '@shared/reader'
import { nextTextSize, READER_TEXT_SIZE } from '@shared/readerPrefs'
import { SETTINGS } from '@shared/settingsRegistry'
import { shortcutById } from '@shared/shortcuts'
import { bestSrcset, dropBylineEcho, extractArticle, imageSource, linkTarget, pageReaderable, toReaderNodes } from '../src/preload/page/readerExtract'
import { READER_SCHEMAS, articleSchema, pageResultSchema, pageStateSchema } from '../src/main/reader/schemas'
import { ReaderTabs } from '../src/main/reader/state'
import { DEFAULT_SETTINGS, settingsPatchSchema } from '../src/main/settings'
import { clampTextSize, nearestRate, readerLook, readerSurface, ScrollMemory, sizeBounds } from '../src/renderer/src/reader/logic/view'
import { pickVoice, resumeOffset, sortVoices, speechQueue, wordRange, type VoiceLike } from '../src/renderer/src/reader/logic/speech'

// Reader (RD-01 to RD-06): readerable detection and extraction on local
// fixtures (linkedom stands in for the page), main's checks on what a page
// sends, the per-tab state, and the view's and read aloud's rules.

const PAGE = 'https://shore.example/coast/tide-pools'
const fixture = (name: string): Document => parseHTML(readFileSync(join(__dirname, 'fixtures', 'reader', name), 'utf8')).document as unknown as Document
const elements = (nodes: readonly ReaderNode[]): ReaderElement[] => {
  const out: ReaderElement[] = []
  const walk = (list: readonly ReaderNode[]): void => {
    for (const n of list) {
      if (typeof n === 'string') continue
      out.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}
const article = (): ReaderArticle => {
  const a = extractArticle(fixture('article.html'), PAGE)
  if (!a) throw new Error('no article')
  return a
}

describe('readerable detection (RD-01)', () => {
  it('finds the article page and not the shop front', () => {
    expect(pageReaderable(fixture('article.html'))).toBe(true)
    expect(pageReaderable(fixture('front-page.html'))).toBe(false)
  })

  it('leaves the page itself untouched while extracting', () => {
    const doc = fixture('article.html')
    const before = doc.body.innerHTML
    expect(extractArticle(doc, PAGE)).not.toBeNull()
    expect(doc.body.innerHTML).toBe(before)
  })

  it('finds no article on the shop front', () => {
    expect(extractArticle(fixture('front-page.html'), 'https://shop.example/')?.words ?? 0).toBeLessThan(60)
  })
})

describe('extraction (RD-01, RD-02)', () => {
  it('reads the title, byline, site, language, date and reading time', () => {
    const a = article()
    expect(a.title).toBe('How Tide Pools Keep Time')
    expect(a.byline).toBe('Mara Okafor')
    expect(a.siteName).toBe('The Shoreline Journal')
    expect(a.lang).toBe('en-GB')
    expect(a.publishedTime).toBe('2026-03-14T08:30:00Z')
    expect(a.words).toBeGreaterThan(350)
    expect(a.minutes).toBe(readingMinutes(a.words))
    expect(a.url).toBe(PAGE)
  })

  it('keeps images with absolute sources, lazy ones included', () => {
    const imgs = elements(article().body).filter((e) => e.tag === 'img')
    expect(imgs.map((i) => i.src)).toEqual(['https://shore.example/images/pool.jpg', 'https://shore.example/images/crab.jpg'])
    expect(imgs[0]).toMatchObject({ alt: 'A tide pool at low water, ringed with green weed', width: 1200, height: 800 })
  })

  it('keeps web and mail links, makes in-page links jumps and drops script links', () => {
    const els = elements(article().body)
    const links = els.filter((e) => e.tag === 'a')
    expect(links.map((l) => l.href ?? `#${l.anchor}`)).toEqual(['https://example.org/research/tidal-clocks', '#notes', 'mailto:letters@example.org'])
    expect(els.some((e) => e.id === 'notes' && e.tag === 'h3')).toBe(true)
    expect(articleText(article().body)).toContain('Read more in our interactive guide or write to us')
  })

  it('carries only allowed elements: no scripts, frames, forms, buttons or navigation', () => {
    const a = article()
    const tags = new Set(elements(a.body).map((e) => e.tag as string))
    for (const bad of ['script', 'style', 'iframe', 'form', 'input', 'button', 'nav', 'svg']) expect(tags.has(bad), bad).toBe(false)
    const text = articleText(a.body)
    expect(text).not.toContain('trackEverything')
    expect(text).not.toContain('Subscribe')
    expect(text).not.toContain('Share')
    expect(articleSchema.safeParse(a).success).toBe(true)
  })

  it('puts loose table rows in a body and keeps lists and headings', () => {
    const els = elements(article().body)
    const table = els.find((e) => e.tag === 'table')!
    expect((table.children ?? []).every((c) => typeof c !== 'string' && c.tag === 'tbody')).toBe(true)
    expect(els.filter((e) => e.tag === 'li')).toHaveLength(3)
    expect(els.some((e) => e.tag === 'h2')).toBe(true)
    expect(els.some((e) => (e.tag as string) === 'h1')).toBe(false)
  })

  it('drops the markup whitespace between blocks but keeps spaces between words', () => {
    const { document } = parseHTML('<div id="r"><p>One <em>two</em> <strong>three</strong></p>\n  <p>Four</p></div>')
    const nodes = toReaderNodes(document.getElementById('r') as unknown as Node, PAGE, PAGE)
    expect(nodes).toEqual([
      { tag: 'p', children: ['One ', { tag: 'em', children: ['two'] }, ' ', { tag: 'strong', children: ['three'] }] },
      { tag: 'p', children: ['Four'] },
    ])
  })

  it('drops a paragraph that only repeats the byline', () => {
    expect(articleText(article().body)).not.toContain('By Mara Okafor')
    const body: ReaderNode[] = [{ tag: 'div', children: [{ tag: 'p', children: ['By Ann Lee'] }, { tag: 'p', children: ['Ann Lee wrote this.'] }] }]
    expect(articleText(dropBylineEcho(body, 'Ann Lee'))).toBe('Ann Lee wrote this.')
    expect(dropBylineEcho(body, null)).toBe(body)
    expect(articleText(dropBylineEcho([{ tag: 'p', children: ['Text'] }, { tag: 'p', children: ['b'] }, { tag: 'p', children: ['c'] }, { tag: 'p', children: ['d'] }, { tag: 'p', children: ['e'] }, { tag: 'p', children: ['Ann Lee'] }], 'Ann Lee'))).toContain('Ann Lee')
  })

  it('stops at the size budget', () => {
    const { document } = parseHTML(`<div id="r">${'<p>word word word</p>'.repeat(50)}</div>`)
    const nodes = toReaderNodes(document.getElementById('r') as unknown as Node, PAGE, PAGE, { nodes: 10, chars: 1000 })
    expect(countNodes(nodes)).toBeLessThanOrEqual(12)
  })
})

describe('link and image rules (RD-02)', () => {
  it('resolves links and refuses other schemes', () => {
    expect(linkTarget('/a?b=1', PAGE, PAGE)).toEqual({ href: 'https://shore.example/a?b=1' })
    expect(linkTarget('#fn-1', PAGE, PAGE)).toEqual({ anchor: 'fn-1' })
    expect(linkTarget(`${PAGE}#notes`, PAGE, PAGE)).toEqual({ anchor: 'notes' })
    expect(linkTarget('javascript:alert(1)', PAGE, PAGE)).toBeNull()
    expect(linkTarget('file:///etc/passwd', PAGE, PAGE)).toBeNull()
    expect(linkTarget('data:text/html,hi', PAGE, PAGE)).toBeNull()
    expect(linkTarget(null, PAGE, PAGE)).toBeNull()
  })

  it('picks the largest srcset candidate and refuses unsafe image sources', () => {
    expect(bestSrcset('a.jpg 480w, b.jpg 960w, c.jpg 640w')).toBe('b.jpg')
    expect(bestSrcset('a.jpg 1x, b.jpg 2x')).toBe('b.jpg')
    const img = (attrs: string): Element => (parseHTML(`<img ${attrs}>`).document.querySelector('img') as unknown as Element)
    expect(imageSource(img('src="javascript:alert(1)"'), PAGE)).toBeNull()
    expect(imageSource(img('src="data:text/html;base64,PGI+"'), PAGE)).toBeNull()
    expect(imageSource(img('src="data:image/png;base64,iVBORw0KGgo="'), PAGE)).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(imageSource(img('src="data:image/gif;base64,R0lGOD" srcset="/x.jpg 1x, /y.jpg 2x"'), PAGE)).toBe('https://shore.example/y.jpg')
  })
})

describe('main checks what a page sends (RD-01)', () => {
  const ok = (body: ReaderNode[]) => articleSchema.safeParse({ ...article(), body }).success
  it('refuses elements, links and images outside the allowed set', () => {
    expect(ok([{ tag: 'p', children: ['fine'] }])).toBe(true)
    expect(ok([{ tag: 'script' as never, children: ['x'] }])).toBe(false)
    expect(ok([{ tag: 'a', href: 'javascript:alert(1)', children: ['x'] }])).toBe(false)
    expect(ok([{ tag: 'img', src: 'file:///etc/hosts' }])).toBe(false)
    expect(ok([{ tag: 'p', href: 'https://a.example', children: ['x'] }])).toBe(false)
    expect(ok([{ tag: 'p', onclick: 'x', children: ['x'] } as never])).toBe(false)
    expect(ok([])).toBe(false)
  })

  it('validates the page channel and the service arguments', () => {
    expect(pageStateSchema.safeParse({ url: PAGE, readerable: true }).success).toBe(true)
    expect(pageStateSchema.safeParse({ url: PAGE, readerable: 'yes' }).success).toBe(false)
    expect(pageResultSchema.safeParse({ requestId: 1, ok: false, error: 'no-article' }).success).toBe(true)
    expect(pageResultSchema.safeParse({ requestId: 1, ok: true, article: { title: 'x' } }).success).toBe(false)
    expect(READER_SCHEMAS.reader.toggle.safeParse(['tab-1']).success).toBe(true)
    expect(READER_SCHEMAS.reader.toggle.safeParse([42]).success).toBe(false)
  })
})

describe('reader state per tab (RD-03)', () => {
  it('shows the button once the page reports an article, and opens and closes', () => {
    const s = new ReaderTabs()
    expect(s.tabState('t')).toBeUndefined()
    expect(s.report('t', PAGE, true)).toBe(true)
    expect(s.tabState('t')).toBe('available')
    expect(s.report('t', PAGE, true)).toBe(false)
    s.opened('t', article())
    expect(s.tabState('t')).toBe('open')
    expect(s.isOpen('t')).toBe(true)
    expect(s.article('t')?.title).toBe('How Tide Pools Keep Time')
    // A later report that the page no longer reads as an article keeps an open reader open.
    s.report('t', PAGE, false)
    expect(s.tabState('t')).toBe('open')
    expect(s.closed('t')).toBe(true)
    expect(s.closed('t')).toBe(false)
    expect(s.tabState('t')).toBeUndefined()
  })

  it('closes on a new document, stays open on a move inside the page', () => {
    const s = new ReaderTabs()
    s.report('t', PAGE, true)
    s.opened('t', article())
    expect(s.navigated('t', `${PAGE}#notes`, true)).toBe(false)
    expect(s.isOpen('t')).toBe(true)
    expect(s.navigated('t', 'https://shore.example/next', false)).toBe(true)
    expect(s.isOpen('t')).toBe(false)
    expect(s.tabState('t')).toBeUndefined()
    s.forget('t')
    expect(s.navigated('t', PAGE, false)).toBe(false)
    expect(sameDocument(`${PAGE}#a`, PAGE)).toBe(true)
  })
})

describe('reader view state (RD-02, RD-05)', () => {
  it('resolves the page colours against Apex’s mode', () => {
    expect(readerSurface('auto', 'dark')).toBe('dark')
    expect(readerSurface('auto', 'light')).toBe('light')
    expect(readerSurface('sepia', 'dark')).toBe('sepia')
    expect(readerSurface('light', 'dark')).toBe('light')
  })

  it('turns the preferences into the column’s look', () => {
    const look = readerLook({ font: 'sans', size: 99, width: 'wide', theme: 'auto' }, 'light')
    expect(look).toMatchObject({ surface: 'light', font: 'sans', size: READER_TEXT_SIZE.max, measure: 44 })
    expect(look.leading).toBeCloseTo(1.55)
    expect(readerLook({ font: 'serif', size: 14, width: 'narrow', theme: 'dark' }, 'light')).toMatchObject({ surface: 'dark', size: 14, measure: 30, leading: 1.7 })
    expect(clampTextSize(Number.NaN)).toBe(READER_TEXT_SIZE.default)
  })

  it('steps the text size and knows its ends', () => {
    expect(nextTextSize(20, 1)).toBe(22)
    expect(nextTextSize(20, -1)).toBe(18)
    expect(nextTextSize(21, 1)).toBe(22)
    expect(nextTextSize(32, 1)).toBe(32)
    expect(nextTextSize(14, -1)).toBe(14)
    expect(sizeBounds(14)).toEqual({ smaller: false, larger: true })
    expect(sizeBounds(32)).toEqual({ smaller: true, larger: false })
    expect(nearestRate(1.3)).toBe(1.25)
  })

  it('remembers where each article was, within a limit', () => {
    const m = new ScrollMemory(2)
    m.remember(ScrollMemory.key('a', PAGE), 300)
    m.remember(ScrollMemory.key('b', PAGE), 120)
    m.remember(ScrollMemory.key('c', PAGE), 50)
    expect(m.recall(ScrollMemory.key('a', PAGE))).toBe(0)
    expect(m.recall(ScrollMemory.key('b', PAGE))).toBe(120)
    m.remember(ScrollMemory.key('b', PAGE), 0)
    expect(m.recall(ScrollMemory.key('b', PAGE))).toBe(0)
  })

  it('registers its settings with defaults the schemas accept', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ readerFont: 'serif', readerTextSize: 20, readerWidth: 'medium', readerTheme: 'auto', readerVoice: null, readerRate: 1, readerButton: true })
    for (const key of ['readerFont', 'readerTextSize', 'readerWidth', 'readerTheme', 'readerVoice', 'readerRate', 'readerButton'] as const) expect(SETTINGS[key].scope).toBe('app')
    expect(settingsPatchSchema.safeParse({ readerTheme: 'sepia', readerTextSize: 24 }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ readerTheme: 'neon' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ readerRate: 5 }).success).toBe(false)
  })

  it('has its shortcut on ⌥⌘R, clear of Force Reload', () => {
    expect(shortcutById('toggle-reader')?.keys.mac).toBe('Alt+Cmd+R')
    expect(shortcutById('hard-reload')?.keys.mac).toBe('Cmd+Shift+R')
  })
})

describe('text for read aloud and the companion (RD-06)', () => {
  it('lays the article out as paragraphs, list items and cells', () => {
    const text = articleText([
      { tag: 'h2', children: ['Head'] },
      { tag: 'p', children: ['A ', { tag: 'em', children: ['b'] }, ' c.'] },
      { tag: 'ul', children: [{ tag: 'li', children: ['one'] }, { tag: 'li', children: ['two'] }] },
      { tag: 'table', children: [{ tag: 'tbody', children: [{ tag: 'tr', children: [{ tag: 'td', children: ['x'] }, { tag: 'td', children: ['y'] }] }] }] },
      { tag: 'img', src: 'https://a.example/i.png' },
    ])
    expect(text).toBe('Head\n\nA b c.\n\n- one\n\n- two\n\nx\ty')
  })

  it('hands the companion the title, byline, address and text', () => {
    const chat = articleForChat(article())
    expect(chat.startsWith('How Tide Pools Keep Time\nMara Okafor · The Shoreline Journal\nhttps://shore.example/coast/tide-pools\n\n')).toBe(true)
    expect(articleForChat(article(), 100)).toHaveLength(100)
  })

  it('counts words, scripts without spaces too', () => {
    expect(countWords('The tide comes in, the tide goes out.')).toBe(8)
    expect(countWords('潮の満ち引き')).toBe(3)
    expect(readingMinutes(0)).toBe(1)
    expect(readingMinutes(1150)).toBe(5)
  })
})

describe('read aloud rules (RD-06)', () => {
  const voice = (voiceURI: string, lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({ voiceURI, name: voiceURI, lang, default: false, localService: true, ...extra })
  const voices = [voice('Daniel', 'en-GB'), voice('Samantha', 'en-US', { default: true }), voice('Xander', 'nl-NL'), voice('Cloud', 'en-GB', { localService: false })]

  it('picks the chosen voice, else one for the article’s language', () => {
    expect(pickVoice(voices, 'Xander', 'en-GB', 'en-US')?.voiceURI).toBe('Xander')
    expect(pickVoice(voices, null, 'en-GB', 'en-US')?.voiceURI).toBe('Daniel')
    expect(pickVoice(voices, 'gone', 'nl', 'en-US')?.voiceURI).toBe('Xander')
    expect(pickVoice(voices, null, 'fr', 'en-US')?.voiceURI).toBe('Samantha')
    expect(pickVoice(voices, null, null, 'en-US')?.voiceURI).toBe('Samantha')
    expect(pickVoice([], null, 'en', 'en')).toBeNull()
    expect(sortVoices(voices, 'nl-NL')[0]?.voiceURI).toBe('Xander')
  })

  it('finds the spoken word and resumes at its start', () => {
    const text = 'The tide comes in.'
    expect(wordRange(text, 4)).toEqual([4, 8])
    expect(wordRange(text, 3)).toEqual([4, 8])
    expect(wordRange(text, 9, 5)).toEqual([9, 14])
    expect(wordRange(text, 99)).toBeNull()
    expect(resumeOffset(text, 6)).toBe(4)
    expect(resumeOffset(text, 0)).toBe(0)
  })

  it('plays, pauses, resumes and moves through the blocks', () => {
    let s = speechQueue.play(speechQueue.initial(), 2)
    expect(s).toEqual({ status: 'playing', position: { block: 2, offset: 0 } })
    s = speechQueue.word(s, 2, 14)
    s = speechQueue.pause(s)
    expect(s.status).toBe('paused')
    s = speechQueue.play(s, 0)
    expect(s).toEqual({ status: 'playing', position: { block: 2, offset: 14 } })
    s = speechQueue.finished(s, 4)
    expect(s.position).toEqual({ block: 3, offset: 0 })
    s = speechQueue.finished(s, 4)
    expect(s.status).toBe('idle')
    expect(speechQueue.pause(speechQueue.initial()).status).toBe('idle')
  })
})
