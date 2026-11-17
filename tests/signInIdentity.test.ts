/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, WebContents } from 'electron'
import { clientHintsLayer } from '../src/main/clientHints'
import { overrideSignInIdentity, signInIdentityFor } from '@shared/signInHosts'
import { applyIdentityExperiments, FIREFOX_MAJOR, firefoxUserAgent, followIdentityExperiments, GOOGLE_FIREFOX_FLAG, identityHeaders, isFirefoxRequest, requestIdentity, signInIdentityLayer, tabIdentity, watchSignInIdentity } from '../src/main/signInIdentity'
import { browserIdentity } from '../src/main/userAgent'
import { runBeforeSendHeaders, runHeadersReceived } from '../src/main/webRequest'

// Sign-in compatibility mode: on a 'firefox' sign-in page a tab presents a
// current desktop Firefox (its User-Agent, no client hints), and Chromium
// again everywhere else. No provider is 'firefox' by default; Experiments'
// "Google sign-in: present as Firefox" makes Google's one, and these tests
// run the mechanics with it on.

describe('the Google sign-in experiment', () => {
  it('switches Google between Chrome (off, the default) and Firefox, live', () => {
    const SIGN_IN = 'https://accounts.google.com/v3/signin/identifier'
    const listeners: ((next: { flags?: Record<string, string> }) => void)[] = []
    let flags: Record<string, string> = {}
    try {
      followIdentityExperiments({ get: () => ({ flags }), on: (_e, l) => listeners.push(l) })
      expect(signInIdentityFor(SIGN_IN)).toBe('chromium')
      flags = { [GOOGLE_FIREFOX_FLAG]: 'on' }
      for (const l of listeners) l({ flags })
      expect(signInIdentityFor(SIGN_IN)).toBe('firefox')
      expect(requestIdentity({ url: SIGN_IN, resourceType: 'mainFrame' }, null)).toBe('firefox')
      for (const l of listeners) l({ flags: {} })
      expect(signInIdentityFor(SIGN_IN)).toBe('chromium')
      expect(requestIdentity({ url: SIGN_IN, resourceType: 'mainFrame' }, null)).toBe('chromium')
      applyIdentityExperiments({})
      expect(signInIdentityFor(SIGN_IN)).toBe('chromium')
    } finally {
      // The rest of this file runs with the experiment on.
      overrideSignInIdentity('google', 'firefox')
    }
  })
})

beforeAll(() => overrideSignInIdentity('google', 'firefox'))
afterAll(() => overrideSignInIdentity('google', null))

const id = browserIdentity({ chrome: '156.0.8078.49', platform: 'darwin', arch: 'arm64', systemVersion: '26.6.2' })
const FF = firefoxUserAgent('darwin')
const CR = id.userAgent

describe('the Firefox User-Agent', () => {
  it("is desktop Firefox's exact format on each platform", () => {
    expect(firefoxUserAgent('darwin', 156)).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0')
    expect(firefoxUserAgent('win32', 156)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0')
    expect(firefoxUserAgent('linux', 156)).toBe('Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0')
    expect(FF).toMatch(/^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10\.15; rv:(\d+)\.0\) Gecko\/20100101 Firefox\/\1\.0$/)
    expect(FF).not.toMatch(/Chrome|AppleWebKit|Electron|Atelier/)
  })

  it('names a recent stable major (Firefox 140 ESR shipped June 2025; a release every four weeks since)', () => {
    expect(Number.isInteger(FIREFOX_MAJOR)).toBe(true)
    expect(FIREFOX_MAJOR).toBeGreaterThanOrEqual(150)
    expect(FIREFOX_MAJOR).toBeLessThan(170)
  })
})

