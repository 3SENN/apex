/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { AVAILABLE, chromiumLang, isAppLanguageSetting, needsRestart, negotiate, primarySubtag, regionalTag, resolveAppLanguage, withAppLanguageFirst } from '@shared/i18n/locales'

// Picking the app language from the system's list, the Intl tag, the
// Chromium switch and Accept-Language when website languages follow the system.

describe('app languages', () => {
  it('offers English first, then Dutch', () => {
    expect(AVAILABLE).toEqual(['en', 'nl'])
    expect(isAppLanguageSetting('system')).toBe(true)
    expect(isAppLanguageSetting('nl')).toBe(true)
    expect(isAppLanguageSetting('de')).toBe(false)
    expect(isAppLanguageSetting(undefined)).toBe(false)
  })

  it('reads primary subtags loosely', () => {
    expect(primarySubtag('nl-BE')).toBe('nl')
    expect(primarySubtag('en_GB')).toBe('en')
    expect(primarySubtag('NL')).toBe('nl')
    expect(primarySubtag('')).toBe('')
    expect(primarySubtag('*')).toBe('')
  })

  it('negotiates the first preferred language Apex has', () => {
    expect(negotiate(['nl-NL', 'en-US'])).toBe('nl')
    expect(negotiate(['de-DE', 'nl-BE', 'en'])).toBe('nl')
    expect(negotiate(['fr-FR', 'en-GB', 'nl'])).toBe('en')
    expect(negotiate(['de', 'fr'])).toBe('en')
    expect(negotiate([])).toBe('en')
    expect(negotiate(['pt-BR', 'es'], ['es', 'pt'] as const)).toBe('pt')
  })

  it('resolves the setting, with system going through the preferred list', () => {
    expect(resolveAppLanguage('system', ['nl-NL'])).toBe('nl')
    expect(resolveAppLanguage('system', ['ja-JP'])).toBe('en')
    expect(resolveAppLanguage('en', ['nl-NL'])).toBe('en')
    expect(resolveAppLanguage('nl', [])).toBe('nl')
    expect(resolveAppLanguage(undefined, ['nl'])).toBe('nl')
  })

  it('keeps the person’s region for Intl', () => {
    expect(regionalTag('en', ['nl-NL', 'en-GB'])).toBe('en-GB')
    expect(regionalTag('nl', ['nl_BE'])).toBe('nl-BE')
    expect(regionalTag('nl', ['en-US'])).toBe('nl')
  })

  it('maps to the Chromium lang switch', () => {
    expect(chromiumLang('nl', ['nl-BE'])).toBe('nl')
    expect(chromiumLang('en', ['en-GB'])).toBe('en-GB')
    expect(chromiumLang('en', ['en-AU'])).toBe('en-GB')
    expect(chromiumLang('en', ['en-US'])).toBe('en-US')
    expect(chromiumLang('en', ['de-DE'])).toBe('en-US')
  })

  it('puts the app language first for Accept-Language', () => {
    expect(withAppLanguageFirst(['de-DE', 'nl-NL', 'en'], 'nl')).toEqual(['nl-NL', 'de-DE', 'en'])
    expect(withAppLanguageFirst(['de-DE', 'fr'], 'nl')).toEqual(['nl', 'de-DE', 'fr'])
    expect(withAppLanguageFirst(['en-GB', 'nl'], 'en')).toEqual(['en-GB', 'nl'])
  })

  it('asks for a restart only when the resolved language differs from the launch', () => {
    expect(needsRestart('nl', ['en-US'], 'en')).toBe(true)
    expect(needsRestart('en', ['en-US'], 'en')).toBe(false)
    expect(needsRestart('system', ['nl-NL'], 'nl')).toBe(false)
    expect(needsRestart('system', ['nl-NL'], 'en')).toBe(true)
  })
})
