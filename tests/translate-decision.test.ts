/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  TRANSLATE_DEFAULTS,
  TRANSLATE_SETTINGS_SCHEMA,
  decideTranslate,
  hostAndParents,
  languageKey,
  pickEngine,
  sameLanguage,
  siteNeverTranslated,
  toggleListed,
  translateTarget,
  type DecisionInput,
} from '@shared/translate'
import { detectLanguage, hintTag, pageLanguage } from '@shared/translateDetect'
import { SETTINGS } from '@shared/settingsRegistry'

// Page translation's rules (TR-02 to TR-06): language keys, the decision
// table for a page, the engine choice, and the page language from hints and
// the on-device detector.

const base: DecisionInput = { web: true, optOut: false, pageLanguage: 'fr', languages: ['en-US', 'nl'], settings: TRANSLATE_DEFAULTS, host: 'www.lemonde.fr' }
const decide = (patch: Partial<DecisionInput>, settings: Partial<typeof TRANSLATE_DEFAULTS> = {}) => decideTranslate({ ...base, ...patch, settings: { ...TRANSLATE_DEFAULTS, ...settings } })

describe('language keys', () => {
  it('compares base languages, Chinese by script, old codes by their new ones', () => {
    expect(languageKey('fr-CA')).toBe('fr')
    expect(languageKey('EN_gb')).toBe('en')
    expect(languageKey('zh-TW')).toBe('zh-Hant')
    expect(languageKey('zh-Hant-HK')).toBe('zh-Hant')
    expect(languageKey('zh')).toBe('zh-Hans')
    expect(languageKey('zh-CN')).toBe('zh-Hans')
    expect(languageKey('iw')).toBe('he')
    expect(languageKey('no')).toBe('nb')
    expect(languageKey('und')).toBeNull()
    expect(languageKey('not a tag')).toBeNull()
    expect(languageKey(null)).toBeNull()
    expect(sameLanguage('pt-BR', 'pt-PT')).toBe(true)
    expect(sameLanguage('zh-CN', 'zh-TW')).toBe(false)
  })

  it('targets the chosen language, else the first of yours', () => {
    expect(translateTarget({ target: null }, ['nl-BE', 'en'])).toBe('nl')
    expect(translateTarget({ target: 'de' }, ['nl'])).toBe('de')
    expect(translateTarget({ target: null }, [])).toBe('en')
  })
})

describe('the decision table (TR-02)', () => {
  it.each([
    ['a French page for an English reader', {}, {}, 'offer'],
    ['not a web page', { web: false }, {}, 'none:not-web'],
    ['the page opts out', { optOut: true }, {}, 'none:opt-out'],
    ['no language known', { pageLanguage: null }, {}, 'none:unknown-language'],
    ['one of your languages (another region)', { pageLanguage: 'en-GB' }, {}, 'none:your-language'],
    ['your second language', { pageLanguage: 'nl-BE' }, {}, 'none:your-language'],
    ['the target language', { pageLanguage: 'de' }, { target: 'de' }, 'none:your-language'],
    ['a site you said never to', {}, { neverSites: ['lemonde.fr'] }, 'none:never-site'],
    ['a language you said never to', {}, { never: ['fr'] }, 'none:never-language'],
    ['a language you always translate', {}, { always: ['fr'] }, 'auto'],
    ['always beats offers off', {}, { always: ['fr'], offer: false }, 'auto'],
    ['never-site beats always', {}, { always: ['fr'], neverSites: ['www.lemonde.fr'] }, 'none:never-site'],
    ['offers off', {}, { offer: false }, 'none:offers-off'],
    ['traditional Chinese for a simplified reader', { pageLanguage: 'zh-TW', languages: ['zh-CN'] }, {}, 'offer'],
  ] as const)('%s', (_name, patch, settings, expected) => {
    const d = decide(patch as Partial<DecisionInput>, settings as Partial<typeof TRANSLATE_DEFAULTS>)
    expect(d.kind === 'none' ? `none:${d.reason}` : d.kind).toBe(expected)
  })

  it('matches a site and the sites above it, never a bare suffix', () => {
    expect(hostAndParents('news.example.co.uk')).toEqual(['news.example.co.uk', 'example.co.uk', 'co.uk'])
    expect(hostAndParents('localhost')).toEqual(['localhost'])
    expect(siteNeverTranslated(['example.fr'], 'www.example.fr')).toBe(true)
    expect(siteNeverTranslated(['fr'], 'www.example.fr')).toBe(false)
    expect(siteNeverTranslated(['Example.FR'], 'example.fr')).toBe(true)
    expect(siteNeverTranslated([], null)).toBe(false)
  })

  it('toggles list entries once, case-insensitively', () => {
    expect(toggleListed(['fr'], 'de', true)).toEqual(['fr', 'de'])
    expect(toggleListed(['fr', 'de'], 'FR', true)).toEqual(['de', 'FR'])
    expect(toggleListed(['fr', 'de'], 'fr', false)).toEqual(['de'])
  })
})

