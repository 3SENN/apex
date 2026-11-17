/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails } from 'electron'
import { clientHintsLayer, isTrustworthy, parseAcceptCh } from '../src/main/clientHints'
import { browserIdentity } from '../src/main/userAgent'

// The client hints Electron leaves off navigations, frames and workers, added
// the way stock Chromium sends them (sign-in compatibility).

const id = browserIdentity({ chrome: '156.0.8078.49', platform: 'darwin', arch: 'arm64', systemVersion: '26.6.2' })

function layer(top: string | null = null) {
  return clientHintsLayer({ identity: () => id, topUrl: (d) => (d.resourceType === 'mainFrame' ? d.url : top) })
}

const send = (url: string, resourceType = 'mainFrame', requestHeaders: Record<string, string> = { 'User-Agent': id.userAgent }): OnBeforeSendHeadersListenerDetails =>
  ({ id: 1, url, method: 'GET', resourceType, referrer: '', timestamp: 0, requestHeaders }) as unknown as OnBeforeSendHeadersListenerDetails
const received = (url: string, responseHeaders: Record<string, string[]>, resourceType = 'mainFrame'): OnHeadersReceivedListenerDetails =>
  ({ id: 1, url, method: 'GET', resourceType, referrer: '', timestamp: 0, statusLine: 'HTTP/1.1 200', statusCode: 200, responseHeaders }) as unknown as OnHeadersReceivedListenerDetails

const headersOf = (r: { requestHeaders?: Record<string, string | string[]> } | null): Record<string, string | string[]> => r?.requestHeaders ?? {}

describe('client hints', () => {
  it('sends the low-entropy hints on every request to a secure origin', () => {
    const l = layer()
    const nav = headersOf(l.onBeforeSendHeaders?.(send('https://accounts.example/signin')) ?? null)
    expect(nav['sec-ch-ua']).toBe('"Not:A-Brand";v="8", "Chromium";v="156"')
    expect(nav['sec-ch-ua-mobile']).toBe('?0')
    expect(nav['sec-ch-ua-platform']).toBe('"macOS"')
    expect(nav['User-Agent']).toBe(id.userAgent)
    expect(nav['sec-ch-ua-full-version-list']).toBeUndefined()
    expect(l.onBeforeSendHeaders?.(send('http://example.com/'))).toBeNull()
    expect(l.onBeforeSendHeaders?.(send('wss://example.com/', 'webSocket'))).toBeNull()
    expect(headersOf(l.onBeforeSendHeaders?.(send('http://127.0.0.1:8080/x', 'xhr')) ?? null)['sec-ch-ua']).toBeDefined()
  })

  it("keeps the renderer's own hints", () => {
    const l = layer()
    const own = { 'User-Agent': id.userAgent, 'Sec-CH-UA': 'renderer', 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"macOS"' }
    expect(l.onBeforeSendHeaders?.(send('https://example.com/a', 'xhr', own))).toBeNull()
  })

  it('honours Accept-CH from a top-level page on that origin, page and workers alike', () => {
    const l = layer('https://example.com/page')
    l.onHeadersReceived?.(received('https://example.com/page', { 'Accept-CH': ['Sec-CH-UA-Full-Version-List, sec-ch-ua-platform-version', 'Sec-CH-UA-Arch, DPR, Sec-CH-UA-Model'] }))
    expect(l.accepted('https://example.com')).toEqual(['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-model'])
    const sub = headersOf(l.onBeforeSendHeaders?.(send('https://example.com/api', 'xhr')) ?? null)
    expect(sub['sec-ch-ua-full-version-list']).toBe('"Not:A-Brand";v="8.0.0.0", "Chromium";v="156.0.8078.49"')
    expect(sub['sec-ch-ua-platform-version']).toBe('"26.6.2"')
    expect(sub['sec-ch-ua-arch']).toBe('"arm"')
    expect(sub['sec-ch-ua-model']).toBe('""')
    expect(sub['sec-ch-ua-bitness']).toBeUndefined()
    // A worker or service worker request has no page; it is the origin's own.
    const worker = clientHintsLayer({ identity: () => id, topUrl: () => null })
    worker.onHeadersReceived?.(received('https://example.com/', { 'accept-ch': ['Sec-CH-UA-Arch'] }))
    expect(headersOf(worker.onBeforeSendHeaders?.(send('https://example.com/sw.js', 'script')) ?? null)['sec-ch-ua-arch']).toBe('"arm"')
  })

  it('keeps high-entropy hints from third parties and ignores a frame\'s Accept-CH', () => {
    const l = layer('https://news.example/article')
    l.onHeadersReceived?.(received('https://example.com/', { 'accept-ch': ['Sec-CH-UA-Arch'] }))
    l.onHeadersReceived?.(received('https://ads.example/frame', { 'accept-ch': ['Sec-CH-UA-Model'] }, 'subFrame'))
    expect(l.accepted('https://ads.example')).toEqual([])
    const third = headersOf(l.onBeforeSendHeaders?.(send('https://example.com/pixel', 'image')) ?? null)
    expect(third['sec-ch-ua']).toBeDefined()
    expect(third['sec-ch-ua-arch']).toBeUndefined()
  })

  it('replaces an origin\'s answer with its latest Accept-CH, and an empty one clears it', () => {
    const l = layer()
    l.onHeadersReceived?.(received('https://example.com/', { 'accept-ch': ['Sec-CH-UA-Arch'] }))
    l.onHeadersReceived?.(received('https://example.com/next', { 'accept-ch': [''] }))
    expect(l.accepted('https://example.com')).toEqual([])
    l.onHeadersReceived?.(received('https://example.com/again', {}))
    expect(l.accepted('https://example.com')).toEqual([])
  })

  it('knows secure origins and Accept-CH names', () => {
    expect(isTrustworthy('https://a.example/')).toBe(true)
    expect(isTrustworthy('http://localhost:3000/')).toBe(true)
    expect(isTrustworthy('http://[::1]/')).toBe(true)
    expect(isTrustworthy('http://a.example/')).toBe(false)
    expect(isTrustworthy('app://apex/')).toBe(false)
    expect(parseAcceptCh(['Sec-CH-UA-WoW64 , Sec-CH-UA-Form-Factors,Sec-CH-UA-WoW64', 'Viewport-Width'])).toEqual(['sec-ch-ua-wow64', 'sec-ch-ua-form-factors'])
  })
})
