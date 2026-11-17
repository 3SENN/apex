/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: {}, net: {}, app: {}, ipcMain: {} }))

import { classifyLoadFailure } from '@shared/safety'
import { COOKIE_LISTS } from '@shared/privacyPack'
import { SETTINGS } from '@shared/settingsRegistry'
import { errorCopy } from '../src/renderer/src/pages/errors/logic'
import { sendsGpc } from '../src/main/privacy'
import { bannerScript, buildCss, bundledCss, CONSENT_TOOLS, isBannerResult, type ConsentTool } from '../src/main/privacy/cookieBanners'
import { compileList, CookieLists, looksLikeFilterList, LIST_MAX_AGE_MS, selectorsFor } from '../src/main/privacy/cookieLists'
import { PrivacyExceptionStore, validHost } from '../src/main/privacy/exceptions'
import { HttpsUpgrades, isExemptHost, isUpgradeFailure, typedFallback, upgradeTarget } from '../src/main/privacy/httpsFirst'

// The privacy pack (src/main/privacy): HTTPS-First's upgrade and fallback
// rules, the per-site exceptions, the cookie-banner stylesheet and reject
// script, the optional lists' parsing and caching, and GPC consistency. No
// network: list downloads go through a fake fetch.

const never = (): boolean => false

describe('HTTPS-First: which addresses are upgraded', () => {
  it.each([
    ['localhost', true],
    ['app.localhost', true],
    ['127.0.0.1', true],
    ['192.168.1.10', true],
    ['[::1]', true],
    ['printer.local', true],
    ['router.home.arpa', true],
    ['nas', true],
    ['site.test', true],
    ['box.lan', true],
    ['svc.internal', true],
    ['example.com', false],
    ['neverssl.com', false],
    ['user.github.io', false],
  ])('%s exempt: %s', (host, exempt) => {
    expect(isExemptHost(host)).toBe(exempt)
  })

  it('sends top-level http to https on the default port only', () => {
    expect(upgradeTarget('http://example.com/a?b=1#c', true, never)).toBe('https://example.com/a?b=1#c')
    expect(upgradeTarget('http://example.com:80/', true, never)).toBe('https://example.com/')
    expect(upgradeTarget('http://example.com:8080/', true, never)).toBeNull()
    expect(upgradeTarget('https://example.com/', true, never)).toBeNull()
    expect(upgradeTarget('http://127.0.0.1:5173/', true, never)).toBeNull()
    expect(upgradeTarget('http://localhost/', true, never)).toBeNull()
    expect(upgradeTarget('ftp://example.com/', true, never)).toBeNull()
    expect(upgradeTarget('not a url', true, never)).toBeNull()
  })

  it('leaves everything alone when off, and a site the person allowed', () => {
    expect(upgradeTarget('http://example.com/', false, never)).toBeNull()
    expect(upgradeTarget('http://Example.COM/', true, (h) => h === 'example.com')).toBeNull()
    expect(upgradeTarget('http://other.com/', true, (h) => h === 'example.com')).toBe('https://other.com/')
  })

  it('falls back for missing https, not for a stop or the network being down', () => {
    for (const code of [-100, -101, -102, -107, -113, -118, -7, -202, -200, -501, -310, -324]) expect(isUpgradeFailure(code), String(code)).toBe(true)
    for (const code of [0, -3, -105, -106, -137, -21, -130, -20]) expect(isUpgradeFailure(code), String(code)).toBe(false)
  })
})

