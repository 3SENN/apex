/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getDomain } from 'tldts'
import { POPULAR_DOMAINS } from './data/popular-domains'

// How Atelier shows a site's name: the host without www, its
// registrable domain (public suffix list via tldts) for highlighting, and
// lookalike protection. An internationalised host shows in its own script
// unless a label mixes scripts or its letters only resemble a popular
// domain; then the raw punycode shows and the host is flagged. Site info
// reads the same result.

export interface DisplayHost {
  /** The host as the URL parser gives it (ASCII, punycode for IDN), without brackets. */
  host: string
  /** The registrable domain of `host` (example.co.uk), or the host itself for IPs and single labels. */
  registrable: string
  /** Some label is punycode (xn--). */
  punycodeWarning: boolean
  /** What to show: Unicode when safe, punycode when not; without a leading www. */
  display: string
  /** [start, end) of the registrable domain inside `display`, for highlighting. */
  registrableRange: [number, number]
  /** Mixed scripts, or confusable with a popular domain: show `display` as is and warn. */
  lookalike: boolean
  /** The popular domain it resembles, when that is why it was flagged. */
  lookalikeOf: string | null
}

const EMPTY: DisplayHost = { host: '', registrable: '', punycodeWarning: false, display: '', registrableRange: [0, 0], lookalike: false, lookalikeOf: null }

export function displayHost(url: string): DisplayHost {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return EMPTY
  }
  return describeHost(host)
}

/** displayHost for a bare hostname. */
export function describeHost(hostname: string): DisplayHost {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!bare) return EMPTY
  const registrable = getDomain(bare, { allowPrivateDomains: true }) ?? bare
  const labels = bare.split('.')
  const punycode = labels.some((label) => label.startsWith('xn--'))
  const unicodeLabels = labels.map((label) => (label.startsWith('xn--') ? (decodePunycodeLabel(label.slice(4)) ?? label) : label))
  const mixed = unicodeLabels.some((label) => mixesScripts(label))
  const resembles = lookalikeOf(registrable)
  const lookalike = mixed || resembles !== null
  // Unicode only when nothing about it is suspicious; otherwise the raw form.
  const shownLabels = punycode && !lookalike ? unicodeLabels : labels
  const withoutWww = shownLabels[0] === 'www' && shownLabels.length > 2 ? shownLabels.slice(1) : shownLabels
  const display = withoutWww.join('.')
  const regLabels = registrable.split('.').length
  const regStart = withoutWww.length > regLabels ? withoutWww.slice(0, withoutWww.length - regLabels).join('.').length + 1 : 0
  return { host: bare, registrable, punycodeWarning: punycode, display, registrableRange: [regStart, display.length], lookalike, lookalikeOf: resembles }
}

/** Shortens long text in the middle: "very-long-sub…example.com". */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max || max < 5) return text
  const keep = max - 1
  const tail = Math.ceil(keep / 2)
  return `${text.slice(0, keep - tail)}…${text.slice(text.length - tail)}`
}

// ---- lookalikes ----

// Letters from other scripts (and a few Latin ones) that read as ASCII.
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', і: 'i', ї: 'i', ј: 'j',
  ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w', һ: 'h', ү: 'y', ь: 'b', ɡ: 'g', ո: 'n', ս: 'u', օ: 'o', զ: 'q',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  ı: 'i', ɩ: 'i', ł: 'l', ƚ: 'l', ɑ: 'a', ǝ: 'e', ꞵ: 'b',
  '0': 'o', '1': 'l',
}

/** A comparison form: accents dropped, confusable letters folded, rn as m and vv as w. */
export function skeleton(text: string): string {
  const folded = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
  let out = ''
  for (const ch of folded) out += CONFUSABLES[ch] ?? ch
  return out.replace(/rn/g, 'm').replace(/vv/g, 'w')
}

const POPULAR_SKELETONS = new Map(POPULAR_DOMAINS.map((d) => [skeleton(d), d]))
const POPULAR_SET = new Set(POPULAR_DOMAINS)

