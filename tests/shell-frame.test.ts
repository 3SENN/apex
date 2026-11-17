/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, systemPreferences: {}, nativeImage: {}, webContents: {} }))

import { SETTINGS } from '../src/shared/settingsRegistry'
import { EN } from '../src/shared/i18n/en'
import { NL } from '../src/shared/i18n/nl'
import { navEnabled } from '../src/renderer/src/components/toolbarLogic'
import { ghostLayout } from '../src/renderer/src/components/sidebar/logic/ghost'
import { TRAFFIC_INSET, trafficPlacement } from '../src/renderer/src/components/sidebar/logic/traffic'
import { ghostFrame, stepTile } from '../src/main/tearOff'
import { blit, pageRadius } from '../src/main/smokeKit'
import { pointerWithin } from '../src/main/window'
import { SERVICE_SCHEMAS } from '../src/main/services'
import { TAB_SCHEMAS } from '../src/main/schemas/tabs'

// The shell frame's geometry, motion and states (DS-01 to DS-25): the pure
// logic, the IPC contracts, and the stylesheet rules the layout depends on.

const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
const sidebar = readFileSync('src/renderer/src/components/sidebar/sidebar.css', 'utf8')
/** The body of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, selector).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe('DS-06 sidebar order', () => {
  it('starts Workspace, Guides, Connectors and Packs in the overflow dropdown', () => {
    for (const d of ['workspace', 'guides', 'connectors', 'packs'] as const) expect(SETTINGS[`sidebar.destinations.${d}`].default).toBe(false)
    for (const d of ['chats', 'routines', 'skills', 'meetings'] as const) expect(SETTINGS[`sidebar.destinations.${d}`].default).toBe(true)
  })
})

describe('DS-20 toolbar left cluster', () => {
  const tab = { canGoBack: true, canGoForward: true }
  it('makes back and forward inert on chat pages, whatever the history', () => {
    expect(navEnabled(tab, 'back', true)).toBe(false)
    expect(navEnabled(tab, 'forward', true)).toBe(false)
    expect(navEnabled(tab, 'back', false)).toBe(true)
    expect(navEnabled({ canGoBack: false, canGoForward: true }, 'back', false)).toBe(false)
    expect(navEnabled(null, 'forward', false)).toBe(false)
  })

  it('uses 32 px boxes 2 px apart from sheet + 8, with 16 and 18 px glyphs', () => {
    expect(rule(styles, '.toolbar')).toContain('padding: 0 var(--space-2);')
    expect(rule(styles, '.toolbar__group--nav')).toContain('gap: 2px;')
    expect(rule(styles, '.toolbar__group--nav .sidebar-toggle')).toContain('margin-right: 6px;')
    expect(rule(styles, '.toolbar__group .ui-icon-btn')).toMatch(/width: 32px;\s*height: 32px;/)
    expect(rule(styles, '.toolbar__group .ui-icon-btn svg')).toContain('width: 16px;')
    expect(rule(styles, '.toolbar__group .history-btn svg')).toContain('width: 18px;')
  })
})

describe('DS-05 sidebar header', () => {
  it('places the window controls at x 14, y 12', () => {
    expect(TRAFFIC_INSET).toBe(14)
    expect(trafficPlacement({ left: 0, top: 0, width: 72, height: 40 })).toEqual({ visible: true, x: 14, y: 12 })
  })

  it('uses 32 px boxes 4 px apart, 6 px from the right edge', () => {
    expect(rule(sidebar, '.side-header')).toMatch(/gap: 4px;[\s\S]*padding: 0 6px 0 0;/)
    expect(rule(sidebar, '.side-header .ui-icon-btn')).toMatch(/width: 32px;[\s\S]*border-radius: var\(--radius-sm\);/)
    expect(rule(sidebar, '.side-header .ui-icon-btn svg')).toContain('width: 16px;')
  })
})

describe('DS-10 and DS-15 active chip', () => {
  it('lifts the dark chip about four hover steps off the ground', () => {
    expect(styles).toMatch(/--chip-bg: light-dark\(#fcfbf9, color-mix\(in srgb, var\(--profile-ground\) 79%, #ffffff\)\);/)
  })

  it('draws the chip on a layer that exists only on the active row, so it jumps', () => {
    expect(rule(sidebar, '.side-row--active,\n.side-row--active:hover')).toContain('background: none;')
    const chip = rule(sidebar, '.side-row--active::after')
    expect(chip).toContain('background: var(--chip-bg);')
    expect(chip).toContain('box-shadow: var(--chip-shadow);')
    expect(chip).not.toContain('transition')
    expect(rule(sidebar, '.side-row')).toContain('isolation: isolate;')
  })

  it('keeps the chip and the faded last-used stamp from taking the close X’s press', () => {
    expect(rule(sidebar, '.side-row--active::after')).toContain('pointer-events: none;')
    // The stamp shares close's grid cell; faded out on hover it paints above close.
    expect(rule(sidebar, '.side-row__trail > *')).toContain('grid-area: 1 / 1;')
    expect(rule(sidebar, '.side-row__trail .side-row__time')).toContain('pointer-events: none;')
    const close = rule(sidebar, '.side-row__close')
    expect(close).toContain('position: relative;')
    expect(close).toContain('z-index: 1;')
  })
})

describe('DS-08 title fade', () => {
  it('fades the last 42 px, ending 10 px before the row edge', () => {
    expect(rule(sidebar, '.side-row__title')).toContain('mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent calc(100% - 2px));')
  })
})

describe('DS-12 chats header', () => {
  it('is 24 px with two 20 px actions ending 8 px in', () => {
    expect(rule(sidebar, '.chats-section > .side-section__header')).toContain('height: 24px;')
    expect(rule(sidebar, '.side-section__actions')).toMatch(/right: 8px;[\s\S]*gap: 4px;/)
    expect(rule(sidebar, '.side-section__actions .side-section__action')).toMatch(/width: 20px;\s*height: 20px;/)
  })

  it('labels its actions in English and Dutch', () => {
    for (const key of ['tabs.chats.search', 'tabs.chats.new', 'tabs.footer.tooltip'] as const) {
      expect(EN[key]).toBeTruthy()
      expect((NL as Record<string, string>)[key]).toBeTruthy()
      expect((NL as Record<string, string>)[key]).not.toBe(EN[key])
    }
  })
})

describe('DS-18 footer', () => {
  it('is a 44 px strip from x 10 to 290 whose fill covers it all', () => {
    expect(rule(sidebar, '.side-footer')).toMatch(/height: 44px;[\s\S]*margin: 0 10px 6px;[\s\S]*padding: 0 4px 0 10px;/)
    expect(rule(sidebar, '.profile-row')).toContain('height: 36px;')
    expect(rule(sidebar, '.profile-row::before')).toMatch(/position: absolute;[\s\S]*inset: 0;/)
    expect(rule(sidebar, '.profile-row:hover::before')).toContain('var(--bg-hover)')
  })
})

describe('DS-01 hairlines and the screenshot radius', () => {
  it('draws one device pixel under the bars and the sidebar header', () => {
    expect(rule(styles, '.sheet__bars::after')).toContain('height: var(--hairline);')
    expect(rule(styles, '.sheet__bars')).not.toContain('border-bottom')
    expect(rule(sidebar, '.side-scroll__rule')).toContain('height: var(--hairline);')
  })

  it('composites page views with the layout radius, square by default', () => {
    expect(pageRadius({})).toBe(0)
    expect(pageRadius({ radius: 0 })).toBe(0)
    expect(pageRadius({ radius: 10 })).toBe(10)
    expect(pageRadius({ radius: Number.NaN })).toBe(0)
    const target = Buffer.alloc(6 * 6 * 4)
    const source = Buffer.alloc(4 * 4 * 4, 0xff)
    blit(target, 6, source, { x: 1, y: 1, width: 4, height: 4 }, pageRadius({}))
    // The page's corner pixel is copied: no rounding.
    expect(target[(1 * 6 + 1) * 4]).toBe(0xff)
  })
})

describe('DS-21, DS-25, DS-03, DS-19 bits of the frame', () => {
  it('sets pill text at 14 px at rest and editing', () => {
    expect(rule(styles, '.pill__text')).toContain('font-size: 14px;')
    expect(rule(styles, '.pill__input')).toContain('font-size: 14px;')
  })

  it('rounds the bookmark tint at 8 px', () => {
    expect(rule(styles, '.bookmark-chip')).toContain('border-radius: var(--radius-sm);')
  })

  it('keeps the toolbar working dot off the companion accent', () => {
    const dot = rule(styles, '.page-chat-btn__state--working')
    expect(dot).toContain('var(--status-working)')
    expect(dot).not.toContain('--accent')
  })

  it('eases in and out on show, decelerates on hide, on the layout timeline', () => {
    expect(rule(sidebar, '.sidebar-frame')).toContain('transition: width var(--motion-layout) var(--ease-in-out);')
    expect(rule(sidebar, '.sidebar-frame--hidden')).toContain('transition-timing-function: var(--ease-out);')
    expect(styles).toMatch(/--ease-in-out: cubic-bezier\(/)
  })
})

describe('DS-16 ghost into a tile', () => {
  it('steps the morph toward the tile and back, and jumps with Reduce Motion', () => {
    expect(stepTile(0, true, false)).toBe(0.25)
    expect(stepTile(0.9, true, false)).toBe(1)
    expect(stepTile(1, false, false)).toBe(0.75)
    expect(stepTile(0.1, false, false)).toBe(0)
    expect(stepTile(0, true, true)).toBe(1)
    expect(stepTile(Number.NaN, false, false)).toBe(0)
  })

  it('sizes the window from chip or card to a tile centred on the pointer', () => {
    const p = { x: 500, y: 300 }
    expect(ghostFrame(p, 0, 0)).toEqual({ x: 476, y: 286, width: 220, height: 36 })
    expect(ghostFrame(p, 1, 0)).toEqual({ x: 476, y: 286, width: 300, height: 200 })
    expect(ghostFrame(p, 0.4, 1)).toEqual({ x: 466, y: 278, width: 68, height: 44 })
  })

  it('draws the favicon alone once past halfway into a tile', () => {
    expect(ghostLayout(0)).toMatchObject({ thumbOpacity: 0, radius: 10, titleOpacity: 1, tile: false })
    expect(ghostLayout(1, 1)).toEqual({ thumbOpacity: 0, radius: 12, titleOpacity: 0, tile: true })
    expect(ghostLayout(0, 0.25)).toMatchObject({ titleOpacity: 0.5, tile: false })
  })

  it('takes only the pinned grid or null over IPC', () => {
    const over = TAB_SCHEMAS.tabDrag.over
    expect(over.safeParse(['pinned']).success).toBe(true)
    expect(over.safeParse([null]).success).toBe(true)
    expect(over.safeParse(['tabs']).success).toBe(false)
    expect(over.safeParse([]).success).toBe(false)
  })
})

describe('DS-14 main tracks the pointer in the sidebar', () => {
  const content = { x: 100, y: 50, width: 1200, height: 800 }
  const rect = { x: 0, y: 0, width: 300, height: 800 }
  it('maps the screen cursor into the chrome and checks the rect', () => {
    expect(pointerWithin({ x: 150, y: 80 }, content, 1, rect)).toBe(true)
    expect(pointerWithin({ x: 400, y: 80 }, content, 1, rect)).toBe(false)
    expect(pointerWithin({ x: 50, y: 80 }, content, 1, rect)).toBe(false)
    // At 200 % zoom the 300 px sidebar spans 600 screen points.
    expect(pointerWithin({ x: 650, y: 80 }, content, 2, rect)).toBe(true)
    expect(pointerWithin({ x: 150, y: 80 }, content, Number.NaN, rect)).toBe(true)
  })

  it('validates the rect the chrome sends', () => {
    const track = SERVICE_SCHEMAS.window.trackSidebarPointer
    expect(track.safeParse([{ x: 0, y: 0, width: 300, height: 800 }]).success).toBe(true)
    expect(track.safeParse([null]).success).toBe(true)
    expect(track.safeParse([{ x: 0, y: 0, width: -1, height: 800 }]).success).toBe(false)
    expect(track.safeParse([{ x: 0, y: 0, width: 300, height: 800, extra: 1 }]).success).toBe(false)
    expect(track.safeParse(['wide']).success).toBe(false)
  })
})
