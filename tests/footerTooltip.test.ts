/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tooltipTarget } from '../src/renderer/src/ui/logic/tooltip'

// DS-18: the footer's tooltip sits above the 44 px strip, not the 36 px
// profile button inside it (which would put it 4 px below the strip's top).

describe('footer tooltip anchor', () => {
  const control = { isConnected: true, name: 'button' }
  const strip = { isConnected: true, name: 'strip' }

  it('places the tip against the anchor when one is given', () => {
    expect(tooltipTarget(control, strip)).toBe(strip)
  })

  it('falls back to the control without an anchor, or once the anchor has left the page', () => {
    expect(tooltipTarget(control, null)).toBe(control)
    expect(tooltipTarget(control, undefined)).toBe(control)
    expect(tooltipTarget(control, { isConnected: false, name: 'gone' })).toBe(control)
  })

  it('the footer anchors its tip on the strip', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/components/sidebar/SidebarFooter.tsx'), 'utf8')
    expect(src).toMatch(/useTooltip\(profile, \{[^}]*anchor: strip/)
    expect(src).toMatch(/<footer ref=\{strip\} className="side-footer"/)
    const css = readFileSync(join(__dirname, '../src/renderer/src/components/sidebar/sidebar.css'), 'utf8')
    const footer = /\.side-footer \{([^}]*)\}/.exec(css)?.[1] ?? ''
    const button = /\.profile-row \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(footer).toMatch(/height: 44px/)
    expect(button).toMatch(/height: 36px/)
  })
})
