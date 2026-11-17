/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { SiteSettings, SiteToggle } from '@shared/sites'
import { clearOnExit, cookiesBlocked, isThirdParty, privacyLayer, wantsClearOnExit, type PrivacyConfig } from '../src/main/privacy'
import { contentLayer, contentVerdict } from '../src/main/siteContent'
import { installWebRequestMux, layersFor, lockdownLayer, runBeforeRequest, runBeforeSendHeaders, runHeadersReceived, webRequest, webRequestHooks, type CoreLayers, type WebRequestHooks } from '../src/main/webRequest'

// The single webRequest owner: its fixed layer order, how layers
// chain, lockdown of sandbox partitions, and the privacy and per-site
// content layers it runs.

const req = (patch: Partial<OnBeforeRequestListenerDetails> = {}): OnBeforeRequestListenerDetails =>
  ({ id: 1, url: 'https://news.example/app.js', method: 'GET', resourceType: 'script', referrer: '', timestamp: 0, uploadData: [], frame: null, ...patch }) as unknown as OnBeforeRequestListenerDetails
const sendReq = (headers: Record<string, string>, patch: Partial<OnBeforeSendHeadersListenerDetails> = {}): OnBeforeSendHeadersListenerDetails =>
  ({ ...req(), requestHeaders: headers, ...patch }) as unknown as OnBeforeSendHeadersListenerDetails
const recvReq = (headers: Record<string, string[]> | undefined, patch: Partial<OnHeadersReceivedListenerDetails> = {}): OnHeadersReceivedListenerDetails =>
  ({ ...req(), statusLine: 'HTTP/1.1 200 OK', statusCode: 200, responseHeaders: headers, ...patch }) as unknown as OnHeadersReceivedListenerDetails

const fakeSession = (): Session => ({}) as Session
const noCore: CoreLayers = { safety: null, adblock: null, privacy: null, content: null }

describe('the mux order', () => {
  it('runs safety, ad blocking, privacy, content, then registered hooks', () => {
    const seen: string[] = []
    const layer = (name: string): WebRequestHooks => ({ onBeforeRequest: () => (seen.push(name), null) })
    const s = fakeSession()
    const off = webRequestHooks.add(layer('hook'))
    const layers = layersFor(s, true, { safety: layer('safety'), adblock: layer('adblock'), privacy: layer('privacy'), content: layer('content') })
    runBeforeRequest(layers, req())
    expect(seen).toEqual(['safety', 'adblock', 'privacy', 'content', 'hook'])
    off()
  })

  it('gives non-browsing sessions only the hooks that ask for them', () => {
    const s = fakeSession()
    const other = fakeSession()
    const web: WebRequestHooks = {}
    const all: WebRequestHooks = {}
    const mine: WebRequestHooks = {}
    const offs = [webRequestHooks.add(web), webRequestHooks.add(all, { sessions: 'all' }), webRequestHooks.add(mine, { sessions: [s] })]
    const core = { ...noCore, safety: {} }
    expect(layersFor(s, false, core)).toEqual([all, mine])
    expect(layersFor(other, false, core)).toEqual([all])
    expect(layersFor(other, true, core)).toEqual([core.safety, web, all])
    for (const off of offs) off()
    expect(layersFor(other, true, noCore)).toEqual([])
  })

  it('locks a sandbox partition down to its allow list, with no other layer', () => {
    const s = fakeSession()
    const hook = vi.fn(() => null)
    const off = webRequestHooks.add({ onBeforeRequest: hook }, { sessions: 'all' })
    webRequest.lockdown(s, ({ url }) => url.startsWith('atelier-artifact:'))
    const layers = layersFor(s, false, noCore)
    expect(layers).toHaveLength(1)
    expect(runBeforeRequest(layers, req({ url: 'atelier-artifact://x/index.html' }))).toEqual({})
    expect(runBeforeRequest(layers, req({ url: 'https://exfil.example/' }))).toEqual({ cancel: true })
    expect(hook).not.toHaveBeenCalled()
    expect(webRequest.lockdownFor(fakeSession())).toBeUndefined()
    off()
  })

  it('lockdownLayer passes the resource type to the allow function', () => {
    const allow = vi.fn(() => true)
    lockdownLayer(allow).onBeforeRequest?.(req({ resourceType: 'image' }))
    expect(allow).toHaveBeenCalledWith({ url: 'https://news.example/app.js', resourceType: 'image' })
  })
})