describe('which requests go out as Firefox', () => {
  const at = (url: string, resourceType = 'mainFrame') => ({ url, resourceType })

  it("is a 'firefox' sign-in page and everything it loads, nothing else", () => {
    expect(requestIdentity(at('https://accounts.google.com/v3/signin/identifier'), null)).toBe('firefox')
    // A redirect into the sign-in host: the main-frame request's own URL decides.
    expect(requestIdentity(at('https://accounts.google.com/ServiceLogin'), 'https://accounts.google.com/ServiceLogin')).toBe('firefox')
    expect(requestIdentity(at('https://www.gstatic.com/_/mss/boq-identity/x.js', 'script'), 'https://accounts.google.com/v3/signin/identifier')).toBe('firefox')
    expect(requestIdentity(at('https://www.google.com/recaptcha/api2/anchor', 'subFrame'), 'https://accounts.google.com/v3/signin/identifier')).toBe('firefox')
    // Leaving: Gmail's own page is Chromium from its first request, even while the tab still shows the sign-in page.
    expect(requestIdentity(at('https://mail.google.com/mail/u/0/'), 'https://accounts.google.com/CheckCookie')).toBe('chromium')
    expect(requestIdentity(at('https://mail.google.com/sync', 'xhr'), 'https://mail.google.com/mail/u/0/')).toBe('chromium')
    expect(requestIdentity(at('https://www.gstatic.com/x.js', 'script'), null)).toBe('chromium')
    // Other providers keep Atelier's identity.
    expect(requestIdentity(at('https://login.microsoftonline.com/common/oauth2/v2.0/authorize'), null)).toBe('chromium')
    expect(requestIdentity(at('https://github.githubassets.com/x.js', 'script'), 'https://github.com/login')).toBe('chromium')
  })
})

describe('the headers for an identity', () => {
  const ua = { firefox: FF, chromium: CR }

  it("Firefox: its User-Agent, keeping the header's own name, and no client hints", () => {
    const out = identityHeaders({ 'User-Agent': CR, 'sec-ch-ua': '"Chromium";v="156"', 'Sec-CH-UA-Mobile': '?0', 'sec-ch-ua-platform': '"macOS"', 'sec-ch-ua-full-version-list': 'x', Accept: '*/*', 'Sec-Fetch-Mode': 'navigate' }, 'firefox', ua)
    expect(out).toEqual({ 'User-Agent': FF, Accept: '*/*', 'Sec-Fetch-Mode': 'navigate' })
    expect(identityHeaders({ 'user-agent': CR }, 'firefox', ua)).toEqual({ 'user-agent': FF })
    expect(identityHeaders({ Accept: '*/*' }, 'firefox', ua)).toEqual({ Accept: '*/*', 'User-Agent': FF })
    expect(identityHeaders({ 'User-Agent': FF, Accept: '*/*' }, 'firefox', ua)).toBeNull()
  })

  it('Chromium: untouched, except a Firefox User-Agent left from a sign-in page', () => {
    expect(identityHeaders({ 'User-Agent': CR, 'sec-ch-ua': 'x' }, 'chromium', ua)).toBeNull()
    expect(identityHeaders({ 'User-Agent': 'Something else' }, 'chromium', ua)).toBeNull()
    expect(identityHeaders({ Accept: '*/*' }, 'chromium', ua)).toBeNull()
    expect(identityHeaders({ 'User-Agent': FF, Accept: '*/*' }, 'chromium', ua)).toEqual({ 'User-Agent': CR, Accept: '*/*' })
  })
})

