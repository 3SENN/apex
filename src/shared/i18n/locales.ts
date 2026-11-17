/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The app languages (ST-27). Names are endonyms, so they are not catalogued.
// settings.appLanguage is 'system' | AppLanguage; 'system' resolves through
// app.getPreferredSystemLanguages() (main) and negotiate(). The pseudo-locale
// en-XA is a test language, never offered in the select.

export type AppLanguage = 'en' | 'nl'

export type AppLanguageSetting = 'system' | AppLanguage

export const AVAILABLE_LANGUAGES: ReadonlyArray<{ code: AppLanguage; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'nl', name: 'Nederlands' },
]

/** The language codes Apex has a catalogue for, English first (the fallback). */
export const AVAILABLE: readonly AppLanguage[] = AVAILABLE_LANGUAGES.map((l) => l.code)

/** The accented, longer test language for truncation shots (the `pseudo-locale` flag, or APEX_PSEUDO_LOCALE=1). */
export const PSEUDO_LOCALE = 'en-XA'

/**
 * When true, Dutch must cover every key and a hard-coded JSX string
 * fails tests/noHardcodedStrings.test.ts.
 */
export const SWEEP_COMPLETE = true

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (AVAILABLE as readonly string[]).includes(value)
}

export function isAppLanguageSetting(value: unknown): value is AppLanguageSetting {
  return value === 'system' || isAppLanguage(value)
}

/** The primary subtag of a locale tag, lower-cased: 'nl-BE' → 'nl', 'en_GB' → 'en'. Empty for junk. */
export function primarySubtag(tag: string): string {
  const match = /^\s*([A-Za-z]{2,3})(?:[-_]|$)/.exec(tag)
  return match?.[1]?.toLowerCase() ?? ''
}

/**
 * The best available language for an ordered preference list: the first
 * preferred tag whose primary subtag Apex has. Exact tags are not needed
 * (nl-BE and nl-NL both get Dutch). Nothing matching falls back to the first
 * available language, English.
 */
export function negotiate<L extends string = AppLanguage>(preferred: readonly string[], available: readonly L[] = AVAILABLE as unknown as readonly L[]): L {
  for (const tag of preferred) {
    const primary = primarySubtag(tag)
    const hit = available.find((code) => primarySubtag(code) === primary)
    if (hit) return hit
  }
  return available[0] as L
}

/** The language a setting means, given the system's preferred list. */
export function resolveAppLanguage(setting: AppLanguageSetting | undefined, systemPreferred: readonly string[]): AppLanguage {
  return isAppLanguage(setting) ? setting : negotiate(systemPreferred)
}

/** The system tag that picked `language`, so Intl keeps the person's region (en-GB dates); else the bare code. */
export function regionalTag(language: AppLanguage, systemPreferred: readonly string[]): string {
  const tag = systemPreferred.find((t) => primarySubtag(t) === language)
  if (!tag) return language
  try {
    return Intl.getCanonicalLocales(tag.replace(/_/g, '-'))[0] ?? language
  } catch {
    return language
  }
}

// Chromium ships en-GB and en-US paks for English; the other British-style
// regions read best with en-GB.
const EN_GB_REGIONS = new Set(['GB', 'IE', 'AU', 'NZ', 'IN', 'ZA', 'SG', 'HK', 'MT'])

/** The Chromium `lang` switch for an app language: context menus and the spellcheck UI follow it. */
export function chromiumLang(language: AppLanguage, systemPreferred: readonly string[]): string {
  if (language === 'nl') return 'nl'
  const tag = regionalTag('en', systemPreferred)
  const region = /^en-(?:[A-Za-z]{4}-)?([A-Za-z]{2})\b/.exec(tag)?.[1]?.toUpperCase()
  return region && EN_GB_REGIONS.has(region) ? 'en-GB' : 'en-US'
}

/**
 * Website languages that follow the system (ST-32) put the app language
 * first, so Accept-Language matches the language Apex speaks: the system's
 * own tag for it when there is one, then the rest in the system's order.
 */
export function withAppLanguageFirst(list: readonly string[], language: AppLanguage): string[] {
  const own = list.filter((t) => primarySubtag(t) === language)
  const lead = own.length > 0 ? own : [language]
  return [...lead, ...list.filter((t) => primarySubtag(t) !== language)]
}

/**
 * Whether a setting needs a restart before every part of Apex speaks it:
 * Chromium's context menus and spellcheck UI keep the language they launched
 * in (`launched`), the chrome and main switch at once.
 */
export function needsRestart(setting: AppLanguageSetting, systemPreferred: readonly string[], launched: AppLanguage): boolean {
  return resolveAppLanguage(setting, systemPreferred) !== launched
}
