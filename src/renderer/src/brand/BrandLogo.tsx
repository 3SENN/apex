/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { BRANDING } from '@shared/branding'
import mark32 from '@branding/renderer/mark-32.png'
import mark64 from '@branding/renderer/mark-64.png'
import mark128 from '@branding/renderer/mark-128.png'
import appIcon128 from '@branding/renderer/app-icon-128.png'
import { parseWordmark } from './wordmark'
import './brand.css'

// The branding's logo, mark and icon (branding/<id>/renderer/, through the
// `@branding` alias; scripts/branding.mjs).
//
// Official Apex, as on apexbrowser.eu (its brand page has the rules):
// - the logo is the word with its sprout on the apex of the A (logo.svg). The
//   word takes the text colour; the sprout is violet, a shade lighter on dark grounds.
// - the mark is Pip with its sprout and two smiling eyes, for where there is
//   no room for the word.
// - the app icon is the mark in white on violet, as the Dock shows it.
// The unofficial branding has no wordmark: its logo is its plain mark with
// the name beside it in the UI font. Both sets of images are generated
// (scripts/app-icons/generate.mjs and unofficial.mjs).

// Only a branding with a wordmark has logo.svg; the glob finds it or nothing.
const LOGO_FILES = import.meta.glob<string>('@branding/renderer/logo.svg', { query: '?raw', import: 'default', eager: true })
const WORDMARK = BRANDING.wordmark ? parseWordmark(Object.values(LOGO_FILES)[0] ?? '') : null

const MARK_SET = `${mark32} 32w, ${mark64} 64w, ${mark128} 128w`

/** The mark alone, `size` CSS pixels square. Decorative: label the thing it sits in. */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }): ReactElement {
  return (
    <img
      className={`apex-pip-mark${className ? ` ${className}` : ''}`}
      src={size <= 16 ? mark32 : size <= 32 ? mark64 : mark128}
      srcSet={MARK_SET}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

/**
 * The logo. `size` is its height in CSS pixels: the wordmark's A stands about
 * 0.6 of it with the sprout above; the name's capitals stand as tall, beside
 * a mark of about the same height.
 */
export function BrandLogo({ size = 24, className }: { size?: number; className?: string }): ReactElement {
  const classes = `apex-logo${className ? ` ${className}` : ''}`
  if (WORDMARK) {
    return (
      <svg className={classes} viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`} width={Math.round((size * WORDMARK.width) / WORDMARK.height)} height={size} role="img" aria-label={BRANDING.name}>
        {WORDMARK.paths.map((p) => (
          <path key={p.className} className={p.className} d={p.d} />
        ))}
      </svg>
    )
  }
  return (
    <span className={`${classes} apex-logo--name`} style={{ height: size, fontSize: Math.round(size * 0.62) }} role="img" aria-label={BRANDING.name}>
      <BrandMark size={Math.round(size * 0.82)} />
      <span className="apex-logo__name" aria-hidden="true">
        {BRANDING.name}
      </span>
    </span>
  )
}

/** The standard app icon, as the Dock shows it. */
export function AppIconImage({ size = 64, className }: { size?: number; className?: string }): ReactElement {
  return <img className={className} src={appIcon128} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
}