/** The popular domain a registrable domain only resembles, or null (itself, or nothing like one). */
export function lookalikeOf(registrable: string): string | null {
  const ascii = registrable.toLowerCase()
  if (POPULAR_SET.has(ascii)) return null
  const unicode = ascii
    .split('.')
    .map((label) => (label.startsWith('xn--') ? (decodePunycodeLabel(label.slice(4)) ?? label) : label))
    .join('.')
  const match = POPULAR_SKELETONS.get(skeleton(unicode))
  return match && match !== ascii ? match : null
}

type Script = 'latin' | 'cyrillic' | 'greek' | 'armenian' | 'hebrew' | 'arabic' | 'han' | 'kana' | 'hangul' | 'thai' | 'devanagari' | 'georgian' | 'other'

function scriptOf(code: number): Script | null {
  if ((code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f) return null
  if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0xc0 && code <= 0x24f) || (code >= 0x1e00 && code <= 0x1eff)) return 'latin'
  if (code >= 0x400 && code <= 0x52f) return 'cyrillic'
  if ((code >= 0x370 && code <= 0x3ff) || (code >= 0x1f00 && code <= 0x1fff)) return 'greek'
  if (code >= 0x530 && code <= 0x58f) return 'armenian'
  if (code >= 0x590 && code <= 0x5ff) return 'hebrew'
  if (code >= 0x600 && code <= 0x6ff) return 'arabic'
  if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) return 'han'
  if ((code >= 0x3040 && code <= 0x30ff) || code === 0x30fc) return 'kana'
  if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) return 'hangul'
  if (code >= 0xe00 && code <= 0xe7f) return 'thai'
  if (code >= 0x900 && code <= 0x97f) return 'devanagari'
  if (code >= 0x10a0 && code <= 0x10ff) return 'georgian'
  return 'other'
}

// East Asian names legitimately combine these scripts (with Latin).
const ALLOWED_MIXES: readonly (readonly Script[])[] = [
  ['latin', 'han', 'kana'],
  ['latin', 'han', 'hangul'],
]

/** A label whose letters come from scripts that don't belong together (Latin with Cyrillic, say). */
export function mixesScripts(label: string): boolean {
  const scripts = new Set<Script>()
  for (const ch of label) {
    const script = scriptOf(ch.codePointAt(0) ?? 0)
    if (script) scripts.add(script)
  }
  if (scripts.size <= 1) return false
  return !ALLOWED_MIXES.some((allowed) => [...scripts].every((s) => allowed.includes(s)))
}

// ---- punycode (RFC 3492), decoding only ----

const BASE = 36
const TMIN = 1
const TMAX = 26
const SKEW = 38
const DAMP = 700

function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1
  d += Math.floor(d / points)
  let k = 0
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN))
    k += BASE
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW))
}

function digitOf(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22
  if (code >= 0x41 && code <= 0x5a) return code - 0x41
  if (code >= 0x61 && code <= 0x7a) return code - 0x61
  return BASE
}

/** Decodes the part after "xn--"; null when it isn't valid punycode. */
export function decodePunycodeLabel(input: string): string | null {
  const output: number[] = []
  const basic = Math.max(0, input.lastIndexOf('-'))
  for (let j = 0; j < basic; j++) {
    const code = input.charCodeAt(j)
    if (code >= 0x80) return null
    output.push(code)
  }
  let n = 128
  let bias = 72
  let i = 0
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const old = i
    let w = 1
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null
      const digit = digitOf(input.charCodeAt(index++))
      if (digit >= BASE) return null
      i += digit * w
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias
      if (digit < t) break
      w *= BASE - t
      if (w > 0x7fffffff) return null
    }
    const count = output.length + 1
    bias = adapt(i - old, count, old === 0)
    n += Math.floor(i / count)
    i %= count
    if (n > 0x10ffff) return null
    output.splice(i, 0, n)
    i++
  }
  try {
    return String.fromCodePoint(...output)
  } catch {
    return null
  }
}
