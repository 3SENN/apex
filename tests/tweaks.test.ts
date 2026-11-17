/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  tweakBlock,
  tweakHostAllowed,
  generatedCss,
  isSafeSelector,
  matchingTweaks,
  normalizeTweakHost,
  ownTweak,
  pageTweakHost,
  rulesFor,
  sanitizeCss,
  styleCss,
  wrapScript,
  hiddenCss,
  DEFAULT_TWEAK_STYLE,
  type Tweak,
} from '@shared/tweaks'
import { cssEscape, describeNode, isStableToken, selectorFor, type SelectorNode } from '@shared/tweaksSelector'
import { exportTweaks, exportName, parseTweakExport } from '../src/main/tweaks/io'
import { TweakStore, type TweakFileIo } from '../src/main/tweaks/store'
import { TWEAKS_SCHEMAS, pageTweakMessage } from '../src/main/tweaks/schemas'

const tweak = (over: Partial<Tweak> = {}): Tweak => ({
  id: over.host ?? 'b1',
  host: 'example.com',
  subdomains: false,
  enabled: true,
  hidden: [],
  style: { ...DEFAULT_TWEAK_STYLE },
  css: '',
  js: '',
  jsEnabled: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

function memoryIo(initial?: unknown): TweakFileIo & { text: string | null } {
  const io = {
    text: initial === undefined ? null : JSON.stringify(initial),
    read: () => (io.text === null ? undefined : JSON.parse(io.text)),
    write: (text: string) => {
      io.text = text
    },
  }
  return io
}

describe('tweak hosts and where tweaks run', () => {
  it('normalises hosts and addresses', () => {
    expect(normalizeTweakHost('https://www.Example.com:8080/path?q=1')).toBe('example.com')
    expect(normalizeTweakHost('news.example.com')).toBe('news.example.com')
    expect(normalizeTweakHost('  localhost ')).toBe('localhost')
    expect(normalizeTweakHost('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeTweakHost('bücher.de')).toBe('xn--bcher-kva.de')
    expect(normalizeTweakHost('')).toBeNull()
    expect(normalizeTweakHost('not a host!')).toBeNull()
    expect(pageTweakHost('https://www.example.com/a')).toBe('example.com')
    expect(pageTweakHost('atelier://tweaks')).toBeNull()
  })

  it(`never runs on sign-in pages or ${BRAND_NAME} pages`, () => {
    expect(tweakBlock('atelier://settings')).toBe('internal')
    expect(tweakBlock('file:///tmp/a.html')).toBe('not-web')
    expect(tweakBlock('https://accounts.google.com/signin')).toBe('sign-in')
    expect(tweakBlock('https://github.com/login')).toBe('sign-in')
    expect(tweakBlock('https://github.com/explore')).toBeNull()
    expect(tweakHostAllowed('accounts.google.com')).toBe(false)
    expect(tweakHostAllowed('login.microsoftonline.com')).toBe(false)
    expect(tweakHostAllowed('github.com')).toBe(true)
  })

  it('matches a host, its www. and (when asked) its subdomains, broadest first', () => {
    const exact = tweak({ id: 'a', host: 'example.com' })
    const wide = tweak({ id: 'b', host: 'example.com', subdomains: true })
    const news = tweak({ id: 'c', host: 'news.example.com' })
    expect(matchingTweaks([exact], 'https://www.example.com/').map((b) => b.id)).toEqual(['a'])
    expect(matchingTweaks([exact], 'https://news.example.com/')).toEqual([])
    expect(matchingTweaks([news, wide], 'https://news.example.com/x').map((b) => b.id)).toEqual(['b', 'c'])
    expect(matchingTweaks([{ ...exact, enabled: false }], 'https://example.com/')).toEqual([])
    expect(matchingTweaks([exact], 'https://notexample.com/')).toEqual([])
    // A tweak covering google.com's subdomains still stays off its sign-in pages.
    const google = tweak({ host: 'google.com', subdomains: true })
    expect(matchingTweaks([google], 'https://accounts.google.com/')).toEqual([])
    expect(matchingTweaks([google], 'https://news.google.com/')).toHaveLength(1)
  })

  it('finds the tweak that owns a host: exact first, else the closest covering one', () => {
    const wide = tweak({ id: 'wide', host: 'example.com', subdomains: true })
    const mid = tweak({ id: 'mid', host: 'a.example.com', subdomains: true })
    const exact = tweak({ id: 'exact', host: 'b.a.example.com' })
    expect(ownTweak([wide, mid, exact], 'b.a.example.com')?.id).toBe('exact')
    expect(ownTweak([wide, mid], 'c.a.example.com')?.id).toBe('mid')
    expect(ownTweak([wide], 'example.org')).toBeUndefined()
  })

  it('gives a page its rules, with scripts only when allowed and switched on', () => {
    const b = tweak({ hidden: [{ id: 'z', selector: '#ad', label: 'ad', createdAt: 1 }], css: 'body { color: red }', js: 'document.title = "x"', jsEnabled: true })
    const off = rulesFor({ tweaks: [b], scriptsAllowed: false }, 'https://example.com/')
    expect(off?.generated).toContain(':is(#ad):not(#_#_#_#_#_) { display: none !important; }')
    expect(off?.custom).toBe('body { color: red }')
    expect(off?.scripts).toEqual([])
    expect(rulesFor({ tweaks: [b], scriptsAllowed: true }, 'https://example.com/')?.scripts).toHaveLength(1)
    expect(rulesFor({ tweaks: [{ ...b, jsEnabled: false }], scriptsAllowed: true }, 'https://example.com/')?.scripts).toEqual([])
    expect(rulesFor({ tweaks: [tweak()], scriptsAllowed: true }, 'https://example.com/')).toBeNull()
    expect(rulesFor({ tweaks: [b], scriptsAllowed: true }, 'https://other.com/')).toBeNull()
  })

  it('wraps a script so one that throws does not stop the next', () => {
    const code = wrapScript("evil'host", 'throw new Error("x")')
    expect(code).toContain('try {')
    expect(code).toContain(`${BRAND_NAME} tweak for evilhost failed`)
    expect(() => new Function(code)).not.toThrow()
  })
})

describe('tweak CSS', () => {
  it('writes one hiding rule per hidden element and drops unsafe selectors', () => {
    const css = hiddenCss([{ selector: '.a' }, { selector: 'x { } body { display: none' }, { selector: '#b > p:nth-of-type(2)' }])
    expect(css.split('\n')).toEqual([':is(.a):not(#_#_#_#_#_) { display: none !important; }', ':is(#b > p:nth-of-type(2)):not(#_#_#_#_#_) { display: none !important; }'])
  })

  it('accepts selectors that only select', () => {
    expect(isSafeSelector('div.card > a[href="mailto:a@b.c"]')).toBe(true)
    expect(isSafeSelector('#\\31 23')).toBe(true)
    expect(isSafeSelector('a:not(.b)')).toBe(true)
    for (const bad of ['', 'a{', 'a}', 'a; b', '@media x', 'a /* x', 'a"', 'a(', 'a)', 'a\nb', 'x'.repeat(600)]) expect(isSafeSelector(bad), bad).toBe(false)
  })

  it('turns a style into rules', () => {
    expect(styleCss(DEFAULT_TWEAK_STYLE)).toBe('')
    const css = styleCss({ font: 'serif', tint: 'ocean', accent: '#FF0000', focus: true })
    expect(css).toContain('font-family: ui-serif')
    expect(css).toContain('#2f6bff')
    expect(css).toContain('accent-color: #ff0000 !important')
    expect(css).toContain(':not(:has(main, article, [role="main"], h1))')
    expect(styleCss({ ...DEFAULT_TWEAK_STYLE, accent: 'red; } body { display:none' })).toBe('')
    expect(generatedCss({ hidden: [{ id: 'z', selector: '.x', label: '', createdAt: 0 }], style: DEFAULT_TWEAK_STYLE })).toBe(':is(.x):not(#_#_#_#_#_) { display: none !important; }')
  })

  it('sanitises custom CSS', () => {
    const { css, removed } = sanitizeCss('@import url(https://evil.example/x.css);\nbody { background: url("javascript:alert(1)"); width: expression(1); -moz-binding: url(x); }\0')
    expect(css).not.toMatch(/@import|javascript:|expression\(|-moz-binding|\0/)
    expect(css).toContain('url("about:invalid#')
    expect(removed).toBe(4)
    expect(sanitizeCss('a { color: red }')).toEqual({ css: 'a { color: red }', removed: 0 })
  })
})

describe('the tweak store', () => {
  it('creates, updates, removes and restores tweaks, and keeps them on disk', () => {
    const io = memoryIo()
    let now = 100
    const store = new TweakStore(io, () => now)
    const changes: number[] = []
    store.on('changed', (s) => changes.push(s.tweaks.length))
    const b = store.create('https://www.Example.com/page')
    expect(b).toMatchObject({ host: 'example.com', enabled: true, subdomains: false, jsEnabled: false, createdAt: 100 })
    expect(store.create('example.com').id).toBe(b.id)
    now = 200
    const updated = store.update(b.id, { style: { font: 'mono' }, css: '@import url(x); a{}', subdomains: true })
    expect(updated.style).toEqual({ ...DEFAULT_TWEAK_STYLE, font: 'mono' })
    expect(updated.css).toBe(' a{}')
    expect(updated.updatedAt).toBe(200)
    const again = new TweakStore(io)
    expect(again.state().tweaks).toEqual([updated])
    store.remove(b.id)
    expect(store.state().tweaks).toEqual([])
    expect(store.restore(updated)).toEqual(updated)
    expect(changes).toEqual([1, 1, 0, 1])
    expect(() => store.update('missing', {})).toThrow()
  })

  it('refuses sign-in hosts and things that are not hosts', () => {
    const store = new TweakStore(null)
    expect(() => store.create('accounts.google.com')).toThrow()
    expect(() => store.create('no such host!')).toThrow()
  })

  it('adds hidden elements to the tweak that owns the host, turning it on, once per selector', () => {
    const store = new TweakStore(null)
    const first = store.addHidden('example.com', '#ad', 'div#ad · Buy now')
    expect(first.tweak.hidden).toHaveLength(1)
    store.update(first.tweak.id, { enabled: false })
    const second = store.addHidden('example.com', '.promo', 'aside.promo')
    expect(second.tweak).toMatchObject({ enabled: true })
    expect(store.addHidden('example.com', '#ad', 'again').element.id).toBe(first.element.id)
    expect(() => store.addHidden('example.com', 'a { }', 'x')).toThrow()
    expect(store.removeHidden(first.tweak.id, first.element.id).hidden.map((z) => z.selector)).toEqual(['.promo'])
    expect(store.clearHidden(first.tweak.id).hidden).toEqual([])
    // A subdomain's hidden element goes to a tweak covering it.
    store.update(first.tweak.id, { subdomains: true })
    expect(store.addHidden('news.example.com', '.x', 'x').tweak.id).toBe(first.tweak.id)
  })

  it('loads a broken file as empty, and drops stored tweaks it can’t keep', () => {
    expect(new TweakStore(memoryIo({ tweaks: 'nope' })).state()).toEqual({ tweaks: [], scriptsAllowed: false })
    const io = memoryIo({ scriptsAllowed: true, tweaks: [{ host: 'accounts.google.com' }, { host: 'Example.com', hidden: [{ selector: 'a{' }, { selector: '.ok' }], js: 'x', jsEnabled: true }] })
    const state = new TweakStore(io).state()
    expect(state.scriptsAllowed).toBe(true)
    expect(state.tweaks.map((b) => [b.host, b.hidden.map((z) => z.selector), b.jsEnabled])).toEqual([['example.com', ['.ok'], true]])
  })

  it('imports tweaks with their scripts off, replacing a host’s existing tweak', () => {
    const store = new TweakStore(null)
    const mine = store.create('example.com')
    const result = store.importTweaks([
      { host: 'www.example.com', subdomains: false, enabled: true, hidden: [{ selector: '.a' }], style: { focus: true }, css: '', js: 'alert(1)', jsEnabled: true },
      { host: 'other.org', subdomains: true, enabled: true, hidden: [], style: {}, css: 'a{}', js: '' },
      { host: 'accounts.google.com', subdomains: false, enabled: true, hidden: [], style: {}, css: '', js: '' },
    ])
    expect(result).toEqual({ added: 1, replaced: 1, skipped: 1, scripts: 1 })
    const replaced = store.get(mine.id)
    expect(replaced).toMatchObject({ host: 'example.com', jsEnabled: false, js: 'alert(1)', style: { ...DEFAULT_TWEAK_STYLE, focus: true } })
    expect(store.setScriptsAllowed(true).scriptsAllowed).toBe(true)
  })
})

describe('tweak export and import files', () => {
  it('round-trips without ids or script switches', () => {
    const b = tweak({ hidden: [{ id: 'z1', selector: '#ad', label: 'ad', createdAt: 5 }], js: 'x()', jsEnabled: true, style: { ...DEFAULT_TWEAK_STYLE, tint: 'fern' } })
    const text = exportTweaks([b], new Date('2026-10-30T12:00:00Z'))
    expect(text).not.toContain('jsEnabled')
    expect(text).not.toContain('"id"')
    const parsed = parseTweakExport(text)
    expect(parsed).toEqual([{ host: 'example.com', subdomains: false, enabled: true, hidden: [{ selector: '#ad', label: 'ad' }], style: { ...DEFAULT_TWEAK_STYLE, tint: 'fern' }, css: '', js: 'x()' }])
    expect(exportName([b])).toBe('example.com.atelier-tweak.json')
    expect(exportName([b, b])).toBe('atelier-tweaks.json')
  })

  it('refuses files that are not tweaks', () => {
    expect(() => parseTweakExport('not json')).toThrow()
    expect(() => parseTweakExport(JSON.stringify({ format: 'something-else', version: 1, tweaks: [] }))).toThrow()
    expect(() => parseTweakExport(JSON.stringify({ format: 'atelier-tweaks', version: 1, tweaks: [{ host: 'a.com', style: { font: 'comic' } }] }))).toThrow()
    expect(() => parseTweakExport('x'.repeat(5_000_000))).toThrow()
  })
})

// Compatibility: tweaks were called boosts, and hidden elements zaps, before
// the rename. Profiles and exported files from then must still read.
describe('files from before the rename', () => {
  const legacyFile = { version: 1, scriptsAllowed: true, boosts: [{ id: 'old', host: 'example.com', zaps: [{ id: 'z1', selector: '#ad', label: 'ad', createdAt: 5 }], js: 'x()', jsEnabled: true }] } // compatibility: the old profile file

  it('reads the old profile file when there is no tweaks file yet, and writes the tweaks file from it at once', () => {
    const io = Object.assign(memoryIo(), { readLegacy: () => legacyFile })
    const state = new TweakStore(io).state()
    expect(state.scriptsAllowed).toBe(true)
    expect(state.tweaks.map((tw) => [tw.id, tw.host, tw.hidden.map((el) => el.selector), tw.jsEnabled])).toEqual([['old', 'example.com', ['#ad'], true]])
    const written = JSON.parse(io.text ?? '{}') as Record<string, unknown>
    expect(written).toMatchObject({ version: 2, scriptsAllowed: true, tweaks: [{ id: 'old', host: 'example.com', hidden: [{ id: 'z1', selector: '#ad' }] }] })
    expect(Object.keys(written)).not.toContain('boosts') // compatibility: the old key is never written
    expect(new TweakStore(io).state()).toEqual(state)
  })

  it('reads a tweaks file with the old names, and prefers the tweaks file to the old one', () => {
    expect(new TweakStore(memoryIo(legacyFile)).state().tweaks[0]?.hidden.map((el) => el.selector)).toEqual(['#ad'])
    let legacyRead = false
    const io = Object.assign(memoryIo({ tweaks: [] }), { readLegacy: () => ((legacyRead = true), legacyFile) })
    expect(new TweakStore(io).state().tweaks).toEqual([])
    expect(legacyRead).toBe(false)
  })

  it('imports files exported before the rename', () => {
    const old = { format: 'atelier-boosts', version: 1, boosts: [{ host: 'example.com', zaps: [{ selector: '#ad', label: 'ad' }], css: 'a{}' }] } // compatibility: an old export
    expect(parseTweakExport(JSON.stringify(old))).toEqual([{ host: 'example.com', subdomains: false, enabled: true, hidden: [{ selector: '#ad', label: 'ad' }], style: {}, css: 'a{}', js: '' }])
  })
})

describe('tweak IPC contracts', () => {
  it('validates the page messages and service arguments', () => {
    expect(pageTweakMessage.safeParse({ kind: 'get', url: 'https://a.com/' }).success).toBe(true)
    expect(pageTweakMessage.safeParse({ kind: 'hide', selector: '#a', label: 'a' }).success).toBe(true)
    expect(pageTweakMessage.safeParse({ kind: 'hide', selector: '', label: 'a' }).success).toBe(false)
    expect(pageTweakMessage.safeParse({ kind: 'run', code: 'x' }).success).toBe(false)
    expect(TWEAKS_SCHEMAS.tweaks.update.safeParse(['id', { style: { accent: '#ffffff' } }]).success).toBe(true)
    expect(TWEAKS_SCHEMAS.tweaks.update.safeParse(['id', { style: { accent: 'red' } }]).success).toBe(false)
    expect(TWEAKS_SCHEMAS.tweaks.update.safeParse(['id', { jsEnabled: true, extra: 1 }]).success).toBe(false)
    expect(TWEAKS_SCHEMAS.tweaks.exportFile.safeParse([]).success).toBe(true)
    expect(TWEAKS_SCHEMAS.tweaks.exportFile.safeParse([['a', 'b']]).success).toBe(true)
    for (const [method, schema] of Object.entries(TWEAKS_SCHEMAS.tweaks)) expect(schema instanceof z.ZodTuple, method).toBe(true)
  })
})

// ---- selectors over a small fake document ----

interface FakeEl {
  tag: string
  id?: string
  classes?: string[]
  attrs?: Record<string, string>
  children?: FakeEl[]
}

function build(root: FakeEl): { all: { el: FakeEl; node: SelectorNode }[]; find(pred: (e: FakeEl) => boolean): SelectorNode } {
  const all: { el: FakeEl; node: SelectorNode }[] = []
  const walk = (el: FakeEl, parent: SelectorNode | null): void => {
    const siblings = parent ? (parentChildren.get(parent) ?? []) : [el]
    const same = siblings.filter((s) => s.tag === el.tag)
    const node: SelectorNode = { tag: el.tag, id: el.id ?? '', classes: el.classes ?? [], attr: (n) => el.attrs?.[n] ?? null, parent, nthOfType: same.indexOf(el) + 1, ofType: same.length }
    all.push({ el, node })
    parentChildren.set(node, el.children ?? [])
    for (const c of el.children ?? []) walk(c, node)
  }
  const parentChildren = new Map<SelectorNode, FakeEl[]>()
  walk(root, null)
  return { all, find: (pred) => all.find((x) => pred(x.el))!.node }
}

/** Matches the selectors selectorFor writes: parts joined by " > ". */
function matches(node: SelectorNode, selector: string): boolean {
  const parts = selector.split(' > ')
  let n: SelectorNode | null = node
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!n || !matchPart(n, parts[i] ?? '')) return false
    n = i > 0 ? n.parent : n
  }
  return true
}
function matchPart(n: SelectorNode, part: string): boolean {
  const id = /^#(.+)$/.exec(part)
  if (id) return n.id === id[1]
  const attr = /^([a-z0-9]+)\[([a-z-]+)="(.*)"\]$/.exec(part)
  if (attr) return n.tag === attr[1] && n.attr(attr[2] ?? '') === attr[3]
  const m = /^([a-z0-9]+)((?:\.[\w-]+)*)(?::nth-of-type\((\d+)\))?$/.exec(part)
  if (!m) throw new Error(`unexpected part ${part}`)
  const classes = (m[2] ?? '').split('.').filter(Boolean)
  return n.tag === m[1] && classes.every((c) => n.classes.includes(c)) && (!m[3] || n.nthOfType === Number(m[3]))
}

describe('picker selectors', () => {
  const doc = build({
    tag: 'html',
    children: [
      {
        tag: 'body',
        children: [
          { tag: 'div', id: 'banner-12345', classes: ['css-1x2y3z', 'banner'], children: [{ tag: 'p', classes: ['text'] }] },
          { tag: 'main', id: 'content', children: [{ tag: 'p' }, { tag: 'p' }, { tag: 'aside', classes: ['Sidebar_root__3xYz9', 'promo'] }] },
          { tag: 'section', children: [{ tag: 'button', attrs: { 'data-testid': 'close-ad' } }] },
          { tag: 'ul', children: [{ tag: 'li', classes: ['item'] }, { tag: 'li', classes: ['item'] }] },
        ],
      },
    ],
  })
  const count = (sel: string): number => doc.all.filter((x) => matches(x.node, sel)).length

  it('uses a stable id, a test hook, or hand-written classes', () => {
    expect(selectorFor(doc.find((e) => e.id === 'content'), count)).toBe('#content')
    expect(selectorFor(doc.find((e) => e.attrs?.['data-testid'] === 'close-ad'), count)).toBe('button[data-testid="close-ad"]')
    expect(selectorFor(doc.find((e) => e.tag === 'aside'), count)).toBe('aside.promo')
    // A generated id and a hashed class are passed over.
    expect(selectorFor(doc.find((e) => e.id === 'banner-12345'), count)).toBe('div.banner')
  })

  it('climbs and adds positions only where the page has look-alikes', () => {
    const second = doc.all.filter((x) => x.el.tag === 'p' && !x.el.classes)[1]!.node
    const sel = selectorFor(second, count)
    expect(sel).toBe('#content > p:nth-of-type(2)')
    const items = doc.all.filter((x) => x.el.tag === 'li')
    expect(selectorFor(items[1]!.node, count)).toBe('li.item:nth-of-type(2)')
    for (const x of doc.all.filter((y) => !['html', 'body'].includes(y.el.tag))) {
      const s = selectorFor(x.node, count)
      expect(s && count(s), `${x.el.tag} ${s}`).toBe(1)
    }
    expect(selectorFor(doc.find((e) => e.tag === 'body'), count)).toBeNull()
  })

  it('tells hand-written names from generated ones', () => {
    for (const ok of ['banner', 'site-header', 'nav__item', 'promo']) expect(isStableToken(ok), ok).toBe(true)
    for (const bad of ['css-1x2y3z', 'sc-AbCdE', 'Sidebar_root__3xYz9', 'a1b2c3d4', 'item-12345', 'is-open', 'active', 'md:flex', 'w-[200px]']) expect(isStableToken(bad), bad).toBe(false)
  })

  it('escapes and names what it hides', () => {
    expect(cssEscape('1a')).toBe('\\31 a')
    expect(cssEscape('a.b')).toBe('a\\.b')
    expect(cssEscape('-')).toBe('\\-')
    const aside = doc.find((e) => e.tag === 'aside')
    expect(describeNode(aside, '  Subscribe   to our newsletter ')).toBe('aside.promo · Subscribe to our newsletter')
    expect(describeNode(aside, '')).toBe('aside.promo')
  })
})
