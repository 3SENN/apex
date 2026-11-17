/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FunctionComponent } from 'react'
import { describe, expect, it } from 'vitest'
import { readBranding } from '../scripts/branding.mjs'
import { parseWordmark } from '../src/renderer/src/brand/wordmark'

// The logo per branding (src/renderer/src/brand/BrandLogo.tsx): the official
// wordmark from branding/official/renderer/logo.svg; the unofficial branding
// has none, so its logo is the plain mark with the name in the UI font.

const REPO = resolve(__dirname, '..')

describe('the logo', () => {
  it('is the Apex wordmark, word and sprout, in the official branding', () => {
    const official = readBranding('official')
    expect(official.logo).toBe('renderer/logo.svg')
    const mark = parseWordmark(readFileSync(join(official.dir, official.logo!), 'utf8'))
    expect(mark).not.toBeNull()
    expect(mark!.width / mark!.height).toBeCloseTo(5043 / 2480, 3)
    expect(mark!.paths.map((p) => p.className)).toEqual(['apex-logo__word', 'apex-logo__sprout'])
  })

  it('is the name beside the plain mark in the unofficial branding, with nothing of Apex\'s', () => {
    const unofficial = readBranding('unofficial')
    expect(unofficial.logo).toBeNull()
    expect(existsSync(join(unofficial.dir, 'renderer', 'logo.svg'))).toBe(false)
    for (const file of ['mark-32.png', 'mark-64.png', 'mark-128.png', 'app-icon-128.png']) expect(existsSync(join(unofficial.dir, 'renderer', file)), file).toBe(true)
  })

  it('reads only what a wordmark has', () => {
    expect(parseWordmark('')).toBeNull()
    expect(parseWordmark('<svg viewBox="0 0 10 5"></svg>')).toBeNull()
    expect(parseWordmark('<svg viewBox="0 0 10 5"><path d="M0 0"/></svg>')).toBeNull()
    expect(parseWordmark('<svg viewBox="0 0 10 5"><path class="a" d="M0 0L1 1"/></svg>')).toEqual({ width: 10, height: 5, paths: [{ className: 'a', d: 'M0 0L1 1' }] })
  })

  it('is drawn by BrandLogo everywhere the app shows it', () => {
    const component = readFileSync(join(REPO, 'src/renderer/src/brand/BrandLogo.tsx'), 'utf8')
    expect(component).toContain("@branding/renderer/logo.svg")
    expect(component).not.toMatch(/M89\.4 2022\.5/) // the wordmark lives in the branding folder, not in code
  })
})

describe('BrandLogo in the branding this run was built with', () => {
  it('draws the wordmark for Apex, or the mark with the name in the UI font', async () => {
    // Loaded by path so the node project's typecheck leaves the renderer's JSX alone.
    const file = '../src/renderer/src/brand/BrandLogo.tsx'
    const { BrandLogo, BrandMark } = (await import(/* @vite-ignore */ file)) as Record<'BrandLogo' | 'BrandMark', FunctionComponent<{ size?: number }>>
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { BRANDING } = await import('../src/shared/branding')
    const logo = renderToStaticMarkup(createElement(BrandLogo, { size: 32 }))
    expect(logo).toContain(`aria-label="${BRANDING.name}"`)
    if (BRANDING.wordmark) {
      expect(logo).toMatch(/^<svg[^>]*viewBox="0 0 5043 2480"/)
      expect(logo).toContain('class="apex-logo__sprout"')
    } else {
      expect(logo).not.toContain('<path')
      expect(logo).toContain(`<span class="apex-logo__name" aria-hidden="true">${BRANDING.name}</span>`)
    }
    expect(renderToStaticMarkup(createElement(BrandMark, { size: 24 }))).toMatch(/<img[^>]*class="apex-pip-mark"/)
  })
})
