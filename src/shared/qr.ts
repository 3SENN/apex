/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import qrcode from 'qrcode-generator'

// QR codes for "this page". The matrix comes from qrcode-generator;
// Atelier draws it itself: an SVG for the card, and a raw bitmap main turns
// into a PNG for Copy and Save. The code is always dark on white, whatever
// the theme, because scanners need that contrast.

/** Quiet zone around the code, in modules (the standard asks for four). */
export const QR_MARGIN = 4

/** The longest text the card encodes; longer addresses are refused. */
export const QR_MAX_TEXT = 2000

/** Encodes as UTF-8: the library's byte mode takes one char per byte. */
function utf8Binary(text: string): string {
  let out = ''
  for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte)
  return out
}

/** The code's modules, row by row; true is dark. Throws when the text is empty or too long. */
export function qrMatrix(text: string): boolean[][] {
  if (!text) throw new Error('Nothing to encode.')
  if (text.length > QR_MAX_TEXT) throw new Error('This address is too long for a QR code.')
  const code = qrcode(0, 'M')
  code.addData(utf8Binary(text), 'Byte')
  code.make()
  const n = code.getModuleCount()
  return Array.from({ length: n }, (_, row) => Array.from({ length: n }, (_, col) => code.isDark(row, col)))
}

/** An SVG of the matrix: one path of unit squares on a white ground, scalable. */
export function qrSvg(matrix: readonly (readonly boolean[])[], margin = QR_MARGIN): string {
  const n = matrix.length
  const size = n + margin * 2
  let path = ''
  matrix.forEach((row, y) => {
    // Runs of dark modules become one rectangle each, which keeps the path short.
    let x = 0
    while (x < n) {
      if (!row[x]) {
        x++
        continue
      }
      let end = x
      while (end < n && row[end]) end++
      path += `M${x + margin} ${y + margin}h${end - x}v1h-${end - x}z`
      x = end
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** The page's QR code as an SVG data URL. */
export function qrDataUrl(text: string): string {
  return svgDataUrl(qrSvg(qrMatrix(text)))
}

/**
 * A BGRA bitmap of the matrix at `scale` px per module, for
 * nativeImage.createFromBitmap (main's Copy and Save).
 */
export function qrBitmap(matrix: readonly (readonly boolean[])[], scale = 8, margin = QR_MARGIN): { width: number; height: number; data: Uint8Array } {
  const n = matrix.length
  const side = (n + margin * 2) * scale
  const data = new Uint8Array(side * side * 4).fill(255)
  for (let y = 0; y < n; y++) {
    const row = matrix[y]
    if (!row) continue
    for (let x = 0; x < n; x++) {
      if (!row[x]) continue
      for (let dy = 0; dy < scale; dy++) {
        const py = (y + margin) * scale + dy
        let i = (py * side + (x + margin) * scale) * 4
        for (let dx = 0; dx < scale; dx++, i += 4) {
          data[i] = 0
          data[i + 1] = 0
          data[i + 2] = 0
          data[i + 3] = 255
        }
      }
    }
  }
  return { width: side, height: side, data }
}
