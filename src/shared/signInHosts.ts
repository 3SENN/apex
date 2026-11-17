/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Account sign-in pages, by provider. Each provider names the pages its
// sign-in runs on and the browser identity Atelier presents there:
// - 'chromium': Atelier's normal identity, stock desktop Chrome: the reduced
//   Chrome User-Agent with matching client hints (userAgent.ts,
//   clientHints.ts) and a filled-in window.chrome (preload/chromeSurfaceWorld.ts).
//   Every provider uses it, Google included: what Google's "This browser or
//   app may not be secure" keyed on in Electron was the empty window.chrome.
// - 'firefox': a current desktop Firefox (src/main/signInIdentity.ts). No
//   provider uses it by default; Experiments' "Google sign-in: present as
//   Firefox" switches Google to it (overrideSignInIdentity), should Google
//   start refusing the Chrome identity. A Firefox User-Agent on Chromium
//   contradicts navigator.userAgentData and Chrome-only APIs.
// On every sign-in page, whatever its identity, Atelier keeps the page as the
// engine makes it: no DevTools attachment for standing overrides (cdp.ts) and
// none of the page preload's main-world parts (preload/page.ts). The chrome
// surface is the one exception, as stock Chrome has it there. The agent still
// acts there when the person has it do so; that attaches only for as long as
// it acts.
// The OAuth popups, FedCM and passkeys work (src/main/popups.ts) imports this
// registry; keep names stable.

export type SignInIdentity = 'firefox' | 'chromium'

export type SignInProviderId = 'google' | 'microsoft' | 'apple' | 'meta' | 'github' | 'amazon' | 'x' | 'linkedin' | 'yahoo'

export interface SignInPages {
  /** An exact host name (lowercase), or a pattern for country variants. */
  host: string | RegExp
  /** Path prefixes (lowercase) that are sign-in pages; absent: every page on the host. */
  paths?: readonly string[]
}

export interface SignInProvider {
  id: SignInProviderId
  name: string
  identity: SignInIdentity
  pages: readonly SignInPages[]
}

