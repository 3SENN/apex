/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The string catalogue's core. Every
// user-visible string goes through t() (shared and renderer), useT() (React)
// or mainT (main). It also covers the app language (English or Dutch), the
// en-XA pseudo-locale and the missing-key fallback.
//
// The app's name is never written into a message: messages say {brand}, which
// format() fills in from the branding (Apex, or Summit for the unofficial
// branding; src/shared/branding.ts), like Firefox's -brand-short-name. No call
// site passes it.
import { BRAND_NAME } from '../branding'
import { EN, type MessageKey } from './en'
import { NL } from './nl'
import { pseudoize } from './pseudo'
import type { AppLanguage } from './locales'

export type { MessageKey } from './en'

export type MessageVars = Record<string, string | number>

export type Catalogue = Readonly<Record<MessageKey, string>>

/** A translation: any subset of the English keys (the Dutch catalogue is complete). */
export type PartialCatalogue = Readonly<Partial<Record<MessageKey, string>>>

const CATALOGUES: Record<AppLanguage, PartialCatalogue> = { en: EN, nl: NL }

let active: PartialCatalogue = EN
let language: AppLanguage = 'en'
/** The BCP 47 tag Intl formats with: the app language, with the person's region when the system has one. */
let locale = 'en'
let pseudo = false
const pseudoCache = new Map<string, string>()

const listeners = new Set<() => void>()

function changed(): void {
  pluralRules.clear()
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A listener's failure must not stop the others from relabelling.
    }
  }
}

/** Swaps in a whole catalogue (a seam for tests). Prefer setLanguage(). */
export function setCatalogue(next: PartialCatalogue, nextLocale: string): void {
  active = next
  locale = nextLocale
  changed()
}

/**
 * Switches the active language. `locale` is the Intl tag (defaults to the
 * language code); `pseudo` turns on en-XA, which always transforms English.
 * Listeners run only when something changed.
 */
export function setLanguage(next: AppLanguage, options: { locale?: string; pseudo?: boolean } = {}): void {
  const nextLocale = options.locale ?? next
  const nextPseudo = options.pseudo ?? false
  if (next === language && nextLocale === locale && nextPseudo === pseudo && active === CATALOGUES[next]) return
  language = next
  locale = nextLocale
  pseudo = nextPseudo
  active = CATALOGUES[next]
  changed()
}

/** The active app language ('en' while en-XA is on). */
export function currentLanguage(): AppLanguage {
  return pseudo ? 'en' : language
}

/** The Intl locale tag for dates, numbers and plurals. */
export function currentLocale(): string {
  return pseudo ? 'en' : locale
}

/** Whether the en-XA pseudo-locale is on. */
export function pseudoActive(): boolean {
  return pseudo
}

/** Runs `listener` after every language change; returns the unsubscribe. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ---- missing keys ----

export type MissingKeyReporter = (key: string, language: string) => void

const MISSING_LOG_LIMIT = 100

let reporter: MissingKeyReporter = (key, lang) => {
  if (typeof console !== 'undefined') console.warn(`i18n: "${key}" has no ${lang} text yet; showing English.`)
}
const reported = new Set<string>()

/** Where a missing key is logged, once per key and language: the app log in main, the console in the renderer. */
export function setMissingKeyReporter(next: MissingKeyReporter): void {
  reporter = next
}

function reportMissing(key: string, lang: string): void {
  const id = `${lang}:${key}`
  if (reported.has(id) || reported.size > MISSING_LOG_LIMIT) return
  reported.add(id)
  try {
    if (reported.size > MISSING_LOG_LIMIT) reporter(`(${MISSING_LOG_LIMIT} keys and more)`, lang)
    else reporter(key, lang)
  } catch {
    // Logging a missing string must never break the string itself.
  }
}

/** Test seam: forget which keys were reported. */
export function resetMissingKeyLog(): void {
  reported.clear()
}

// ---- formatting ----

const pluralRules = new Map<string, Intl.PluralRules>()

function pluralCategory(n: number): string {
  const tag = currentLocale()
  let rules = pluralRules.get(tag)
  if (!rules) {
    try {
      rules = new Intl.PluralRules(tag)
    } catch {
      rules = new Intl.PluralRules('en')
    }
    pluralRules.set(tag, rules)
  }
  return rules.select(n)
}

/** Index of the brace that closes the one opened at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** The cases of a plural body, `one {# file} other {# files}`, by selector. */
export function pluralCases(body: string): Map<string, string> {
  const cases = new Map<string, string>()
  let i = 0
  while (i < body.length) {
    const open = body.indexOf('{', i)
    if (open < 0) break
    const end = closing(body, open)
    if (end < 0) break
    cases.set(body.slice(i, open).trim(), body.slice(open + 1, end))
    i = end + 1
  }
  return cases
}

// {count, plural, one {# file} other {# files}}: '=N' exact cases win, then the
// locale's category, then 'other'. '#' becomes the formatted number, and the
// chosen case may hold its own {placeholders}.
function plural(body: string, value: number, vars: MessageVars): string {
  const cases = pluralCases(body)
  const chosen = cases.get(`=${value}`) ?? cases.get(pluralCategory(value)) ?? cases.get('other') ?? ''
  const shown = Number.isFinite(value) ? value.toLocaleString(currentLocale()) : String(value)
  return format(chosen.replace(/#/g, shown), vars)
}

/** The placeholder every message may use for the app's name; format() fills it in. */
export const BRAND_PLACEHOLDER = 'brand'

/**
 * Formats a message: {name} interpolation and {count, plural, …} through
 * Intl.PluralRules, with {brand} as the app's name unless `vars` names it.
 * Unknown vars stay as written.
 */
export function format(message: string, vars?: MessageVars): string {
  if (!message.includes('{')) return message
  return interpolate(message, { [BRAND_PLACEHOLDER]: BRAND_NAME, ...vars })
}

function interpolate(message: string, vars: MessageVars): string {
  let out = ''
  let i = 0
  while (i < message.length) {
    const open = message.indexOf('{', i)
    if (open < 0) {
      out += message.slice(i)
      break
    }
    out += message.slice(i, open)
    const end = closing(message, open)
    if (end < 0) {
      out += message.slice(open)
      break
    }
    const inner = message.slice(open + 1, end)
    const match = /^\s*([A-Za-z0-9_]+)\s*(?:,\s*plural\s*,([\s\S]*))?$/.exec(inner)
    const name = match?.[1]
    const value = name !== undefined ? vars[name] : undefined
    if (!match || value === undefined) out += message.slice(open, end + 1)
    else if (match[2] !== undefined) out += plural(match[2], Number(value), vars)
    else out += String(value)
    i = end + 1
  }
  return out
}

/** The raw message for `key` in the active language: the translation, else English (logged once), else the key. */
export function message(key: MessageKey): string {
  if (pseudo) {
    let cached = pseudoCache.get(key)
    if (cached === undefined) {
      const english = (EN as Readonly<Record<string, string>>)[key]
      if (english === undefined) reportMissing(key, 'en')
      cached = pseudoize(english ?? key)
      pseudoCache.set(key, cached)
    }
    return cached
  }
  const own = active[key]
  if (own !== undefined) return own
  const english = (EN as Readonly<Record<string, string>>)[key]
  reportMissing(key, english === undefined ? 'en' : language)
  return english ?? key
}

/** The message for `key` in the current language, formatted with `vars`. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return format(message(key), vars)
}
