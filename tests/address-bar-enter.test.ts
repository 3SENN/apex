/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OmniboxRow } from '@shared/omnibox'
import { enterAction, enterOptions } from '../src/renderer/src/overlay/surfaces/address/enter'
import { viewportVars } from '../src/renderer/src/overlay/host/viewport'

// The address bar's Enter rules, and the overlay sizing that kept the
// command bar from showing at all.

const row = (url: string): OmniboxRow => ({ id: `typed:${url}`, group: 'typed', title: url, action: { kind: 'navigate', url } })

describe('command bar Enter', () => {
  it('runs the top row when it answers what is typed now', () => {
    const rows = [row('https://example.com/')]
    expect(enterAction({ value: 'example.com', typed: 'example.com', completion: null, rowsFor: 'example.com', rows })).toEqual({ kind: 'navigate', url: 'https://example.com/' })
  })

  it('asks again when Enter comes before the rows for the last keys', () => {
    const rows = [row('https://example.co/')]
    expect(enterAction({ value: 'example.com', typed: 'example.com', completion: null, rowsFor: 'example.co', rows })).toBeNull()
    expect(enterAction({ value: 'hello', typed: 'hello', completion: null, rowsFor: null, rows: [] })).toBeNull()
  })

  it('takes the inline completion while it shows, and not a typo hint', () => {
    const completion = { input: 'exa', text: 'example.com', url: 'https://example.com/', typo: false }
    expect(enterAction({ value: 'example.com', typed: 'exa', completion, rowsFor: 'exa', rows: [row('https://exa/')] })).toEqual({ kind: 'navigate', url: 'https://example.com/' })
    const typo = { ...completion, typo: true }
    expect(enterAction({ value: 'example.com', typed: 'example.com', completion: typo, rowsFor: 'example.com', rows: [row('https://x/')] })).toEqual({ kind: 'navigate', url: 'https://x/' })
  })

  it('opens here, behind with ⌘ or Ctrl, in front with ⌥', () => {
    expect(enterOptions({ metaKey: false, ctrlKey: false, altKey: false })).toEqual({})
    expect(enterOptions({ metaKey: true, ctrlKey: false, altKey: false })).toEqual({ background: true })
    expect(enterOptions({ metaKey: false, ctrlKey: true, altKey: true })).toEqual({ background: true })
    expect(enterOptions({ metaKey: false, ctrlKey: false, altKey: true })).toEqual({ newTab: true })
  })
})

describe('overlay surfaces size against the window, not the overlay view', () => {
  it('gives frames the window size as --ov-vw and --ov-vh', () => {
    expect(viewportVars({ width: 1440.4, height: 900 })).toEqual({ '--ov-vw': '1440px', '--ov-vh': '900px' })
    expect(viewportVars({ width: 0, height: 0 })).toEqual({})
  })

  it('leaves no bare vw or vh in overlay CSS (the view is only as big as its surfaces)', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (name.endsWith('.css')) files.push(path)
      }
    }
    walk('src/renderer/src/overlay')
    expect(files.length).toBeGreaterThan(5)
    const bare: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/var\(--ov-v([wh]), 100v\1\)/g, '')
      for (const m of text.matchAll(/(?<![\w.-])\d+(?:\.\d+)?v[wh]\b/g)) bare.push(`${file}: ${m[0]}`)
    }
    expect(bare).toEqual([])
  })
})
