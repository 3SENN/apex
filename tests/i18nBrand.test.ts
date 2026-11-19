/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeBranding } from '../scripts/branding.mjs'
import { brandingFrom } from '../src/shared/branding'
import { EN, type MessageKey } from '../src/shared/i18n/en'
import { NL } from '../src/shared/i18n/nl'

// The app's name in the interface, like Firefox's -brand-short-name: no
// message writes it out; they say {brand}, which the i18n layer fills in from
// the branding the build was made with (Atelier, or Summit for the unofficial
// branding; src/shared/i18n/core.ts). No call site passes it.

const REPO = resolve(__dirname, '..')
const NAMES = /\b(Atelier|Summit|Pip)\b/

afterEach(() => {
  vi.doUnmock('../src/shared/branding')
  vi.resetModules()
})

describe('the catalogues', () => {
  it('never write the app\'s name (or Pip\'s): they say {brand}', () => {
    for (const [lang, catalogue] of [['en', EN], ['nl', NL]] as const) {
      const named = Object.entries(catalogue).filter(([, text]) => NAMES.test(text ?? '')).map(([key]) => `${lang} ${key}`)
      expect(named).toEqual([])
    }
    const branded = Object.values(EN).filter((text) => text.includes('{brand}'))
    expect(branded.length).toBeGreaterThan(400)
  })

  it('say {brand} in the files that ship as text too (help notes, guides, the app-design skill)', () => {
    for (const file of ['src/main/help/getting-started.md', 'src/main/help/troubleshooting.md', 'src/renderer/src/first-week/guides/meet-your-companion.md', 'src/renderer/src/first-week/guides/nl/meet-your-companion.md', 'src/main/skills/builtin/app-design/SKILL.md', ...['docx', 'pdf', 'pptx', 'xlsx'].map((k) => `src/engines/claude-code/main/documentSkills/${k}/SKILL.md`)]) {
      const text = readFileSync(join(REPO, file), 'utf8')
      expect(text, file).toContain('{brand}')
      expect(text, file).not.toMatch(NAMES)
    }
  })
})

describe('{brand}', () => {
  for (const official of ['1', '0']) {
    const branding = brandingFrom(runtimeBranding({ ATELIER_OFFICIAL_BRANDING: official }))

    it(`resolves to ${branding.name} in English and Dutch, with no call site passing it`, async () => {
      vi.resetModules()
      vi.doMock('../src/shared/branding', async (original) => ({ ...(await original<typeof import('../src/shared/branding')>()), BRANDING: branding, BRAND_NAME: branding.shortName }))
      const core = await import('../src/shared/i18n/core')
      // Plural messages need their count; one of them is checked below.
      const keys = (Object.keys(EN) as MessageKey[]).filter((key) => EN[key].includes('{brand}') && !EN[key].includes(', plural,'))
      for (const language of ['en', 'nl'] as const) {
        core.setLanguage(language)
        for (const key of keys) {
          const text = core.t(key)
          expect(text, `${language} ${key}`).not.toContain('{brand}')
          if (language === 'en') expect(text, key).toContain(branding.shortName)
        }
      }
      core.setLanguage('en')
      expect(core.t('core.window.untitled')).toBe(branding.shortName)
      expect(core.t('system.tray.tooltip')).toBe(branding.shortName)
      // A plural case may say it too; a caller's own `brand` still wins.
      expect(core.t('tweaks.css.removed', { count: 2 })).toContain(`${branding.shortName} left out 2 parts`)
      expect(core.format('{brand} and {x}', { x: 'y' })).toBe(`${branding.shortName} and y`)
      expect(core.format('{brand}', { brand: 'Other' })).toBe('Other')
    })
  }

  it('is the name of the branding this run was built with', async () => {
    const { t } = await import('../src/shared/i18n/core')
    const { BRAND_NAME } = await import('../src/shared/branding')
    expect(t('core.window.untitled')).toBe(BRAND_NAME)
  })
})