describe('the engine (TR-05, TR-06)', () => {
  it('uses Apple when the pair is downloaded, the companion only when allowed', () => {
    expect(pickEngine('installed', false)).toEqual({ engine: 'apple' })
    expect(pickEngine('installed', true)).toEqual({ engine: 'apple' })
    expect(pickEngine('supported', false)).toEqual({ error: 'not-installed' })
    expect(pickEngine('unsupported', false)).toEqual({ error: 'unsupported' })
    expect(pickEngine('unavailable', false)).toEqual({ error: 'unavailable' })
    expect(pickEngine('supported', true)).toEqual({ engine: 'companion' })
    expect(pickEngine('unavailable', true)).toEqual({ engine: 'companion' })
  })
})

describe('settings', () => {
  it('registers translate per profile with valid defaults, companion off', () => {
    expect(SETTINGS.translate.scope).toBe('profile')
    expect(SETTINGS.translate.default).toEqual(TRANSLATE_DEFAULTS)
    expect(TRANSLATE_DEFAULTS.companion).toBe(false)
    expect(TRANSLATE_SETTINGS_SCHEMA.safeParse({ ...TRANSLATE_DEFAULTS, always: ['not a tag'] }).success).toBe(false)
  })
})

const FRENCH = 'Le gouvernement a annoncé mardi une série de mesures pour soutenir les familles et les entreprises. Les syndicats ont salué une avancée, mais ils demandent plus de moyens pour les services publics dans les régions.'
const ENGLISH = 'The government announced a series of measures on Tuesday to support families and businesses. The unions welcomed the progress, but they want more resources for public services in the regions.'
const GERMAN = 'Die Regierung hat am Dienstag eine Reihe von Maßnahmen angekündigt, um Familien und Unternehmen zu unterstützen. Die Gewerkschaften begrüßten den Fortschritt, aber sie fordern mehr Mittel für die öffentlichen Dienste.'
const DUTCH = 'De regering heeft dinsdag een reeks maatregelen aangekondigd om gezinnen en bedrijven te steunen. De vakbonden zijn blij met de vooruitgang, maar ze willen meer geld voor de publieke diensten in de regio.'
const SPANISH = 'El gobierno anunció el martes una serie de medidas para apoyar a las familias y a las empresas. Los sindicatos celebraron el avance, pero piden más recursos para los servicios públicos en las regiones.'

describe('detecting the page language (TR-02)', () => {
  it.each([
    [FRENCH, 'fr'],
    [ENGLISH, 'en'],
    [GERMAN, 'de'],
    [DUTCH, 'nl'],
    [SPANISH, 'es'],
    ['東京は日本の首都です。ここには多くの人が住んでいて、毎日たくさんの観光客が訪れます。', 'ja'],
    ['서울은 대한민국의 수도이며 많은 사람들이 살고 있습니다. 매일 많은 관광객이 방문합니다.', 'ko'],
    ['Москва является столицей России, и здесь живёт много людей. Каждый день город посещают туристы.', 'ru'],
    ['Київ є столицею України, і тут живе багато людей. Щодня місто відвідують туристи з усього світу.', 'uk'],
    ['这是一个关于我们国家的网页，这里有很多问题和发展，现在我们说时间的事情。这些问题对我们很重要。', 'zh-CN'],
    ['這是一個關於我們國家的網頁，這裡有很多問題和發展，現在我們說時間的事情。這些問題對我們很重要。', 'zh-TW'],
    ['Η Αθήνα είναι η πρωτεύουσα της Ελλάδας και εδώ ζουν πολλοί άνθρωποι κάθε μέρα.', 'el'],
  ])('%s → %s', (text, language) => {
    const d = detectLanguage(text)
    expect(d.language).toBe(language)
    expect(d.reliable).toBe(true)
  })

  it('says nothing about too little text', () => {
    expect(detectLanguage('OK')).toEqual({ language: null, confidence: 0, reliable: false })
    expect(detectLanguage('Bonjour à tous').reliable).toBe(false)
  })

  it('reads hint tags', () => {
    expect(hintTag('fr_FR')).toBe('fr-FR')
    expect(hintTag('de, en')).toBe('de')
    expect(hintTag('')).toBeNull()
    expect(hintTag('x')).toBeNull()
  })

  it('trusts the page unless the detector is sure of another language', () => {
    const sure = detectLanguage(FRENCH)
    const unsure = detectLanguage('Bonjour')
    expect(pageLanguage({ declared: 'fr-FR', contentLanguage: null, ogLocale: null }, sure)).toBe('fr-FR')
    expect(pageLanguage({ declared: 'en', contentLanguage: null, ogLocale: null }, sure)).toBe('fr')
    expect(pageLanguage({ declared: 'en', contentLanguage: null, ogLocale: null }, unsure)).toBe('en')
    expect(pageLanguage({ declared: null, contentLanguage: 'de', ogLocale: 'fr_FR' }, unsure)).toBe('de')
    expect(pageLanguage({ declared: null, contentLanguage: null, ogLocale: 'pt_BR' }, unsure)).toBe('pt-BR')
    expect(pageLanguage({ declared: null, contentLanguage: null, ogLocale: null }, sure)).toBe('fr')
    expect(pageLanguage({ declared: null, contentLanguage: null, ogLocale: null }, unsure)).toBeNull()
  })
})
