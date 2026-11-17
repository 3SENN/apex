/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// One place that turns settings into the active language, for main
// (setupI18n) and the renderer (I18nProvider) alike: appLanguage resolved
// against the system's preferred list, the region kept for Intl, and en-XA
// when the `pseudo-locale` flag is on (or ATELIER_PSEUDO_LOCALE=1 in main).
import { isFlagOn } from '../flags'
import { currentLanguage, currentLocale, pseudoActive, setLanguage } from './core'
import { regionalTag, resolveAppLanguage, type AppLanguage, type AppLanguageSetting } from './locales'

export const PSEUDO_FLAG = 'pseudo-locale'

export interface LanguageInputs {
  appLanguage?: AppLanguageSetting
  flags?: Record<string, string>
}

export interface LanguageState {
  language: AppLanguage
  /** The Intl tag: 'en-GB', 'nl-BE', or the bare code. */
  locale: string
  pseudo: boolean
}

export function languageState(inputs: LanguageInputs, systemPreferred: readonly string[], forcePseudo = false): LanguageState {
  const language = resolveAppLanguage(inputs.appLanguage, systemPreferred)
  return {
    language,
    locale: regionalTag(language, systemPreferred),
    pseudo: forcePseudo || isFlagOn(inputs.flags ?? {}, PSEUDO_FLAG),
  }
}

/** Applies the language the inputs ask for; true when it changed anything. */
export function applyLanguage(inputs: LanguageInputs, systemPreferred: readonly string[], forcePseudo = false): boolean {
  const next = languageState(inputs, systemPreferred, forcePseudo)
  const before = `${currentLanguage()}|${currentLocale()}|${pseudoActive()}`
  setLanguage(next.language, { locale: next.locale, pseudo: next.pseudo })
  return `${currentLanguage()}|${currentLocale()}|${pseudoActive()}` !== before
}
