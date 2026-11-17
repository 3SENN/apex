/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mixHex } from '@shared/companionLogic'
import { contrastRatio } from '@shared/accent'

// Layout and colours for the share image saved next to an exported
// .apexcompanion file. The image is a file, not chrome, so its colours come
// from the companion's own look rather than the theme tokens.

export const SHARE_SIZE = { width: 1200, height: 630 } as const

export interface ShareLayout {
  width: number
  height: number
  /** The companion's square, rendered off-screen. */
  figure: { x: number; y: number; size: number }
  name: { x: number; y: number; maxWidth: number; size: number }
  caption: { x: number; y: number; size: number }
  dotSpacing: number
}

export function shareLayout(name: string, width: number = SHARE_SIZE.width, height: number = SHARE_SIZE.height): ShareLayout {
  const size = Math.round(height * 0.9)
  const textX = Math.round(width * 0.52)
  const maxWidth = width - textX - Math.round(width * 0.06)
  // Long names step down so they stay on one line.
  const nameSize = name.length > 16 ? 64 : name.length > 10 ? 80 : 96
  return {
    width,
    height,
    figure: { x: Math.round(width * 0.04), y: Math.round((height - size) / 2), size },
    name: { x: textX, y: Math.round(height * 0.5), maxWidth, size: nameSize },
    caption: { x: textX, y: Math.round(height * 0.5) + 56, size: 28 },
    dotSpacing: 28,
  }
}

export interface ShareColors {
  background: string
  wash: string
  dots: string
  text: string
  caption: string
}

/** A pale wash of the companion's accent, with text dark enough to read on it. */
export function shareColors(accent: string, outfit: string): ShareColors {
  const background = mixHex(accent, '#ffffff', 0.86)
  const wash = mixHex(outfit, '#ffffff', 0.7)
  const dots = mixHex(accent, '#ffffff', 0.62)
  let text = mixHex(outfit, '#000000', 0.62)
  if (contrastRatio(text, background) < 4.5) text = '#1b1830'
  return { background, wash, dots, text, caption: mixHex(text, background, 0.35) }
}
