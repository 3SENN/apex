/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shell design pass: DS-90 palette, DS-100/101/103/105 destination pages,
// DS-107 start surface, DS-132 segments, DS-138 pressed toggles, DS-140 lines.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PALETTE_TOP_FRACTION, PALETTE_TOP_MIN, paletteAnchor } from '../src/renderer/src/components/address'
import { isStartSurface } from '../src/renderer/src/components/startSurfaceLogic'
import { STATUS_CHIPS, dropdownChipLabel, sortEnabled, toggledStatus } from '../src/renderer/src/chat/logic/allChatsChips'
import { libraryCompanionIds } from '../src/renderer/src/files/libraryCompanions'
import { address as enAddress } from '../src/shared/i18n/en/address'
import { address as nlAddress } from '../src/shared/i18n/nl/address'
import { chatTools as enChatTools } from '../src/shared/i18n/en/chatTools'
import { chatTools as nlChatTools } from '../src/shared/i18n/nl/chatTools'

const src = (path: string): string => readFileSync(join(__dirname, '..', 'src/renderer/src', path), 'utf8')
/** The body of the first rule whose selector line is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  if (at === -1) throw new Error(`no rule ${selector}`)
  return css.slice(at, css.indexOf('}', at))
}

describe('DS-90 palette geometry', () => {
  it('puts the palette top about a quarter down the window', () => {
    const a = paletteAnchor({ width: 1440, height: 900 })
    expect(a).toEqual({ x: 0, y: Math.round(900 * PALETTE_TOP_FRACTION), width: 1440, height: 900 - 225 })
  })

  it('keeps a floor in short windows and never leaves the window', () => {
    expect(paletteAnchor({ width: 800, height: 120 }).y).toBe(PALETTE_TOP_MIN)
    const tiny = paletteAnchor({ width: 300, height: 60 })
    expect(tiny.y).toBeLessThanOrEqual(60)
    expect(tiny.height).toBeGreaterThanOrEqual(0)
    expect(paletteAnchor({ width: -5, height: 0 })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('places the surface at the anchor top with no extra gap', () => {
    const index = src('overlay/surfaces/address/index.ts')
    const block = index.slice(index.indexOf('const universalSearch'), index.indexOf('const findBar'))
    expect(block).toMatch(/placement: 'top-center'/)
    expect(block).toMatch(/gap: 0/)
  })

  it('draws a 20 radius card, a 20 px input, 24 px chips and 40 px rows on a 44 px pitch', () => {
    const css = src('overlay/surfaces/address/address.css')
    expect(rule(css, '.us')).toMatch(/border-radius: 20px/)
    expect(rule(css, '.us__field input')).toMatch(/font-size: 20px/)
    expect(rule(css, '.us__chip')).toMatch(/height: 24px/)
    const row = rule(css, '.us .cb-row')
    expect(row).toMatch(/min-height: 40px/)
    expect(row).toMatch(/margin: 2px 8px/)
    expect(rule(css, '.us .cb-row__icon svg')).toMatch(/width: 20px/)
  })

  it('has a go-hint in both languages', () => {
    expect(enAddress['address.universal.go']).toBeTruthy()
    expect(nlAddress['address.universal.go']).toBeTruthy()
  })

  it('opens filtered to chats from the chats header', () => {
    expect(src('components/sidebar/Sidebar.tsx')).toMatch(/onSearch=\{\(\) => openUniversalSearch\('chats'\)\}/)
    expect(src('components/AddressPill.tsx')).toMatch(/openUniversalSearch\(filter: UniversalFilter = 'all'\)/)
  })
})

describe('DS-107 start surface', () => {
  it('shows only for a loaded, empty draft that is not an import', () => {
    const base = { empty: true, phase: 'ready', draft: true, imported: null }
    expect(isStartSurface(base)).toBe(true)
    expect(isStartSurface({ ...base, empty: false })).toBe(false)
    expect(isStartSurface({ ...base, phase: 'loading' })).toBe(false)
    expect(isStartSurface({ ...base, draft: false })).toBe(false)
    expect(isStartSurface({ ...base, draft: undefined })).toBe(false)
    expect(isStartSurface({ ...base, imported: { source: 'atelier' } })).toBe(false)
  })

  it('respects Reduce Motion for the keep-awake corner and the tray', () => {
    const css = src('components/startSurface.css')
    expect(css).toMatch(/prefers-reduced-motion: reduce/)
    expect(css).toMatch(/:root\[data-motion='reduced'\] \.chat-view--empty > \.ss-corner--bottom/)
    expect(css).toMatch(/:root\[data-motion='reduced'\] \.chat-view--empty > \.chat-start__tray/)
  })

  it('shares the corners with the new tab and adds keep-awake to the empty chat', () => {
    expect(src('components/NewTabPage.tsx')).toMatch(/<StartCorners /)
    expect(src('chat/ChatView.tsx')).toMatch(/startEmpty && <StartKeepAwake/)
  })

  it('tucks the tray under the composer, with the private toggle below the ideas', () => {
    const view = src('chat/ChatView.tsx')
    const tray = view.indexOf('chat-start__tray')
    const ideas = view.indexOf('<IdeasCard', tray)
    const privateToggle = view.indexOf('<PrivateToggle', tray)
    expect(tray).toBeGreaterThan(-1)
    expect(ideas).toBeGreaterThan(tray)
    expect(privateToggle).toBeGreaterThan(ideas)
  })
})

describe('DS-101 All chats chips', () => {
  it('toggles one status at a time', () => {
    expect(STATUS_CHIPS).toEqual(['unread', 'needs-input', 'archived'])
    expect(toggledStatus('any', 'unread')).toBe('unread')
    expect(toggledStatus('unread', 'unread')).toBe('any')
    expect(toggledStatus('unread', 'archived')).toBe('archived')
  })

  it('labels dropdown chips by name at rest and by value once picked', () => {
    const options = [
      { value: 'all', label: 'All chats' },
      { value: 'only', label: 'Routine runs only' },
    ] as const
    expect(dropdownChipLabel('all', 'all', 'Routine runs', options)).toBe('Routine runs')
    expect(dropdownChipLabel('only', 'all', 'Routine runs', options)).toBe('Routine runs only')
    expect(dropdownChipLabel('gone' as string, '', 'Companion', [])).toBe('Companion')
  })

  it('offers best match only while searching', () => {
    expect(sortEnabled('best-match', '  ')).toBe(false)
    expect(sortEnabled('best-match', 'trip')).toBe(true)
    expect(sortEnabled('recent', '')).toBe(true)
  })

  it('has every new string in English and Dutch', () => {
    const keys = Object.keys(enChatTools).filter((k) => k.startsWith('chatTools.allChats.'))
    expect(keys.length).toBeGreaterThan(20)
    for (const k of keys) expect((nlChatTools as Record<string, string>)[k], k).toBeTruthy()
  })

  it('uses a 672 px column, 16 px headings and single-line 48 px rows', () => {
    const css = src('chat/chat.css')
    expect(rule(css, '.chats-page__inner')).toMatch(/672px/)
    expect(rule(css, '.chats-group__title')).toMatch(/font-size: 16px/)
    expect(rule(css, '.chats-page__top')).toMatch(/position: sticky/)
    expect(rule(css, '.chats-row')).toMatch(/height: 48px/)
    expect(css).not.toMatch(/\.chats-row__badge/)
  })
})

describe('DS-105 Library', () => {
  it('lists visible companions, hidden makers and removed makers once', () => {
    const companions = [{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c', hidden: true }]
    const files = [{ companionId: 'c' }, { companionId: 'gone' }, { companionId: 'a' }]
    expect(libraryCompanionIds(companions, files)).toEqual(['a', 'c', 'gone'])
    expect(libraryCompanionIds([], [])).toEqual([])
  })

  it('lays 265×269 cards with 16 px gaps in a fluid, left-aligned frame', () => {
    const css = src('files/files.css')
    expect(rule(css, '.lf-grid')).toMatch(/265px/)
    expect(rule(css, '.lf-grid')).toMatch(/gap: 16px/)
    expect(rule(css, '.lf-card')).toMatch(/height: 269px/)
    const settings = src('settings/settings.css')
    expect(rule(settings, '.sp-main--fluid')).toMatch(/padding-left: 32px/)
    expect(rule(settings, '.sp-content--fluid')).toMatch(/margin: 0/)
  })
})

describe('destination template (DS-100, DS-103)', () => {
  it('puts the docs link before the primary pill', () => {
    const kit = src('settings/kit.tsx')
    const header = kit.slice(kit.indexOf('export function PageHeader'), kit.indexOf('function useStickyHeaderHeight'))
    expect(header.indexOf('sp-header__help')).toBeLessThan(header.indexOf('{actions}'))
  })

  it('sticks the header as well as row 2', () => {
    const css = src('settings/settings.css')
    expect(rule(css, '.sp-content--wide > .sp-header:first-child:has(+ .sp-dest-toolbar)')).toMatch(/position: sticky/)
    expect(rule(css, '.sp-dest-toolbar')).toMatch(/var\(--sp-dest-head-h/)
  })

  it('lets connector tiles fill and ellipsise inside their cells', () => {
    const css = src('settings/settings.css')
    expect(rule(css, '.sp-conn-tile')).toMatch(/width: 100%/)
    expect(rule(css, '.sp-tile-grid > *')).toMatch(/min-width: 0/)
    expect(rule(css, '.sp-dest-toolbar--full .sp-search--pill')).toMatch(/flex: 1 1 auto/)
  })
})

describe('control vocabulary and lines (DS-132, DS-138, DS-140)', () => {
  it('sizes settings segments to about 124×32', () => {
    const option = rule(src('settings/settings.css'), '.sp-row__control > .ui-segmented--md .ui-segmented__option')
    expect(option).toMatch(/height: 32px/)
    expect(option).toMatch(/flex: 0 1 124px/)
  })

  it('draws pressed icon toggles neutral, never in the companion colour', () => {
    const css = src('ui/ui.css')
    const at = css.indexOf('\n.ui-icon-btn--on,\n')
    expect(at).toBeGreaterThan(-1)
    const on = css.slice(at, css.indexOf('}', at))
    expect(on).not.toMatch(/--accent|--bg-selected/)
    expect(src('styles.css')).toMatch(/--bg-pressed: var\(--bg-active\)/)
  })

  it('draws settings cards and borders at one CSS pixel', () => {
    expect(src('styles.css')).toMatch(/--line: 1px/)
    for (const file of ['settings/settings.css', 'settings/settingsPages.css']) expect(src(file)).not.toMatch(/var\(--hairline\)/)
    expect(rule(src('settings/settings.css'), '.sp-card')).toMatch(/border: var\(--line\)/)
  })
})