describe('HTTPS-First: one tab’s upgrades', () => {
  const on = { enabled: true, isAllowed: never }

  it('upgrades, then offers the http address when https is refused', () => {
    const u = new HttpsUpgrades()
    expect(u.beforeRequest(1, 'http://example.com/page', on)).toEqual({ redirectURL: 'https://example.com/page' })
    // The redirected request comes back through the mux unchanged.
    expect(u.beforeRequest(1, 'https://example.com/page', on)).toBeNull()
    expect(u.failed(1, -102)).toBe('http://example.com/page')
    // Only once per failure.
    expect(u.failed(1, -102)).toBeNull()
  })

  it('keeps a DNS failure or a stop as it is', () => {
    const u = new HttpsUpgrades()
    u.beforeRequest(1, 'http://example.com/', on)
    expect(u.failed(1, -105)).toBeNull()
    u.beforeRequest(1, 'http://example.com/', on)
    u.started(1) // a new navigation; the stopped one fired no failure
    expect(u.failed(1, -102)).toBeNull()
  })

  it('refuses an https answer that redirects straight back to http, and offers the http address', () => {
    const u = new HttpsUpgrades()
    u.beforeRequest(1, 'http://example.com/', on)
    u.headersReceived(1, 'https://example.com/', 301, 'http://example.com/')
    expect(u.beforeRequest(1, 'http://example.com/', on)).toEqual({ cancel: true })
    expect(u.failed(1, -20)).toBe('http://example.com/')
  })

  it('follows an https redirect to another host and upgrades its http address in turn', () => {
    const u = new HttpsUpgrades()
    u.beforeRequest(1, 'http://a.com/', on)
    u.headersReceived(1, 'https://a.com/', 302, 'http://b.com/')
    expect(u.beforeRequest(1, 'http://b.com/', on)).toEqual({ redirectURL: 'https://b.com/' })
  })

  it('treats a reload of the failed https address as the same upgrade', () => {
    const u = new HttpsUpgrades()
    u.beforeRequest(1, 'http://example.com/', on)
    u.failed(1, -107)
    u.started(1)
    expect(u.beforeRequest(1, 'https://example.com/', on)).toBeNull()
    expect(u.failed(1, -107)).toBe('http://example.com/')
  })

  it('offers http for a typed bare host whose https fails, and only for one typed without a scheme', () => {
    expect(typedFallback('example.com/a', 'https://example.com/a')).toBe('http://example.com/a')
    expect(typedFallback('https://example.com', 'https://example.com/')).toBeNull()
    expect(typedFallback('example.com:8443', 'https://example.com:8443/')).toBeNull()
    expect(typedFallback('printer.local', 'http://printer.local/')).toBeNull()
    const u = new HttpsUpgrades()
    u.typed(1, 'example.com', 'https://example.com/')
    u.started(1)
    expect(u.beforeRequest(1, 'https://example.com/', on)).toBeNull()
    expect(u.failed(1, -107)).toBe('http://example.com/')
    // A working one isn't reported as upgraded: nothing was upgraded.
    u.typed(1, 'example.com', 'https://example.com/')
    u.beforeRequest(1, 'https://example.com/', on)
    u.committed(1, 'https://example.com/')
    expect(u.wasUpgraded(1, 'https://example.com/')).toBe(false)
    // Off: nothing is offered. A remembered Continue goes straight to http.
    u.typed(1, 'example.com', 'https://example.com/')
    expect(u.beforeRequest(1, 'https://example.com/', { enabled: false, isAllowed: never })).toBeNull()
    expect(u.failed(1, -107)).toBeNull()
    u.typed(1, 'example.com', 'https://example.com/')
    expect(u.beforeRequest(1, 'https://example.com/', { enabled: true, isAllowed: () => true })).toEqual({ redirectURL: 'http://example.com/' })
  })

  it('remembers a working upgrade for the summary until the next page', () => {
    const u = new HttpsUpgrades()
    u.beforeRequest(1, 'http://example.com/', on)
    u.committed(1, 'https://example.com/')
    expect(u.wasUpgraded(1, 'https://example.com/')).toBe(true)
    expect(u.wasUpgraded(2, 'https://example.com/')).toBe(false)
    u.committed(1, 'https://example.com/next')
    expect(u.wasUpgraded(1, 'https://example.com/next')).toBe(false)
  })

  it('keeps tabs apart and forgets a closed one', () => {
    const u = new HttpsUpgrades()
    u.beforeRequest(1, 'http://a.com/', on)
    u.beforeRequest(2, 'http://b.com/', on)
    expect(u.failed(2, -102)).toBe('http://b.com/')
    u.forget(1)
    expect(u.failed(1, -102)).toBeNull()
  })

  it('shows its own page with Continue to site and Go back', () => {
    expect(classifyLoadFailure(-102, { online: true, httpsFallback: true })).toBe('https-unavailable')
    expect(classifyLoadFailure(-102, { online: true })).toBe('refused')
    expect(classifyLoadFailure(-3, { online: true, httpsFallback: true })).toBeNull()
    const copy = errorCopy('https-unavailable', false)
    expect(copy).toMatchObject({ title: 'privacyPack.https.error.title', primary: 'continue-insecure', secondary: ['go-back'], bypass: null, tone: 'warning' })
  })
})