describe('chaining', () => {
  it('stops at the first cancel or redirect', () => {
    const later = vi.fn(() => null)
    expect(runBeforeRequest([{ onBeforeRequest: () => ({ cancel: true }) }, { onBeforeRequest: later }], req())).toEqual({ cancel: true })
    expect(runBeforeRequest([{ onBeforeRequest: () => ({ redirectURL: 'https://b.example/' }) }, { onBeforeRequest: later }], req())).toEqual({ redirectURL: 'https://b.example/' })
    expect(later).not.toHaveBeenCalled()
    // An empty answer is no opinion.
    expect(runBeforeRequest([{ onBeforeRequest: () => ({}) }, { onBeforeRequest: () => ({ cancel: true }) }], req())).toEqual({ cancel: true })
  })

  it('skips a throwing layer instead of stalling the request', () => {
    const boom: WebRequestHooks = {
      onBeforeRequest: () => {
        throw new Error('boom')
      },
    }
    expect(runBeforeRequest([boom, { onBeforeRequest: () => ({ cancel: true }) }], req())).toEqual({ cancel: true })
    expect(runBeforeSendHeaders([{ onBeforeSendHeaders: () => { throw new Error('boom') } }], sendReq({ a: '1' }))).toEqual({})
  })

  it('hands each layer the request headers the previous one left', () => {
    const second = vi.fn((d: OnBeforeSendHeadersListenerDetails) => ({ requestHeaders: { ...d.requestHeaders, B: '2' } }))
    const out = runBeforeSendHeaders([{ onBeforeSendHeaders: (d) => ({ requestHeaders: { ...d.requestHeaders, A: '1' } }) }, { onBeforeSendHeaders: second }], sendReq({ X: '0' }))
    expect(second.mock.calls[0]?.[0].requestHeaders).toEqual({ X: '0', A: '1' })
    expect(out).toEqual({ requestHeaders: { X: '0', A: '1', B: '2' } })
    expect(runBeforeSendHeaders([{ onBeforeSendHeaders: () => null }], sendReq({ X: '0' }))).toEqual({})
    expect(runBeforeSendHeaders([{ onBeforeSendHeaders: () => ({ cancel: true }) }, { onBeforeSendHeaders: second }], sendReq({}))).toEqual({ cancel: true })
  })

  it('chains response headers and keeps the last status line', () => {
    const out = runHeadersReceived(
      [
        { onHeadersReceived: (d) => ({ responseHeaders: { ...d.responseHeaders, a: ['1'] }, statusLine: 'HTTP/1.1 203' }) },
        { onHeadersReceived: (d) => ({ responseHeaders: { ...d.responseHeaders, b: ['2'] } }) },
      ],
      recvReq({ x: ['0'] }),
    )
    expect(out).toEqual({ responseHeaders: { x: ['0'], a: ['1'], b: ['2'] }, statusLine: 'HTTP/1.1 203' })
    expect(runHeadersReceived([{ onHeadersReceived: () => null }], recvReq({ x: ['0'] }))).toEqual({})
    expect(runHeadersReceived([{ onHeadersReceived: () => ({ cancel: true }) }], recvReq({}))).toEqual({ cancel: true })
  })
})

