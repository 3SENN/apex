/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest'
import { isSignInHost, isSignInUrl, overrideSignInIdentity, providerIdentity, SIGN_IN_PROVIDERS, signInIdentityFor, signInProviderAt, signInProviderFor } from '@shared/signInHosts'

// The sign-in provider registry: which pages are a provider's sign-in, and the
// identity Apex presents there (Chromium for every provider; Firefox for
// Google only while Experiments' "Google sign-in: present as Firefox" is on).

const providerOf = (url: string): string | null => signInProviderFor(url)?.id ?? null

describe('sign-in providers', () => {
  it('has one entry per provider, and every one presents Chromium by default, Google too', () => {
    const ids = SIGN_IN_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['google', 'microsoft', 'apple', 'meta', 'github', 'amazon', 'x', 'linkedin', 'yahoo'])
    expect(SIGN_IN_PROVIDERS.filter((p) => p.identity !== 'chromium').map((p) => p.id)).toEqual([])
  })

  it("matches Google's account hosts, their country variants and YouTube's", () => {
    for (const url of [
      'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn',
      'https://ACCOUNTS.GOOGLE.COM./ServiceLogin',
      'https://accounts.google.nl/',
      'https://accounts.google.co.uk/',
      'https://accounts.google.com.au/',
      'https://accounts.youtube.com/accounts/SetSID',
      'https://myaccount.google.com/security',
    ])
      expect(providerOf(url), url).toBe('google')
    for (const url of ['https://google.com/', 'https://mail.google.com/mail/u/0/', 'https://www.youtube.com/', 'https://accounts.google.com.evil.example/', 'https://evilaccounts.google.com/', 'https://accounts.example.com/'])
      expect(providerOf(url), url).toBeNull()
  })

  it('matches each other provider on its hosts and sign-in paths only', () => {
    const cases: [string, string | null][] = [
      ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'microsoft'],
      ['https://login.live.com/login.srf', 'microsoft'],
      ['https://login.microsoft.com/', 'microsoft'],
      ['https://account.live.com/proofs/Add', 'microsoft'],
      ['https://outlook.live.com/mail/', null],
      ['https://appleid.apple.com/sign-in', 'apple'],
      ['https://idmsa.apple.com/appleauth/auth/signin', 'apple'],
      ['https://www.apple.com/', null],
      ['https://www.facebook.com/login.php', 'meta'],
      ['https://www.facebook.com/login/device-based/regular/login/', 'meta'],
      ['https://facebook.com/login/', 'meta'],
      ['https://www.facebook.com/checkpoint/?next', 'meta'],
      ['https://www.facebook.com/', null],
      ['https://www.facebook.com/zuck', null],
      ['https://m.facebook.com/home.php', 'meta'],
      ['https://www.instagram.com/accounts/login/', 'meta'],
      ['https://www.instagram.com/explore/', null],
      ['https://github.com/login', 'github'],
      ['https://github.com/login/oauth/authorize?client_id=x', 'github'],
      ['https://github.com/session', 'github'],
      ['https://github.com/sessions/two-factor/app', 'github'],
      ['https://github.com/anthropics', null],
      ['https://gist.github.com/login', null],
      ['https://www.amazon.com/ap/signin?openid.return_to=x', 'amazon'],
      ['https://www.amazon.de/ap/signin', 'amazon'],
      ['https://www.amazon.co.uk/ap/mfa', 'amazon'],
      ['https://www.amazon.com.au/ap/signin', 'amazon'],
      ['https://www.amazon.com/dp/B000', null],
      ['https://x.com/i/flow/login', 'x'],
      ['https://twitter.com/i/flow/login?redirect_after_login=%2F', 'x'],
      ['https://x.com/home', null],
      ['https://www.linkedin.com/login', 'linkedin'],
      ['https://www.linkedin.com/checkpoint/lg/login-submit', 'linkedin'],
      ['https://www.linkedin.com/uas/login?session_redirect=x', 'linkedin'],
      ['https://www.linkedin.com/feed/', null],
      ['https://login.yahoo.com/', 'yahoo'],
      ['https://mail.yahoo.com/', null],
    ]
    for (const [url, id] of cases) expect(providerOf(url), url).toBe(id)
  })

  it('needs https, a parseable URL, and a sign-in path where the provider names some', () => {
    expect(isSignInUrl('https://accounts.google.com/')).toBe(true)
    expect(isSignInUrl('http://accounts.google.com/')).toBe(false)
    expect(isSignInUrl('not a url')).toBe(false)
    expect(isSignInUrl('apex://newtab')).toBe(false)
    expect(signInProviderAt('github.com', '/LOGIN')?.id).toBe('github')
    expect(signInProviderAt('github.com', '/')).toBeNull()
  })

  it('names a host as a sign-in host only when every page there is one', () => {
    for (const host of ['accounts.google.com', 'accounts.google.nl', 'accounts.youtube.com', 'myaccount.google.com', 'login.microsoftonline.com', 'appleid.apple.com', 'm.facebook.com', 'login.yahoo.com']) expect(isSignInHost(host), host).toBe(true)
    for (const host of ['github.com', 'www.facebook.com', 'x.com', 'www.amazon.com', 'www.linkedin.com', 'mail.google.com']) expect(isSignInHost(host), host).toBe(false)
  })

  it('gives each page its identity: Chromium everywhere, Google sign-in included', () => {
    for (const url of ['https://accounts.google.com/v3/signin/identifier', 'https://accounts.youtube.com/', 'https://mail.google.com/', 'https://login.microsoftonline.com/', 'https://github.com/login', 'garbage']) {
      expect(signInIdentityFor(url), url).toBe('chromium')
    }
  })

  it("switches Google's sign-in pages to Firefox while overridden, and only those", () => {
    try {
      overrideSignInIdentity('google', 'firefox')
      expect(signInIdentityFor('https://accounts.google.com/v3/signin/identifier')).toBe('firefox')
      expect(signInIdentityFor('https://accounts.youtube.com/')).toBe('firefox')
      expect(signInIdentityFor('https://mail.google.com/')).toBe('chromium')
      expect(signInIdentityFor('https://login.microsoftonline.com/')).toBe('chromium')
      expect(providerIdentity(SIGN_IN_PROVIDERS[0]!)).toBe('firefox')
      // The registry itself is unchanged.
      expect(SIGN_IN_PROVIDERS[0]!.identity).toBe('chromium')
    } finally {
      overrideSignInIdentity('google', null)
    }
    expect(signInIdentityFor('https://accounts.google.com/v3/signin/identifier')).toBe('chromium')
  })
})

