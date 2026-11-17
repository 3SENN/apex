/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apex's browser identity (sign-in compatibility): the User-Agent string and
// the User-Agent Client Hints exactly as stock Chromium of the same version
// reports them on this platform, so a site sees one ordinary Chromium
// everywhere. app.userAgentFallback, every session (languages.ts), the
// per-tab DevTools override (TabLanguages) and the client hint headers
// Electron leaves out (clientHints.ts) all read this one module.
// Nothing here is Chrome-branded beyond what Chromium itself sends: the brands
// are Chromium's own list (Chromium plus its GREASE brand), never Electron or Apex.

export interface Brand {
  brand: string
  version: string
}

/** What navigator.userAgentData reports, with the reduced User-Agent string. */
export interface BrowserIdentity {
  userAgent: string
  brands: Brand[]
  fullVersionList: Brand[]
  /** The full Chromium version, e.g. 156.0.8078.49. */
  fullVersion: string
  /** 'macOS', 'Windows' or 'Linux'. */
  platform: string
  /** '' when Chromium's value can't be derived here (then the header is left out). */
  platformVersion: string
  architecture: string
  bitness: string
  model: string
  mobile: boolean
  wow64: boolean
  formFactors: string[]
}

export interface IdentityInput {
  /** process.versions.chrome */
  chrome: string
  platform: NodeJS.Platform
  arch: string
  /** process.getSystemVersion() (macOS: 26.6.2). */
  systemVersion: string
}

/** Chromium's reduced User-Agent platform tokens (frozen per platform). */
const UA_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
}

const CH_PLATFORM: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export function chromeMajor(chrome: string): number {
  const major = Number.parseInt(chrome.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major > 0 ? major : 0
}

/** The reduced UA Chromium sends: the major version only, with the frozen platform token. */
export function reducedUserAgent(chrome: string, platform: NodeJS.Platform): string {
  return `Mozilla/5.0 (${UA_PLATFORM[platform] ?? UA_PLATFORM.linux}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor(chrome)}.0.0.0 Safari/537.36`
}

/** Chromium's GREASE brand for a major version (components/embedder_support/user_agent_utils.cc). */
export function greaseBrand(major: number, full = false): Brand {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
  const versions = ['8', '99', '24']
  const version = versions[major % versions.length] ?? '8'
  return { brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`, version: full ? `${version}.0.0.0` : version }
}

/** Chromium's brand list without a product brand: GREASE and Chromium, ordered by the major version. */
export function brandList(chrome: string, full = false): Brand[] {
  const major = chromeMajor(chrome)
  const list: Brand[] = []
  list[major % 2] = greaseBrand(major, full)
  list[(major + 1) % 2] = { brand: 'Chromium', version: full ? chrome : String(major) }
  return list
}

/** Chromium's platformVersion: macOS as major.minor.patch; others aren't derivable here. */
function platformVersion(platform: NodeJS.Platform, systemVersion: string): string {
  if (platform !== 'darwin') return ''
  const parts = systemVersion.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return ''
  while (parts.length < 3) parts.push(0)
  return parts.slice(0, 3).join('.')
}

export function browserIdentity(input: IdentityInput): BrowserIdentity {
  const arm = input.arch === 'arm64' || input.arch === 'arm'
  return {
    userAgent: reducedUserAgent(input.chrome, input.platform),
    brands: brandList(input.chrome),
    fullVersionList: brandList(input.chrome, true),
    fullVersion: input.chrome,
    platform: CH_PLATFORM[input.platform] ?? 'Unknown',
    platformVersion: platformVersion(input.platform, input.systemVersion),
    architecture: arm ? 'arm' : 'x86',
    bitness: input.arch === 'ia32' || input.arch === 'arm' ? '32' : '64',
    model: '',
    mobile: false,
    wow64: false,
    formFactors: ['Desktop'],
  }
}

let current: BrowserIdentity | null = null

/** This process's identity (Chromium's version, this platform and CPU). */
export function identity(): BrowserIdentity {
  current ??= browserIdentity({
    chrome: process.versions.chrome ?? '0.0.0.0',
    platform: process.platform,
    arch: process.arch,
    systemVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
  })
  return current
}

/** The User-Agent every session, tab, worker and popup sends. */
export function browserUserAgent(): string {
  return identity().userAgent
}

/** Emulation.setUserAgentOverride's userAgentMetadata: keeps the client hints when a tab carries a DevTools override. */
export function userAgentMetadata(id: BrowserIdentity = identity()): Record<string, unknown> {
  return {
    brands: id.brands,
    fullVersionList: id.fullVersionList,
    fullVersion: id.fullVersion,
    platform: id.platform,
    platformVersion: id.platformVersion,
    architecture: id.architecture,
    model: id.model,
    mobile: id.mobile,
    bitness: id.bitness,
    wow64: id.wow64,
    formFactors: id.formFactors,
  }
}

// ---- client hint header values (structured fields, as Chromium writes them) ----

const quote = (s: string): string => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`
const brandsValue = (list: Brand[]): string => list.map((b) => `${quote(b.brand)};v=${quote(b.version)}`).join(', ')

/** The three hints Chromium sends on every request to a secure origin. */
export function lowEntropyHints(id: BrowserIdentity = identity()): Record<string, string> {
  return {
    'sec-ch-ua': brandsValue(id.brands),
    'sec-ch-ua-mobile': id.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': quote(id.platform),
  }
}

/** The high-entropy hints a site can ask for with Accept-CH. */
export const HIGH_ENTROPY_HINTS = [
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-full-version',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-wow64',
  'sec-ch-ua-form-factors',
] as const

export type HighEntropyHint = (typeof HIGH_ENTROPY_HINTS)[number]

/** One high-entropy hint's header value; null when there is nothing true to send. */
export function highEntropyHint(hint: HighEntropyHint, id: BrowserIdentity = identity()): string | null {
  switch (hint) {
    case 'sec-ch-ua-full-version-list':
      return brandsValue(id.fullVersionList)
    case 'sec-ch-ua-full-version':
      return quote(id.fullVersion)
    case 'sec-ch-ua-platform-version':
      return id.platformVersion ? quote(id.platformVersion) : null
    case 'sec-ch-ua-arch':
      return quote(id.architecture)
    case 'sec-ch-ua-bitness':
      return quote(id.bitness)
    case 'sec-ch-ua-model':
      return quote(id.model)
    case 'sec-ch-ua-wow64':
      return id.wow64 ? '?1' : '?0'
    case 'sec-ch-ua-form-factors':
      return id.formFactors.map(quote).join(', ')
  }
}
