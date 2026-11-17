/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The share image saved inside and next to a shared .atelierapp (docs/apps.md ›
// Sharing): the app's own still, 1200×630 like a companion's share image,
// with its name on a dark band so it reads on any game's colours. The image
// is a file, not chrome, so its colours are fixed rather than theme tokens.

const SIZE = { width: 1200, height: 630 } as const
const FONT = '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The app’s still could not be drawn.'))
    img.src = src
  })
}

/** Where a still of any shape goes so it covers the image without stretching. */
export function coverRect(w: number, h: number, box: { width: number; height: number } = SIZE): { x: number; y: number; width: number; height: number } {
  const scale = Math.max(box.width / w, box.height / h)
  const width = Math.round(w * scale)
  const height = Math.round(h * scale)
  return { x: Math.round((box.width - width) / 2), y: Math.round((box.height - height) / 2), width, height }
}

/** A PNG data URL; with no still, the name on a plain wash. Rejects when drawing isn't available. */
export async function renderAppShareImage(input: { still: string | null; name: string; caption: string }): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE.width
  canvas.height = SIZE.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Drawing is unavailable.')
  ctx.fillStyle = '#1b1830'
  ctx.fillRect(0, 0, SIZE.width, SIZE.height)
  if (input.still) {
    const img = await loadImage(input.still)
    const r = coverRect(img.naturalWidth || SIZE.width, img.naturalHeight || SIZE.height)
    ctx.drawImage(img, r.x, r.y, r.width, r.height)
  }
  await document.fonts?.load(`700 64px ${FONT}`).catch(() => undefined)
  // A band that darkens toward the bottom, so white text reads over any still.
  const band = ctx.createLinearGradient(0, SIZE.height * 0.55, 0, SIZE.height)
  band.addColorStop(0, 'rgba(15, 12, 30, 0)')
  band.addColorStop(1, 'rgba(15, 12, 30, 0.86)')
  ctx.fillStyle = band
  ctx.fillRect(0, SIZE.height * 0.55, SIZE.width, SIZE.height * 0.45)
  const size = input.name.length > 24 ? 52 : input.name.length > 14 ? 64 : 76
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${size}px ${FONT}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(input.name, 56, SIZE.height - 92, SIZE.width - 112)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)'
  ctx.font = `500 28px ${FONT}`
  ctx.fillText(input.caption, 56, SIZE.height - 46, SIZE.width - 112)
  return canvas.toDataURL('image/png')
}