describe('smoke-only sign-in hosts', () => {
  const saved = { smoke: process.env.APEX_SMOKE, hosts: process.env.APEX_SMOKE_SIGNIN_HOSTS }
  afterEach(() => {
    if (saved.smoke === undefined) delete process.env.APEX_SMOKE
    else process.env.APEX_SMOKE = saved.smoke
    if (saved.hosts === undefined) delete process.env.APEX_SMOKE_SIGNIN_HOSTS
    else process.env.APEX_SMOKE_SIGNIN_HOSTS = saved.hosts
  })

  it('add whole hosts to a provider, on http too, only under APEX_SMOKE', () => {
    process.env.APEX_SMOKE_SIGNIN_HOSTS = 'accounts.google.localhost=google, login.ms.localhost=microsoft, bad.localhost=nobody'
    delete process.env.APEX_SMOKE
    expect(providerOf('http://accounts.google.localhost:5000/x')).toBeNull()
    process.env.APEX_SMOKE = '1'
    expect(providerOf('http://accounts.google.localhost:5000/x')).toBe('google')
    expect(signInIdentityFor('http://accounts.google.localhost:5000/x')).toBe('chromium')
    expect(providerOf('https://login.ms.localhost/')).toBe('microsoft')
    expect(isSignInHost('accounts.google.localhost')).toBe(true)
    expect(providerOf('http://bad.localhost/')).toBeNull()
    expect(providerOf('http://127.0.0.1:5000/')).toBeNull()
    // Real providers still need https.
    expect(providerOf('http://accounts.google.com/')).toBeNull()
  })
})