describe('privacy exceptions', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('accepts hosts only', () => {
    expect(validHost(' Example.COM. ')).toBe('example.com')
    expect(validHost('[::1]')).toBe('::1')
    expect(validHost('https://example.com/')).toBeNull()
    expect(validHost('a b')).toBeNull()
    expect(validHost('')).toBeNull()
  })

  it('saves per profile and reads back, keeping the kinds apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-privacy-'))
    dirs.push(dir)
    const file = join(dir, 'privacy-exceptions.json')
    const store = new PrivacyExceptionStore(file)
    expect(store.set('https', 'Example.com', true)).toBe(true)
    expect(store.set('https', 'example.com', true)).toBe(false)
    store.set('cookieBanners', 'news.example', true)
    expect(store.has('https', 'example.com')).toBe(true)
    expect(store.has('cookieBanners', 'example.com')).toBe(false)
    const again = new PrivacyExceptionStore(file)
    expect(again.list()).toEqual({ https: ['example.com'], cookieBanners: ['news.example'] })
    again.set('https', 'example.com', false)
    expect(JSON.parse(readFileSync(file, 'utf8')).https).toEqual([])
  })

  it('keeps a private window’s in memory and drops junk from a hand-edited file', () => {
    const memory = new PrivacyExceptionStore(null)
    memory.set('https', 'example.com', true)
    expect(memory.has('https', 'example.com')).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), 'atelier-privacy-'))
    dirs.push(dir)
    const file = join(dir, 'privacy-exceptions.json')
    writeFileSync(file, JSON.stringify({ https: ['ok.example', 'http://bad/', 42], cookieBanners: 'nope' }))
    expect(new PrivacyExceptionStore(file).list()).toEqual({ https: ['ok.example'], cookieBanners: [] })
  })
})

describe('cookie banners: Atelier’s own list', () => {
  it('hides every tool’s banner with !important rules and unlocks scrolling', () => {
    const css = bundledCss()
    expect(css).toContain('#onetrust-consent-sdk')
    expect(css).toContain('#CybotCookiebotDialog')
    expect(css).toContain('display: none !important')
    expect(css).toContain('body.didomi-popup-open')
    expect(css).toContain('overflow: auto !important')
    // TrustArc's newer popup leaves a transparent full-page wrapper that takes every click unless it is hidden too.
    expect(css).toContain('.truste_cm_outerdiv')
  })

  it('groups selectors so one bad selector drops only its own group, and refuses ones that break out', () => {
    const css = buildCss(['.a', '.b', '.c', '.d}body{color:red', '#x'], [], 2)
    expect(css.split('{ display: none !important; }')).toHaveLength(3)
    expect(css).not.toContain('color:red')
    expect(buildCss(['.a:has-text(Accept)', 'div:-abp-has(.x)'])).toBe('')
  })

  it('names only unambiguous reject buttons', () => {
    for (const tool of CONSENT_TOOLS) for (const s of tool.reject ?? []) expect(s, tool.id).not.toMatch(/accept|(?<!dis)agree|allow/i)
  })

  type FakeEl = { click(): void; shadowRoot?: { querySelector(sel: string): FakeEl | null } }
  /** `present` is on the page; `shadow` maps a host on the page to what its open shadow root holds. */
  const run = async (present: string[], tools: readonly ConsentTool[] = CONSENT_TOOLS, waitMs = 5, shadow: Record<string, string[]> = {}): Promise<{ result: unknown; clicked: string[] }> => {
    const clicked: string[] = []
    const finder = (set: Set<string>, prefix = '') => (sel: string): FakeEl | null => {
      for (const part of sel.split(',')) {
        const s = part.trim()
        if (!set.has(s)) continue
        const inner = shadow[s]
        return { click: () => clicked.push(prefix + s), ...(inner && !prefix ? { shadowRoot: { querySelector: finder(new Set(inner), `${s} >> `) } } : {}) }
      }
      return null
    }
    const find = finder(new Set(present))
    const document = { documentElement: {}, createDocumentFragment: () => ({ querySelector: () => null }), querySelector: find }
    class MutationObserver {
      observe(): void {}
      disconnect(): void {}
    }
    const result = await (new Function('document', 'MutationObserver', `return ${bannerScript(tools, waitMs)}`)(document, MutationObserver) as Promise<unknown>)
    return { result, clicked }
  }

  it('presses Reject once when the banner has one', async () => {
    const { result, clicked } = await run(['#onetrust-banner-sdk', '#onetrust-reject-all-handler'])
    expect(result).toEqual({ found: true, rejected: true })
    expect(clicked).toEqual(['#onetrust-reject-all-handler'])
    expect(isBannerResult(result)).toBe(true)
  })

  it('presses Decline all inside TrustArc’s newer popup, which keeps its buttons in a shadow root', async () => {
    const page = ['.truste_cm_outerdiv', '.truste_box_overlay', '.trustarc_newcm_container']
    const { result, clicked } = await run(page, CONSENT_TOOLS, 5, { '.trustarc_newcm_container': ['#accept_all_button', '#decline_all_button'] })
    expect(result).toEqual({ found: true, rejected: true })
    expect(clicked).toEqual(['.trustarc_newcm_container >> #decline_all_button'])
  })

  it('reports a hidden banner without a reject button, and nothing on a page without one', async () => {
    expect((await run(['#qc-cmp2-container'])).result).toEqual({ found: true, rejected: false })
    const none = await run([])
    expect(none.result).toEqual({ found: false, rejected: false })
    expect(none.clicked).toEqual([])
  })
})

