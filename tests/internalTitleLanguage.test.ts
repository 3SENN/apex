/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { afterEach, describe, expect, it } from 'vitest'
import { planItems } from '@shared/firstWeek'
import { setLanguage } from '@shared/i18n/core'
import { internalPageTitle, internalTitle } from '@shared/url'

// Tab titles, breadcrumbs and the getting-started cards follow the app
// language; the route table's English titles are only the data's own.

describe('internal page titles in the app language', () => {
  afterEach(() => setLanguage('en'))

  it('reads the same English as before by default', () => {
    expect(internalTitle('atelier://settings/general')).toEqual({ title: 'Settings', crumbs: ['Settings', 'General'] })
    expect(internalTitle('atelier://chat/abc').title).toBe('New chat')
    expect(internalTitle('atelier://first-week/chats-and-tabs')).toEqual({ title: 'Chats and tabs', crumbs: ['Getting started', 'Chats and tabs'] })
    expect(internalPageTitle('nope')).toBe(BRAND_NAME)
  })

  it('titles tabs, crumbs and plan cards in Dutch', () => {
    setLanguage('nl')
    expect(internalTitle('atelier://settings/general')).toEqual({ title: 'Instellingen', crumbs: ['Instellingen', 'Algemeen'] })
    expect(internalTitle('atelier://history').title).toBe('Geschiedenis')
    expect(internalTitle('atelier://chat/abc').title).toBe('Nieuwe chat')
    expect(internalTitle('atelier://first-week/chats-and-tabs')).toEqual({ title: 'Chats en tabbladen', crumbs: ['Aan de slag', 'Chats en tabbladen'] })
    expect(internalTitle('atelier://companion/pip/memory', { companion: () => 'Pip' }).crumbs).toEqual(['Pip', 'Geheugen'])
    const card = planItems({ starters: [], signals: {}, completed: {}, dismissed: {} } as never).find((i) => i.id === 'import-data')
    expect(card?.title).toBe('Neem je bladwijzers mee')
  })
})
