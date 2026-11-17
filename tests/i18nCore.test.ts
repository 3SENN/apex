/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyLanguage, languageState } from '@shared/i18n/apply'
import { currentLanguage, currentLocale, message, onLanguageChange, pseudoActive, resetMissingKeyLog, setLanguage, setMissingKeyReporter, t, type MessageKey } from '@shared/i18n/core'
import { EN } from '@shared/i18n/en'
import { NL } from '@shared/i18n/nl'

// The active language, the English fallback logged once, live listeners,
// the pseudo-locale through t(), and settings → language.

afterEach(() => {
  setLanguage('en')
  resetMissingKeyLog()
  setMissingKeyReporter(() => undefined)
})

function missingInDutch(): MessageKey | null {
  for (const key of Object.keys(EN) as MessageKey[]) if (NL[key] === undefined) return key
  return null
}

describe('i18n core', () => {
  it('switches languages and tells listeners', () => {
    const seen: string[] = []
    const off = onLanguageChange(() => seen.push(currentLanguage()))
    setLanguage('nl', { locale: 'nl-BE' })
    expect(t('menus.top.file')).toBe('Archief')
    expect(currentLocale()).toBe('nl-BE')
    setLanguage('nl', { locale: 'nl-BE' })
    setLanguage('en')
    expect(t('menus.top.file')).toBe('File')
    off()
    setLanguage('nl')
    expect(seen).toEqual(['nl', 'en'])
  })

  it('uses Dutch plural rules and interpolation', () => {
    setLanguage('nl')
    expect(t('core.closeWindow.detail', { count: 1 })).toBe('Er is 1 tabblad open.')
    expect(t('core.closeWindow.detail', { count: 4 })).toBe('Er zijn 4 tabbladen open.')
    expect(t('menus.app.quit', { name: 'Apex' })).toBe('Stop Apex')
  })

  it('falls back to English for a missing key and logs it once', () => {
    const key = missingInDutch()
    if (!key) return
    const reporter = vi.fn()
    setMissingKeyReporter(reporter)
    setLanguage('nl')
    expect(message(key)).toBe(EN[key])
    expect(message(key)).toBe(EN[key])
    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter).toHaveBeenCalledWith(key, 'nl')
  })

  it('returns an unknown key as itself, logged as missing English', () => {
    const reporter = vi.fn()
    setMissingKeyReporter(reporter)
    expect(t('nope.not.there' as MessageKey)).toBe('nope.not.there')
    expect(reporter).toHaveBeenCalledWith('nope.not.there', 'en')
  })

  it('a throwing reporter never breaks the string', () => {
    setMissingKeyReporter(() => {
      throw new Error('log is down')
    })
    expect(t('nope.also' as MessageKey)).toBe('nope.also')
  })

  it('pseudo-locale transforms English whatever the language', () => {
    setLanguage('nl', { pseudo: true })
    expect(pseudoActive()).toBe(true)
    expect(currentLanguage()).toBe('en')
    expect(t('menus.top.file')).toMatch(/^\[Ƒíļé .+\]$/)
    expect(t('core.closeWindow.detail', { count: 2 })).toMatch(/^\[2 ţáƀš/)
  })

  it('turns settings into a language', () => {
    expect(languageState({ appLanguage: 'system' }, ['nl-BE', 'en'])).toEqual({ language: 'nl', locale: 'nl-BE', pseudo: false })
    expect(languageState({ appLanguage: 'en', flags: { 'pseudo-locale': 'on' } }, ['en-GB'])).toEqual({ language: 'en', locale: 'en-GB', pseudo: true })
    expect(languageState({}, ['de-DE'], true)).toEqual({ language: 'en', locale: 'en', pseudo: true })
    expect(applyLanguage({ appLanguage: 'nl' }, [])).toBe(true)
    expect(applyLanguage({ appLanguage: 'nl' }, [])).toBe(false)
    expect(currentLanguage()).toBe('nl')
  })
})
