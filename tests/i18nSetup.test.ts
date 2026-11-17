/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Localization in main: early.ts's settings.json read and lang switch, and setupI18n's
// live switch, menu rebuild, missing-key log and ATELIER_PSEUDO_LOCALE marker.

const appended: Array<[string, string]> = []
vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: () => ['en-GB'],
    getPath: () => join(tmpdir(), 'atelier-i18n-none'),
    commandLine: { appendSwitch: (name: string, value: string) => appended.push([name, value]) },
  },
}))
const logged: Array<[string, string]> = []
vi.mock('../src/main/log', () => ({
  log: {
    info: (_s: string, m: string) => logged.push(['info', m]),
    warn: (_s: string, m: string) => logged.push(['warn', m]),
    error: (_s: string, m: string) => logged.push(['error', m]),
    debug: () => undefined,
  },
}))
const applied: string[][] = []
vi.mock('../src/main/languages', () => ({
  systemLanguages: () => ['nl-NL'],
  languagesFor: (s: { languages: { mode: string; list: string[] } }) => (s.languages.mode === 'custom' ? s.languages.list : ['de-DE', 'nl-NL', 'en-GB']),
  applySessionLanguages: (_session: unknown, list: string[]) => applied.push(list),
}))

const { bootLanguage, readAppLanguageSetting } = await import('../src/main/i18n/early')
const { setupI18n } = await import('../src/main/i18n/setup')
const { mainT } = await import('../src/main/i18n/mainT')
const { followingLanguages, i18nFeature } = await import('../src/main/features/i18n')
const core = await import('@shared/i18n/core')
const { EN } = await import('@shared/i18n/en')
const { NL } = await import('@shared/i18n/nl')
type MessageKey = import('@shared/i18n/core').MessageKey

type S = { appLanguage: 'system' | 'en' | 'nl'; flags: Record<string, string> }

class FakeSettings extends EventEmitter {
  value: S
  constructor(initial: Partial<S> = {}) {
    super()
    this.value = { appLanguage: 'system', flags: {}, ...initial }
  }
  get(): S {
    return this.value
  }
  update(patch: Partial<S>): S {
    const previous = this.value
    this.value = { ...previous, ...patch }
    this.emit('changed', this.value, previous)
    return this.value
  }
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'atelier-i18n-'))
}

beforeEach(() => {
  appended.length = 0
  logged.length = 0
})
afterEach(() => {
  core.setLanguage('en')
  core.resetMissingKeyLog()
})

describe('early language boot', () => {
  it('reads appLanguage from settings.json, defaulting to system', () => {
    const d = dir()
    expect(readAppLanguageSetting(d)).toBe('system')
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ appLanguage: 'nl', formatVersion: 2 }))
    expect(readAppLanguageSetting(d)).toBe('nl')
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ appLanguage: 'klingon' }))
    expect(readAppLanguageSetting(d)).toBe('system')
    writeFileSync(join(d, 'settings.json'), '{not json')
    expect(readAppLanguageSetting(d)).toBe('system')
  })

  it('appends the Chromium lang switch for the resolved language', () => {
    const d = dir()
    // The module's own boot ran at import with the mocked userData.
    appended.length = 0
    expect(bootLanguage(d, ['en-GB'])).toEqual({ language: 'en', lang: 'en-GB' })
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ appLanguage: 'system' }))
    expect(bootLanguage(d, ['nl-BE', 'en'])).toEqual({ language: 'nl', lang: 'nl' })
    expect(core.currentLanguage()).toBe('nl')
    expect(core.currentLocale()).toBe('nl-BE')
    expect(appended).toEqual([
      ['lang', 'en-GB'],
      ['lang', 'nl'],
    ])
  })
})