describe('the two layers in the webRequest mux', () => {
  // The order sitesSafety installs them: client hints first, then the sign-in identity.
  const tabAt = (url: string) => ({ getURL: () => url, isDestroyed: () => false }) as unknown as WebContents
  const topUrl = (d: { webContents?: WebContents; resourceType: string; url: string }): string | null => (d.resourceType === 'mainFrame' ? d.url : (d.webContents?.getURL() ?? null))
  const hints = clientHintsLayer({ identity: () => id, topUrl, exempt: (d) => isFirefoxRequest(d, topUrl) })
  const layers = [hints, signInIdentityLayer({ topUrl, firefox: () => FF, chromium: () => CR })]
  const send = (url: string, resourceType: string, wc: WebContents | undefined, requestHeaders: Record<string, string> = { 'User-Agent': CR }) =>
    runBeforeSendHeaders(layers, { id: 1, url, method: 'GET', resourceType, referrer: '', timestamp: 0, requestHeaders, webContents: wc } as unknown as OnBeforeSendHeadersListenerDetails).requestHeaders as Record<string, string> | undefined
  const hintNames = (h: Record<string, string> | undefined): string[] => Object.keys(h ?? {}).filter((k) => /^sec-ch-/i.test(k))

  it('sends the sign-in page and its loads as Firefox, with no hints even when the renderer added them', () => {
    const wc = tabAt('https://mail.google.com/')
    const nav = send('https://accounts.google.com/v3/signin/identifier', 'mainFrame', wc)
    expect(nav?.['User-Agent']).toBe(FF)
    expect(hintNames(nav)).toEqual([])
    const signIn = tabAt('https://accounts.google.com/v3/signin/identifier')
    const fetched = send('https://www.gstatic.com/x.js', 'script', signIn, { 'User-Agent': FF, 'sec-ch-ua': '"Chromium";v="156"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' })
    expect(fetched?.['User-Agent']).toBe(FF)
    expect(hintNames(fetched)).toEqual([])
  })

  it("doesn't answer the sign-in host's Accept-CH", () => {
    const local = clientHintsLayer({ identity: () => id, topUrl, exempt: (d) => isFirefoxRequest(d, topUrl) })
    runHeadersReceived([local], { id: 1, url: 'https://accounts.google.com/', method: 'GET', resourceType: 'mainFrame', referrer: '', timestamp: 0, statusLine: 'HTTP/1.1 200', statusCode: 200, responseHeaders: { 'accept-ch': ['Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch'] } } as unknown as OnHeadersReceivedListenerDetails)
    expect(local.accepted('https://accounts.google.com')).toEqual([])
    runHeadersReceived([local], { id: 2, url: 'https://example.com/', method: 'GET', resourceType: 'mainFrame', referrer: '', timestamp: 0, statusLine: 'HTTP/1.1 200', statusCode: 200, responseHeaders: { 'accept-ch': ['Sec-CH-UA-Arch'] } } as unknown as OnHeadersReceivedListenerDetails)
    expect(local.accepted('https://example.com')).toEqual(['sec-ch-ua-arch'])
  })

  it('leaves every other request exactly as before, and turns a leftover Firefox User-Agent back into Chromium', () => {
    const wc = tabAt('https://accounts.google.com/CheckCookie')
    const gmail = send('https://mail.google.com/mail/u/0/', 'mainFrame', wc, { 'User-Agent': FF })
    expect(gmail?.['User-Agent']).toBe(CR)
    expect(hintNames(gmail).sort()).toEqual(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'])
    const before = runBeforeSendHeaders([hints], { id: 1, url: 'https://example.com/a', method: 'GET', resourceType: 'xhr', referrer: '', timestamp: 0, requestHeaders: { 'User-Agent': CR }, webContents: tabAt('https://example.com/') } as unknown as OnBeforeSendHeadersListenerDetails)
    expect(send('https://example.com/a', 'xhr', tabAt('https://example.com/'))).toEqual(before.requestHeaders)
    expect(send('https://login.microsoftonline.com/common', 'mainFrame', tabAt('https://example.com/'))?.['User-Agent']).toBe(CR)
  })
})

class FakeTab extends EventEmitter {
  url = ''
  loading = false
  set: string[] = []
  loads: { url: string; referrer?: string }[] = []
  readonly session = { getUserAgent: () => CR }
  getURL(): string {
    return this.url
  }
  isDestroyed(): boolean {
    return false
  }
  isLoading(): boolean {
    return this.loading
  }
  setUserAgent(ua: string): void {
    this.set.push(ua === FF ? 'firefox' : ua === CR ? 'chromium' : ua)
  }
  loadURL(url: string, opts?: { httpReferrer?: { url: string } }): Promise<void> {
    this.loads.push({ url, referrer: opts?.httpReferrer?.url })
    return Promise.resolve()
  }
  /** A main-frame navigation start; `from`: the page that started it (a renderer navigation), else the browser. */
  start(url: string, from?: string, isSameDocument = false): void {
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument, initiator: from ? { url: from } : undefined })
  }
  redirect(url: string, from?: string): boolean {
    let prevented = false
    this.emit('will-redirect', { url, isMainFrame: true, isSameDocument: false, initiator: from ? { url: from } : undefined, preventDefault: () => (prevented = true) })
    return prevented
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe("the tab's navigator", () => {
  const watched = (url = 'https://mail.google.com/'): FakeTab & WebContents => {
    const t = new FakeTab()
    t.url = url
    watchSignInIdentity(t as unknown as WebContents, { firefox: FF })
    // A tab's first page is loaded by the browser (tabs.create).
    t.start(url)
    return t as FakeTab & WebContents
  }

  it('is Firefox from the start of a navigation to Google sign-in, and the session UA again from the start of one away', () => {
    const t = watched()
    t.start('https://accounts.google.com/v3/signin/identifier', 'https://mail.google.com/')
    expect(t.set).toEqual(['firefox'])
    expect(tabIdentity(t)).toBe('firefox')
    t.url = 'https://accounts.google.com/v3/signin/identifier'
    // Moving around the sign-in pages, and in-page navigations and frames, change nothing.
    t.start('https://accounts.google.com/v3/signin/challenge/pwd', t.url)
    t.start('https://accounts.google.com/v3/signin/challenge/pwd#x', t.url, true)
    t.emit('did-start-navigation', { url: 'https://www.google.com/recaptcha', isMainFrame: false, isSameDocument: false })
    t.emit('did-stop-loading')
    expect(t.set).toEqual(['firefox'])
    t.start('https://mail.google.com/mail/u/0/', t.url)
    expect(t.set).toEqual(['firefox', 'chromium'])
    expect(tabIdentity(t)).toBe('chromium')
    expect(t.loads).toEqual([])
  })

  it('never touches a tab that stays off Google sign-in, other providers included', () => {
    const t = watched()
    t.start('https://www.youtube.com/', t.url)
    t.start('https://login.microsoftonline.com/common', 'https://www.youtube.com/')
    t.start('https://github.com/login')
    expect(t.redirect('https://login.live.com/', 'https://github.com/login')).toBe(false)
    t.emit('did-stop-loading')
    expect(t.set).toEqual([])
    expect(t.loads).toEqual([])
  })

  it('loads a redirect into sign-in, or out of it, again as a navigation of its own', async () => {
    const t = watched()
    t.start('https://mail.google.com/mail/u/0/', t.url)
    expect(t.redirect('https://accounts.google.com/ServiceLogin?service=mail', 'https://mail.google.com/')).toBe(true)
    expect(t.set).toEqual([])
    await tick()
    expect(t.loads).toEqual([{ url: 'https://accounts.google.com/ServiceLogin?service=mail', referrer: 'https://mail.google.com/' }])
    t.start('https://accounts.google.com/ServiceLogin?service=mail')
    expect(t.set).toEqual(['firefox'])
    // Within sign-in, redirects run as they are.
    expect(t.redirect('https://accounts.google.com/v3/signin/identifier', 'https://mail.google.com/')).toBe(false)
    t.url = 'https://accounts.google.com/v3/signin/identifier'
    // Done: CheckCookie sends the person back to Gmail.
    expect(t.redirect('https://mail.google.com/mail/u/0/', t.url)).toBe(true)
    await tick()
    expect(t.loads.at(-1)).toEqual({ url: 'https://mail.google.com/mail/u/0/', referrer: t.url })
    t.start('https://mail.google.com/mail/u/0/')
    expect(t.set).toEqual(['firefox', 'chromium'])
  })

  it("starts a popup's sign-in page again from the browser, so the popup's own navigator says Firefox", async () => {
    const popup = new FakeTab() as FakeTab & WebContents
    watchSignInIdentity(popup, { firefox: FF })
    popup.start('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'https://app.example/')
    expect(popup.set).toEqual([])
    await tick()
    expect(popup.loads).toEqual([{ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', referrer: 'https://app.example/' }])
    popup.start('https://accounts.google.com/o/oauth2/v2/auth?client_id=x')
    expect(popup.set).toEqual(['firefox'])
    // From then on its own navigations take the override.
    popup.start('https://accounts.google.com/v3/signin/identifier', 'https://accounts.google.com/o/oauth2/v2/auth')
    popup.start('https://app.example/callback', 'https://accounts.google.com/v3/signin/identifier')
    expect(popup.set).toEqual(['firefox', 'chromium'])
    expect(popup.loads).toHaveLength(1)
    // A popup that never goes there is left alone.
    const plain = new FakeTab() as FakeTab & WebContents
    watchSignInIdentity(plain, { firefox: FF })
    plain.start('https://app.example/share', 'https://app.example/')
    await tick()
    expect(plain.loads).toEqual([])
    expect(plain.set).toEqual([])
  })

  it('goes back to the page it is on when a sign-in navigation never commits, but not while another loads', () => {
    const t = watched()
    t.start('https://accounts.google.com/', t.url)
    t.loading = true
    t.emit('did-stop-loading')
    expect(t.set).toEqual(['firefox'])
    t.loading = false
    t.emit('did-stop-loading')
    expect(t.set).toEqual(['firefox', 'chromium'])
  })
})
