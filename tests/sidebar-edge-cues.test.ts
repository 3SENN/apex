/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { edgeCueLabel, edgeCues } from '../src/renderer/src/components/sidebar/logic/cues'

// The sidebar's edge pills (sites-prompt, address-command-bar): which
// rows count as out of view, translated labels, and a clear band so a pill
// never sits on a heading or a title.

const view = { top: 100, bottom: 500 }

describe('sidebar edge cues', () => {
  it('points at rows wholly out of view; the active row wins its edge', () => {
    expect(edgeCues([{ cue: 'needs', top: 40, bottom: 70 }], view)).toEqual({ above: 'needs', below: null })
    expect(
      edgeCues(
        [
          { cue: 'needs', top: 600, bottom: 630 },
          { cue: 'active', top: 640, bottom: 670 },
          { cue: 'needs', top: 700, bottom: 730 },
        ],
        view,
      ),
    ).toEqual({ above: null, below: 'active' })
    // Rows still partly in view don't count.
    expect(edgeCues([{ cue: 'active', top: 80, bottom: 110 }, { cue: 'needs', top: 490, bottom: 520 }], view)).toEqual({ above: null, below: null })
  })

  it('ignores rows that are not laid out or inert', () => {
    // A hidden row measures 0×0 at the window origin: it is not "above".
    expect(edgeCues([{ cue: 'needs', top: 0, bottom: 0 }], view)).toEqual({ above: null, below: null })
    expect(edgeCues([{ cue: 'active', top: 600, bottom: 630, inert: true }], view)).toEqual({ above: null, below: null })
  })

  it('labels come from the string tables', () => {
    expect(edgeCueLabel('active')).toBe('Current page')
    expect(edgeCueLabel('needs')).toBe('Waiting for you')
    const source = readFileSync('src/renderer/src/components/sidebar/logic/cues.ts', 'utf8')
    expect(source).not.toMatch(/'Current page'|'Waiting for you'/)
  })

  it('clears a band under each pill so it does not cover the list', () => {
    const css = readFileSync('src/renderer/src/components/sidebar/sidebar.css', 'utf8')
    expect(css).toMatch(/\.side-scroll:has\(> \.edge-badge--top\)\s*\{\s*--cue-top-clear:/)
    expect(css).toMatch(/\.side-scroll:has\(> \.edge-badge--bottom\)\s*\{\s*--cue-bottom-clear:/)
    expect(css).toMatch(/transparent var\(--cue-top-clear\)/)
    expect(css).toMatch(/transparent var\(--cue-bottom-clear\)/)
  })
})