describe('installWebRequestMux', () => {
  it('becomes the one listener per event, once per session', () => {
    const onBeforeRequest = vi.fn()
    const onBeforeSendHeaders = vi.fn()
    const onHeadersReceived = vi.fn()
    const s = { webRequest: { onBeforeRequest, onBeforeSendHeaders, onHeadersReceived } } as unknown as Session
    installWebRequestMux(s, true, { ...noCore, safety: { onBeforeRequest: (d) => (d.url.includes('bad') ? { cancel: true } : null) } })
    installWebRequestMux(s, true, noCore)
    expect(onBeforeRequest).toHaveBeenCalledTimes(1)
    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    expect(onHeadersReceived).toHaveBeenCalledTimes(1)
    const listener = onBeforeRequest.mock.calls[0]?.[0] as (d: OnBeforeRequestListenerDetails, cb: (r: unknown) => void) => void
    const cb = vi.fn()
    listener(req({ url: 'https://bad.example/' }), cb)
    listener(req({ url: 'https://good.example/' }), cb)
    expect(cb.mock.calls).toEqual([[{ cancel: true }], [{}]])
  })
})

describe('privacy', () => {
  const rules = (map: Record<string, SiteToggle> = {}) => (origin: string): SiteToggle => map[origin] ?? 'default'

  it('judges third parties by registrable domain', () => {
    expect(isThirdParty('https://cdn.news.example/a.js', 'https://www.news.example/')).toBe(false)
    expect(isThirdParty('https://tracker.example/p', 'https://news.example/')).toBe(true)
    expect(isThirdParty('https://a.github.io/x', 'https://b.github.io/')).toBe(true)
    expect(isThirdParty('https://tracker.example/p', null)).toBe(false)
    expect(isThirdParty('data:text/plain,x', 'https://news.example/')).toBe(false)
  })

  it('strips third-party cookies unless a site is allowed, and always for a blocked site', () => {
    const top = 'https://news.example/'
    expect(cookiesBlocked('https://tracker.example/p', top, true, rules())).toBe(true)
    expect(cookiesBlocked('https://tracker.example/p', top, false, rules())).toBe(false)
    expect(cookiesBlocked('https://tracker.example/p', top, true, rules({ 'https://tracker.example': 'allow' }))).toBe(false)
    expect(cookiesBlocked('https://tracker.example/p', top, true, rules({ 'https://news.example': 'allow' }))).toBe(false)
    expect(cookiesBlocked('https://news.example/a', top, false, rules({ 'https://news.example': 'block' }))).toBe(true)
    expect(cookiesBlocked('https://news.example/a', top, true, rules())).toBe(false)
  })

  const layer = (cfg: PrivacyConfig, top: string | null = 'https://news.example/', map: Record<string, SiteToggle> = {}): WebRequestHooks =>
    privacyLayer({ config: () => cfg, topUrl: () => top, cookieRule: rules(map) })

  it('sends Sec-GPC when asked and leaves headers alone otherwise', () => {
    const on = layer({ blockThirdPartyCookies: false, globalPrivacyControl: true })
    expect(on.onBeforeSendHeaders?.(sendReq({ Accept: '*/*' }))).toEqual({ requestHeaders: { Accept: '*/*', 'Sec-GPC': '1' } })
    expect(on.onBeforeSendHeaders?.(sendReq({ 'Sec-GPC': '1' }))).toBeNull()
    const off = layer({ blockThirdPartyCookies: false, globalPrivacyControl: false })
    expect(off.onBeforeSendHeaders?.(sendReq({ Cookie: 'a=1' }))).toBeNull()
  })

  it('removes cookies both ways on a blocked request', () => {
    const l = layer({ blockThirdPartyCookies: true, globalPrivacyControl: false })
    const url = 'https://tracker.example/pixel'
    expect(l.onBeforeSendHeaders?.(sendReq({ cookie: 'id=1', Accept: '*/*' }, { url }))).toEqual({ requestHeaders: { Accept: '*/*' } })
    expect(l.onHeadersReceived?.(recvReq({ 'Set-Cookie': ['id=2'], 'Content-Type': ['image/gif'] }, { url }))).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } })
    expect(l.onHeadersReceived?.(recvReq({ 'Content-Type': ['image/gif'] }, { url }))).toBeNull()
    expect(l.onHeadersReceived?.(recvReq(undefined, { url }))).toBeNull()
    // First-party requests keep theirs.
    expect(l.onBeforeSendHeaders?.(sendReq({ cookie: 'id=1' }, { url: 'https://news.example/api' }))).toBeNull()
  })

  it('clears what was chosen on exit, carrying on past a failure', async () => {
    const order: string[] = []
    const failed = await clearOnExit(
      { cookies: true, cache: true, history: true },
      {
        clearCookies: async () => void order.push('cookies'),
        clearCache: async () => {
          order.push('cache')
          throw new Error('busy')
        },
        clearHistory: async () => void order.push('history'),
      },
    )
    expect(order).toEqual(['cookies', 'cache', 'history'])
    expect(failed).toEqual(['cache'])
    const skipped = vi.fn(async () => undefined)
    expect(await clearOnExit({ cookies: false, cache: false, history: true }, { clearCookies: skipped, clearCache: skipped, clearHistory: async () => undefined })).toEqual([])
    expect(skipped).not.toHaveBeenCalled()
    expect(wantsClearOnExit({ cookies: false, cache: false, history: false })).toBe(false)
    expect(wantsClearOnExit({ cookies: false, cache: true, history: false })).toBe(true)
  })
})