/** accounts.google.com and its country variants (accounts.google.nl, .co.uk, .com.au). */
const GOOGLE_ACCOUNTS = /^accounts\.google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/
/** Amazon's storefronts (www.amazon.com, .de, .co.uk, .com.au). */
const AMAZON = /^www\.amazon\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = [
  {
    id: 'google',
    name: 'Google',
    identity: 'chromium',
    // myaccount.google.com: its security and sign-in settings re-authenticate in place.
    pages: [{ host: GOOGLE_ACCOUNTS }, { host: 'accounts.youtube.com' }, { host: 'myaccount.google.com' }],
  },
  {
    id: 'microsoft',
    name: 'Microsoft',
    identity: 'chromium',
    // login.windows.net: the older Entra ID endpoint, still in use.
    pages: [{ host: 'login.microsoftonline.com' }, { host: 'login.live.com' }, { host: 'login.microsoft.com' }, { host: 'account.live.com' }, { host: 'login.windows.net' }],
  },
  {
    id: 'apple',
    name: 'Apple',
    identity: 'chromium',
    // account.apple.com: the Apple Account site appleid.apple.com became.
    pages: [{ host: 'appleid.apple.com' }, { host: 'idmsa.apple.com' }, { host: 'account.apple.com' }],
  },
  {
    id: 'meta',
    name: 'Meta',
    identity: 'chromium',
    pages: [
      // /checkpoint and /two_step_verification: the steps after /login.
      { host: /^(?:www\.)?facebook\.com$/, paths: ['/login', '/checkpoint', '/two_step_verification'] },
      { host: 'm.facebook.com' },
      // /challenge: Instagram's verification step.
      { host: /^(?:www\.)?instagram\.com$/, paths: ['/accounts/login', '/challenge'] },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    identity: 'chromium',
    // /session covers /session and /sessions/two-factor, /sessions/verified-device.
    pages: [{ host: 'github.com', paths: ['/login', '/session'] }],
  },
  {
    id: 'amazon',
    name: 'Amazon',
    identity: 'chromium',
    // /ap/ is Amazon's authentication portal: /ap/signin and its steps (/ap/mfa, /ap/cvf).
    pages: [{ host: AMAZON, paths: ['/ap/'] }],
  },
  {
    id: 'x',
    name: 'X',
    identity: 'chromium',
    pages: [{ host: 'x.com', paths: ['/i/flow/login'] }, { host: 'twitter.com', paths: ['/i/flow/login'] }],
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    identity: 'chromium',
    // /uas/login: the older sign-in path OAuth still sends people to.
    pages: [{ host: /^(?:www\.)?linkedin\.com$/, paths: ['/login', '/checkpoint', '/uas/login'] }],
  },
  {
    id: 'yahoo',
    name: 'Yahoo',
    identity: 'chromium',
    pages: [{ host: 'login.yahoo.com' }],
  },
]

const normalHost = (hostname: string): string => hostname.toLowerCase().replace(/\.$/, '')

const hostMatches = (rule: SignInPages, host: string): boolean => (typeof rule.host === 'string' ? rule.host === host : rule.host.test(host))

const pathMatches = (rule: SignInPages, path: string): boolean => {
  if (!rule.paths) return true
  const p = path.toLowerCase()
  return rule.paths.some((prefix) => p.startsWith(prefix))
}

// ---- smoke-only extra hosts ----
// ATELIER_SMOKE_SIGNIN_HOSTS="<host>=<provider>,..." (read only under ATELIER_SMOKE=1)
// adds whole hosts to a provider, on http too: the smoke fixture server is
// plain http on this machine (src/main/smokeBrowser/signInIdentity.ts). Main and
// the page preload both read it, so a smoke page there is a sign-in page
// everywhere. Nothing else sets it.

type Env = Record<string, string | undefined>
// The free `process`: in a sandboxed preload it is the wrapper's argument, not a property of globalThis.
declare const process: { env?: Env } | undefined
const envOf = (): Env | undefined => {
  try {
    return typeof process === 'undefined' ? undefined : process.env
  } catch {
    return undefined
  }
}

let testRaw: string | undefined
let testHosts = new Map<string, SignInProvider>()

function smokeHosts(): Map<string, SignInProvider> {
  const env = envOf()
  const raw = env?.ATELIER_SMOKE === '1' ? env.ATELIER_SMOKE_SIGNIN_HOSTS : undefined
  if (raw === testRaw) return testHosts
  testRaw = raw
  testHosts = new Map()
  for (const pair of (raw ?? '').split(',')) {
    const [host, id] = pair.split('=').map((s) => s.trim())
    const provider = SIGN_IN_PROVIDERS.find((p) => p.id === id)
    if (host && provider) testHosts.set(normalHost(host), provider)
  }
  return testHosts
}

// ---- lookups ----

/** The provider whose sign-in page this host and path are, or null. */
export function signInProviderAt(hostname: string, pathname = '/'): SignInProvider | null {
  const host = normalHost(hostname)
  for (const provider of SIGN_IN_PROVIDERS) {
    if (provider.pages.some((rule) => hostMatches(rule, host) && pathMatches(rule, pathname))) return provider
  }
  return smokeHosts().get(host) ?? null
}

/** The provider whose sign-in page a URL is (https only), or null. */
export function signInProviderFor(url: string): SignInProvider | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol === 'https:') return signInProviderAt(u.hostname, u.pathname)
  if (u.protocol === 'http:') return smokeHosts().get(normalHost(u.hostname)) ?? null
  return null
}

export function isSignInUrl(url: string): boolean {
  return signInProviderFor(url) !== null
}

/** True when any page on this host is a sign-in page (a pack's page scripts stay off such hosts entirely). */
export function hasSignInPages(hostname: string): boolean {
  const host = normalHost(hostname)
  return SIGN_IN_PROVIDERS.some((p) => p.pages.some((rule) => hostMatches(rule, host))) || smokeHosts().has(host)
}

/** True when every page on this host is a sign-in page (a provider that names only some paths there doesn't count). */
export function isSignInHost(hostname: string): boolean {
  const host = normalHost(hostname)
  return SIGN_IN_PROVIDERS.some((p) => p.pages.some((rule) => !rule.paths && hostMatches(rule, host))) || smokeHosts().has(host)
}

// ---- identity overrides ----
// A provider's identity can be switched while Atelier runs (Experiments, through
// src/main/signInIdentity.ts followIdentityExperiments); main is the only reader.

const overrides = new Map<SignInProviderId, SignInIdentity>()

/** Presents `identity` on a provider's sign-in pages instead of the registry's; null goes back to the registry's. */
export function overrideSignInIdentity(id: SignInProviderId, identity: SignInIdentity | null): void {
  if (identity === null) overrides.delete(id)
  else overrides.set(id, identity)
}

/** The identity a provider presents now: its override, else the registry's. */
export function providerIdentity(provider: SignInProvider): SignInIdentity {
  return overrides.get(provider.id) ?? provider.identity
}

/** The identity Atelier presents on a URL: its sign-in provider's, 'chromium' everywhere else. */
export function signInIdentityFor(url: string): SignInIdentity {
  const provider = signInProviderFor(url)
  return provider ? providerIdentity(provider) : 'chromium'
}
