/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import type { Companion } from '@shared/companion'
import { companionImage } from '../components/companionData'
import { shareColors, shareLayout } from './logic/share'

// The share image saved next to an exported .ateliercompanion file: the
// companion rendered off-screen (the same path as thumbnails and the Dock
// icon) on a soft dotted wash of its own colours, with its name.

const FONT = '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The companion image could not be drawn.'))
    img.src = src
  })
}

/** A PNG data URL, about 1200×630. Rejects when the companion can't be drawn; callers export without it. */
export async function renderShareImage(companion: Companion): Promise<string> {
  const layout = shareLayout(companion.name)
  const colors = shareColors(companion.look.colors.accent, companion.look.colors.outfit)
  const [figure] = await Promise.all([
    companionImage(companion.look, layout.figure.size, 'happy').then(loadImage),
    document.fonts?.load(`700 64px ${FONT}`).catch(() => undefined),
  ])
  const canvas = document.createElement('canvas')
  canvas.width = layout.width
  canvas.height = layout.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Drawing is unavailable.')

  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.fillStyle = colors.dots
  for (let y = layout.dotSpacing / 2; y < layout.height; y += layout.dotSpacing) {
    for (let x = layout.dotSpacing / 2; x < layout.width; x += layout.dotSpacing) {
      ctx.beginPath()
      ctx.arc(x, y, 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const { x, y, size } = layout.figure
  const glow = ctx.createRadialGradient(x + size / 2, y + size * 0.55, size * 0.05, x + size / 2, y + size * 0.55, size * 0.55)
  glow.addColorStop(0, colors.wash)
  glow.addColorStop(1, `${colors.wash}00`)
  ctx.fillStyle = glow
  ctx.fillRect(x, y, size, size)
  ctx.drawImage(figure, x, y, size, size)

  // Shrink the name until it fits on one line.
  let fontSize = layout.name.size
  ctx.font = `700 ${fontSize}px ${FONT}`
  while (fontSize > 32 && ctx.measureText(companion.name).width > layout.name.maxWidth) {
    fontSize -= 4
    ctx.font = `700 ${fontSize}px ${FONT}`
  }
  ctx.fillStyle = colors.text
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(companion.name, layout.name.x, layout.name.y, layout.name.maxWidth)
  ctx.font = `500 ${layout.caption.size}px ${FONT}`
  ctx.fillStyle = colors.caption
  ctx.fillText(`A companion for ${BRAND_NAME}`, layout.caption.x, layout.caption.y, layout.name.maxWidth)
  return canvas.toDataURL('image/png')
}