describe('per-site content', () => {
  type Rules = Pick<SiteSettings, 'javascript' | 'images' | 'insecureContent'>
  const allDefault: Rules = { javascript: 'default', images: 'default', insecureContent: 'default' }
  const rulesFor = (r: Partial<Rules>) => (): Rules => ({ ...allDefault, ...r })
  const page = 'https://news.example/story'

  it('blocks scripts, images and insecure subresources only where the site says so', () => {
    expect(contentVerdict('script', 'https://news.example/a.js', page, rulesFor({}))).toBe('allow')
    expect(contentVerdict('script', 'https://cdn.example/a.js', page, rulesFor({ javascript: 'block' }))).toBe('block-script')
    expect(contentVerdict('image', 'https://cdn.example/a.png', page, rulesFor({ images: 'block' }))).toBe('block-image')
    expect(contentVerdict('image', 'http://cdn.example/a.png', page, rulesFor({ insecureContent: 'block' }))).toBe('block-insecure')
    expect(contentVerdict('image', 'http://cdn.example/a.png', 'http://news.example/', rulesFor({ insecureContent: 'block' }))).toBe('allow')
    // The page itself always loads, so the person can change the switch.
    expect(contentVerdict('mainFrame', page, page, rulesFor({ javascript: 'block' }))).toBe('allow')
    expect(contentVerdict('script', 'https://a.example/a.js', null, rulesFor({ javascript: 'block' }))).toBe('allow')
  })

  it('cancels blocked requests and adds a no-script policy to the site’s documents', () => {
    const l = contentLayer({ rules: rulesFor({ javascript: 'block' }), topUrl: () => page })
    expect(l.onBeforeRequest?.(req({ resourceType: 'script' }))).toEqual({ cancel: true })
    expect(l.onBeforeRequest?.(req({ resourceType: 'stylesheet' }))).toBeNull()
    const doc = l.onHeadersReceived?.(recvReq({ 'content-security-policy': ["default-src 'self'"] }, { resourceType: 'mainFrame', url: page }))
    expect(doc).toEqual({ responseHeaders: { 'content-security-policy': ["default-src 'self'", "script-src 'none'"] } })
    expect(l.onHeadersReceived?.(recvReq({}, { resourceType: 'image' }))).toBeNull()
    const open = contentLayer({ rules: rulesFor({}), topUrl: () => page })
    expect(open.onHeadersReceived?.(recvReq({}, { resourceType: 'mainFrame', url: page }))).toBeNull()
  })
})
