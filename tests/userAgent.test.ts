/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { acceptLanguageHeader, expandLanguageList } from '@shared/languages'
import { isSignInHost, isSignInUrl } from '@shared/signInHosts'
import { brandList, browserIdentity, chromeMajor, greaseBrand, highEntropyHint, HIGH_ENTROPY_HINTS, lowEntropyHints, reducedUserAgent, userAgentMetadata } from '../src/main/userAgent'

// Sign-in compatibility: Atelier reports exactly what stock Chromium of its
// version reports (the reduced UA, Chromium's brand list and GREASE, the
// client hint header values, Chromium's Accept-Language expansion).

const mac = browserIdentity({ chrome: '156.0.8078.49', platform: 'darwin', arch: 'arm64', systemVersion: '26.6.2' })

describe('the reduced User-Agent', () => {
  it('has the major version only and the frozen platform token', () => {
    expect(reducedUserAgent('156.0.8078.49', 'darwin')).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36')
    expect(reducedUserAgent('156.0.8078.49', 'win32')).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36')
    expect(reducedUserAgent('156.0.8078.49', 'linux')).toContain('(X11; Linux x86_64)')
    expect(mac.userAgent).not.toMatch(/electron|atelier/i)
    expect(chromeMajor('156.0.8078.49')).toBe(156)
    expect(chromeMajor('nonsense')).toBe(0)
  })
})

describe("Chromium's brands", () => {
  it('computes the GREASE brand the way Chromium does', () => {
    // Values stock Chrome shipped with, and the one Electron 45 measured in the smoke check.
    expect(greaseBrand(120)).toEqual({ brand: 'Not_A Brand', version: '8' })
    expect(greaseBrand(124)).toEqual({ brand: 'Not-A.Brand', version: '99' })
    expect(greaseBrand(156)).toEqual({ brand: 'Not:A-Brand', version: '8' })
    expect(greaseBrand(156, true)).toEqual({ brand: 'Not:A-Brand', version: '8.0.0.0' })
  })

  it('orders GREASE and Chromium by the major version, with no product brand', () => {
    expect(brandList('156.0.8078.49')).toEqual([{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }])
    expect(brandList('157.0.1.2')[0]).toEqual({ brand: 'Chromium', version: '157' })
    expect(brandList('156.0.8078.49', true)).toEqual([{ brand: 'Not:A-Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: '156.0.8078.49' }])
    expect(JSON.stringify(brandList('156.0.8078.49'))).not.toMatch(/electron|atelier|google/i)
  })

  it('reports macOS on Apple silicon like Chromium does', () => {
    expect(mac).toMatchObject({ platform: 'macOS', platformVersion: '26.6.2', architecture: 'arm', bitness: '64', model: '', mobile: false, wow64: false, formFactors: ['Desktop'], fullVersion: '156.0.8078.49' })
    expect(browserIdentity({ chrome: '156.0.1.2', platform: 'darwin', arch: 'x64', systemVersion: '15.1' })).toMatchObject({ architecture: 'x86', platformVersion: '15.1.0' })
    expect(browserIdentity({ chrome: '156.0.1.2', platform: 'win32', arch: 'x64', systemVersion: '10.0.22631' }).platformVersion).toBe('')
  })

  it('gives DevTools the same metadata, so a tab override keeps its client hints', () => {
    expect(userAgentMetadata(mac)).toEqual({
      brands: mac.brands,
      fullVersionList: mac.fullVersionList,
      fullVersion: '156.0.8078.49',
      platform: 'macOS',
      platformVersion: '26.6.2',
      architecture: 'arm',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
      formFactors: ['Desktop'],
    })
  })
})

describe('client hint header values', () => {
  it('writes the structured fields as Chromium does', () => {
    expect(lowEntropyHints(mac)).toEqual({ 'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' })
    const values = Object.fromEntries(HIGH_ENTROPY_HINTS.map((h) => [h, highEntropyHint(h, mac)]))
    expect(values).toEqual({
      'sec-ch-ua-full-version-list': '"Not:A-Brand";v="8.0.0.0", "Chromium";v="156.0.8078.49"',
      'sec-ch-ua-full-version': '"156.0.8078.49"',
      'sec-ch-ua-platform-version': '"26.6.2"',
      'sec-ch-ua-arch': '"arm"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-model': '""',
      'sec-ch-ua-wow64': '?0',
      'sec-ch-ua-form-factors': '"Desktop"',
    })
    const win = browserIdentity({ chrome: '156.0.1.2', platform: 'win32', arch: 'x64', systemVersion: '' })
    expect(highEntropyHint('sec-ch-ua-platform-version', win)).toBeNull()
  })
})

describe("Chromium's Accept-Language", () => {
  it('expands each tag with its base language when the next tag is of another family', () => {
    expect(expandLanguageList(['en-US', 'fr', 'en'])).toEqual(['en-US', 'en', 'fr'])
    expect(expandLanguageList(['en-US', 'en-NL', 'nl-NL'])).toEqual(['en-US', 'en-NL', 'en', 'nl-NL', 'nl'])
    expect(expandLanguageList(['nl', 'en-US'])).toEqual(['nl', 'en-US', 'en'])
    expect(expandLanguageList(['x-klingon'])).toEqual(['x-klingon'])
    expect(acceptLanguageHeader(['nl', 'en-US'])).toBe('nl,en-US;q=0.9,en;q=0.8')
    expect(acceptLanguageHeader(['en-US', 'en-NL', 'nl-NL'])).toBe('en-US,en-NL;q=0.9,en;q=0.8,nl-NL;q=0.7,nl;q=0.6')
  })
})

describe('sign-in hosts', () => {
  it("names Google's account pages and nothing else", () => {
    for (const host of ['accounts.google.com', 'ACCOUNTS.GOOGLE.COM.', 'accounts.google.nl', 'accounts.google.co.uk', 'accounts.google.com.au', 'accounts.youtube.com', 'myaccount.google.com']) expect(isSignInHost(host), host).toBe(true)
    for (const host of ['google.com', 'mail.google.com', 'www.youtube.com', 'accounts.google.com.evil.example', 'evilaccounts.google.com', 'accounts.example.com']) expect(isSignInHost(host), host).toBe(false)
    expect(isSignInUrl('https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn')).toBe(true)
    expect(isSignInUrl('http://accounts.google.com/')).toBe(false)
    expect(isSignInUrl('not a url')).toBe(false)
  })
})
