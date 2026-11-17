/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@shared/i18n/core'
import { EN } from '@shared/i18n/en'
import { NL } from '@shared/i18n/nl'
import { SETTINGS_PAGES, settingsPageTitle } from '@shared/url'
import { DEFAULT_PAGE, settingsNav } from '../src/renderer/src/settings/logic/nav'

// The Settings nav (SETTINGS_PAGES and its group labels) and the
// sidebar destinations follow the app language instead of fixed English, and
// Dutch covers every English key.

afterEach(() => setLanguage('en'))

describe('Dutch chrome', () => {
  it('Dutch has every English key', () => {
    expect(Object.keys(EN).filter((k) => !(k in NL))).toEqual([])
  })

  it('every settings page has a title in both languages', () => {
    for (const page of SETTINGS_PAGES) expect(settingsPageTitle(page.id)).toBe(page.title)
    setLanguage('nl')
    expect(settingsPageTitle('general')).toBe('Algemeen')
    expect(settingsPageTitle('default-browser')).toBe('Standaardbrowser')
    expect(settingsPageTitle('nope')).toBe('Instellingen')
  })

  it('the settings nav is built in the app language', () => {
    const english = settingsNav(undefined, 'darwin')
    expect(english.map((g) => g.label)).toEqual([null, 'Companion', 'Agent', 'Browsing', 'Your data', null])
    setLanguage('nl')
    const dutch = settingsNav(undefined, 'darwin')
    expect(dutch.map((g) => g.label)).toEqual([null, 'Companion', 'Agent', 'Browsen', 'Je gegevens', null])
    const titles = dutch.flatMap((g) => g.entries.map((e) => e.title))
    expect(titles).toContain('Algemeen')
    expect(titles).toContain('Weergave')
    expect(titles).toContain(`Over ${BRAND_NAME}`)
    expect(titles).not.toContain('General')
    expect(dutch[0]?.entries[0]).toMatchObject({ kind: 'page', id: DEFAULT_PAGE, title: 'Jij' })
    const link = dutch.flatMap((g) => g.entries).find((e) => e.kind === 'link')
    expect(link).toMatchObject({ id: 'connectors', url: 'atelier://connectors', title: 'Connectors' })
  })
})