describe('setupI18n', () => {
  it('speaks the resolved language from the start and switches live, rebuilding menus', () => {
    const settings = new FakeSettings()
    const invalidate = vi.fn()
    const handle = setupI18n({ settings: settings as never, menus: { invalidate }, systemLanguages: () => ['nl-NL'], env: {} })
    expect(core.currentLanguage()).toBe('nl')
    expect(mainT('menus.top.file')).toBe('Archief')
    // Menus built before the feature started get rebuilt in Dutch.
    expect(invalidate).toHaveBeenCalledTimes(1)
    settings.update({ appLanguage: 'en' })
    expect(mainT('menus.top.file')).toBe('File')
    expect(invalidate).toHaveBeenCalledTimes(2)
    settings.update({ flags: { other: 'on' } })
    expect(invalidate).toHaveBeenCalledTimes(2)
    settings.update({ flags: { 'pseudo-locale': 'on' } })
    expect(mainT('menus.top.file').startsWith('[')).toBe(true)
    expect(invalidate).toHaveBeenCalledTimes(3)
    handle.dispose()
    settings.update({ appLanguage: 'nl' })
    expect(invalidate).toHaveBeenCalledTimes(3)
  })

  it('treats system as English in smoke', () => {
    const settings = new FakeSettings()
    setupI18n({ settings: settings as never, menus: { invalidate: () => undefined }, smoke: true, systemLanguages: () => ['nl-NL'], env: {} }).dispose()
    expect(core.currentLanguage()).toBe('en')
  })

  it('logs a missing Dutch key once, to the main log', () => {
    const settings = new FakeSettings({ appLanguage: 'nl' })
    const handle = setupI18n({ settings: settings as never, menus: { invalidate: () => undefined }, env: {} })
    const key = Object.keys(EN).find((k) => !(k in NL)) as MessageKey | undefined
    if (key) {
      expect(mainT(key)).toBe(EN[key])
      mainT(key)
      expect(logged.filter(([level, m]) => level === 'warn' && m.includes(key))).toHaveLength(1)
    }
    handle.dispose()
  })

  it('ATELIER_PSEUDO_LOCALE=1 turns the flag on for one launch, and the next launch restores it', () => {
    const d = dir()
    const settings = new FakeSettings({ flags: { 'pseudo-locale': 'off' } })
    const first = setupI18n({ settings: settings as never, menus: { invalidate: () => undefined }, dataDir: d, env: { ATELIER_PSEUDO_LOCALE: '1' } })
    expect(settings.value.flags['pseudo-locale']).toBe('on')
    expect(core.pseudoActive()).toBe(true)
    expect(existsSync(join(d, 'pseudo-locale-env.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(d, 'pseudo-locale-env.json'), 'utf8'))).toEqual({ previous: 'off' })
    first.dispose()
    const second = setupI18n({ settings: settings as never, menus: { invalidate: () => undefined }, dataDir: d, env: {} })
    expect(settings.value.flags['pseudo-locale']).toBe('off')
    expect(core.pseudoActive()).toBe(false)
    expect(existsSync(join(d, 'pseudo-locale-env.json'))).toBe(false)
    second.dispose()
  })

  it('without a data folder the variable still brackets main', () => {
    const settings = new FakeSettings()
    const handle = setupI18n({ settings: settings as never, menus: { invalidate: () => undefined }, env: { ATELIER_PSEUDO_LOCALE: '1' } })
    expect(core.pseudoActive()).toBe(true)
    handle.dispose()
  })
})

describe('website languages that follow the system', () => {
  it('put the app language first, and leave a custom list alone', () => {
    core.setLanguage('en')
    expect(followingLanguages({ languages: { mode: 'system', list: [] } } as never)).toEqual(['en-GB', 'de-DE', 'nl-NL'])
    core.setLanguage('nl')
    expect(followingLanguages({ languages: { mode: 'system', list: [] } } as never)).toEqual(['nl-NL', 'de-DE', 'en-GB'])
    expect(followingLanguages({ languages: { mode: 'custom', list: ['fr'] } } as never)).toBeNull()
  })

  it('re-apply to every session when the app language changes', () => {
    applied.length = 0
    const settings = new FakeSettings({ appLanguage: 'en' }) as FakeSettings & { value: S & { languages: { mode: string; list: string[] } } }
    settings.value = { ...settings.value, languages: { mode: 'system', list: [] } } as never
    i18nFeature.app?.({ settings, dataDir: undefined, smoke: true } as never)
    i18nFeature.session?.({} as never, { private: false, partition: '' })
    expect(applied.at(-1)).toEqual(['en-GB', 'de-DE', 'nl-NL'])
    settings.update({ appLanguage: 'nl' })
    expect(applied.at(-1)).toEqual(['nl-NL', 'de-DE', 'en-GB'])
    void i18nFeature.dispose?.()
  })
})
