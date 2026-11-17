/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// 24-bit Windows BMP, the format NSIS wants for installer sidebar art.

export function writeBMP24(width, height, rgb) {
  const stride = Math.ceil((width * 3) / 4) * 4
  const size = 54 + stride * height
  const buf = Buffer.alloc(size)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(size, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(0, 30)
  buf.writeUInt32LE(stride * height, 34)
  buf.writeInt32LE(2835, 38) // 72 dpi
  buf.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3
      buf[row + x * 3] = rgb[s + 2]
      buf[row + x * 3 + 1] = rgb[s + 1]
      buf[row + x * 3 + 2] = rgb[s]
    }
  }
  return buf
}

/** Reads a 24-bit BMP into RGBA pixels. */
export function readBMP24(buf) {
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('Not a BMP')
  const off = buf.readUInt32LE(10)
  const width = buf.readInt32LE(18)
  const height = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  if (bpp !== 24 || height <= 0) throw new Error('Only bottom-up 24-bit BMPs are supported')
  const stride = Math.ceil((width * 3) / 4) * 4
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = off + (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4
      pixels[d] = buf[row + x * 3 + 2]
      pixels[d + 1] = buf[row + x * 3 + 1]
      pixels[d + 2] = buf[row + x * 3]
      pixels[d + 3] = 255
    }
  }
  return { width, height, bitCount: bpp, pixels }
}
