/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Windows .ico writing and reading. The 256 px image is stored as PNG
// (PNG-in-ICO, Vista and later); smaller ones as 32-bit DIBs with an AND
// mask, which every consumer (Explorer, rcedit, NSIS) reads.

import { encodePNG, decodePNG, isPNG } from './png.mjs'

function encodeDIB(size, rgba) {
  const maskStride = Math.ceil(size / 32) * 4
  const xor = Buffer.alloc(size * size * 4)
  const and = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4
      const d = (row * size + x) * 4
      xor[d] = rgba[s + 2]
      xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]
      xor[d + 3] = rgba[s + 3]
      if (rgba[s + 3] === 0) and[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(size, 4)
  head.writeInt32LE(size * 2, 8)
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  head.writeUInt32LE(0, 16)
  head.writeUInt32LE(xor.length + and.length, 20)
  return Buffer.concat([head, xor, and])
}

function decodeDIB(data) {
  const w = data.readInt32LE(4)
  const h2 = data.readInt32LE(8)
  const bpp = data.readUInt16LE(14)
  if (bpp !== 32) throw new Error('Only 32-bit ICO images are supported')
  const h = h2 / 2
  const rgba = new Uint8Array(w * h * 4)
  const off = data.readUInt32LE(0)
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y
    for (let x = 0; x < w; x++) {
      const s = off + (row * w + x) * 4
      const d = (y * w + x) * 4
      rgba[d] = data[s + 2]
      rgba[d + 1] = data[s + 1]
      rgba[d + 2] = data[s]
      rgba[d + 3] = data[s + 3]
    }
  }
  return { width: w, height: h, pixels: rgba }
}

/**
 * Builds an .ico from [{ size, pixels }] (square RGBA). Images at or above
 * `pngFrom` px are stored as PNG.
 */
export function writeICO(images, pngFrom = 256) {
  const sorted = images.slice().sort((a, b) => a.size - b.size)
  const blobs = sorted.map(({ size, pixels }) => (size >= pngFrom ? encodePNG(size, size, pixels) : encodeDIB(size, pixels)))
  const dir = Buffer.alloc(6 + 16 * sorted.length)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(sorted.length, 4)
  let offset = dir.length
  sorted.forEach(({ size }, i) => {
    const e = 6 + 16 * i
    dir[e] = size >= 256 ? 0 : size
    dir[e + 1] = size >= 256 ? 0 : size
    dir[e + 2] = 0
    dir[e + 3] = 0
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(blobs[i].length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += blobs[i].length
  })
  return Buffer.concat([dir, ...blobs])
}

/** Parses an .ico into [{ width, height, png, pixels }]. */
export function readICO(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('Not an ico file')
  const count = buf.readUInt16LE(4)
  const out = []
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i
    const dw = buf[e] || 256
    const dh = buf[e + 1] || 256
    const length = buf.readUInt32LE(e + 8)
    const offset = buf.readUInt32LE(e + 12)
    if (offset + length > buf.length) throw new Error('ico entry runs past the end of the file')
    const data = buf.subarray(offset, offset + length)
    const png = isPNG(data)
    const img = png ? decodePNG(data) : decodeDIB(data)
    if (img.width !== dw || img.height !== dh) throw new Error(`ico directory says ${dw}×${dh}, image is ${img.width}×${img.height}`)
    out.push({ width: img.width, height: img.height, png, pixels: img.pixels, bitCount: buf.readUInt16LE(e + 6) })
  }
  return out
}