describe('cookie banners: optional lists', () => {
  const LIST = [
    '! Title: Test cookie list',
    '##.cookie-wall',
    '###gdpr-box',
    'news.example##.consent-strip',
    'news.example#@#.cookie-wall',
    'shop.example##+js(set-cookie, consent, no)',
    '##.banner:has-text(cookies)',
    '||consent.example^$third-party',
  ].join('\n')

  it('keeps plain hiding rules only, with per-site rules and exceptions', () => {
    const list = compileList(LIST)
    expect(list.generic.sort()).toEqual(['#gdpr-box', '.cookie-wall'])
    expect(list.rules).toBe(3)
    expect(selectorsFor(list, 'news.example').sort()).toEqual(['#gdpr-box', '.consent-strip'])
    expect(selectorsFor(list, 'www.news.example').sort()).toEqual(['#gdpr-box', '.consent-strip'])
    expect(selectorsFor(list, 'other.example').sort()).toEqual(['#gdpr-box', '.cookie-wall'])
  })

  it('only takes a download that looks like a filter list', () => {
    expect(looksLikeFilterList(LIST)).toBe(true)
    expect(looksLikeFilterList('<html><body>Not found</body></html>')).toBe(false)
    expect(looksLikeFilterList('')).toBe(false)
  })

  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('downloads a list once, caches it on disk and refreshes it after a week', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-lists-'))
    dirs.push(dir)
    let now = 1_000_000
    const fetchText = vi.fn(async (url: string) => {
      expect(url).toBe(COOKIE_LISTS[0]!.url)
      return LIST
    })
    const changed = vi.fn()
    const lists = new CookieLists({ dir, fetchText, now: () => now, onChange: changed })
    await lists.ensure(['easylist-cookie'], { download: false })
    expect(fetchText).not.toHaveBeenCalled()
    expect(lists.status(['easylist-cookie'])[0]).toMatchObject({ enabled: true, updatedAt: null, rules: 0 })
    await lists.ensure(['easylist-cookie'], { download: true })
    expect(fetchText).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalled()
    expect(lists.selectors(['easylist-cookie'], 'news.example')).toContain('.consent-strip')
    expect(lists.selectors([], 'news.example')).toEqual([])
    await lists.ensure(['easylist-cookie'], { download: true })
    expect(fetchText).toHaveBeenCalledTimes(1)

    // A fresh start reads the copy on disk; a week later it downloads again.
    const file = join(dir, 'easylist-cookie.txt')
    utimesSync(file, new Date(now), new Date(now))
    const later = new CookieLists({ dir, fetchText, now: () => now })
    await later.ensure(['easylist-cookie'], { download: true })
    expect(fetchText).toHaveBeenCalledTimes(1)
    expect(later.status(['easylist-cookie'])[0]!.rules).toBe(3)
    now += LIST_MAX_AGE_MS + 1
    await later.ensure(['easylist-cookie'], { download: true })
    expect(fetchText).toHaveBeenCalledTimes(2)
  })

  it('keeps the old copy when a download fails, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-lists-'))
    dirs.push(dir)
    const lists = new CookieLists({ dir, fetchText: async () => LIST })
    await lists.update(['ublock-cookies'])
    const failing = new CookieLists({ dir, fetchText: async () => Promise.reject(new Error('offline')) })
    await failing.ensure(['ublock-cookies'], { download: false })
    await failing.update(['ublock-cookies'])
    expect(failing.status(['ublock-cookies']).find((s) => s.id === 'ublock-cookies')).toMatchObject({ state: 'failed', rules: 3 })
    expect(failing.selectors(['ublock-cookies'], 'other.example')).toContain('.cookie-wall')
  })
})

describe('Global Privacy Control', () => {
  it('goes with every request while on, except on sign-in pages, which keep the engine’s own world', () => {
    expect(sendsGpc('https://news.example/a.js', 'https://news.example/', true)).toBe(true)
    expect(sendsGpc('https://news.example/a.js', 'https://news.example/', false)).toBe(false)
    expect(sendsGpc('https://accounts.google.com/signin', 'https://accounts.google.com/signin', true)).toBe(false)
    expect(sendsGpc('https://cdn.example/x.js', 'https://accounts.google.com/', true)).toBe(false)
    expect(sendsGpc('https://cdn.example/x.js', null, true)).toBe(true)
  })
})

describe('privacy pack settings', () => {
  it('ships HTTPS-First and hidden cookie banners on, with no downloaded lists', () => {
    expect(SETTINGS.httpsFirst.default).toBe(true)
    expect(SETTINGS.hideCookieBanners.default).toBe(true)
    expect(SETTINGS.cookieBannerLists.default).toEqual([])
    expect(SETTINGS.cookieBannerLists.schema.safeParse(['easylist-cookie']).success).toBe(true)
    expect(SETTINGS.cookieBannerLists.schema.safeParse(['somebody-elses-list']).success).toBe(false)
  })
})
