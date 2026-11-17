/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apple .icns writing and reading. Uses the same entry types iconutil
// writes on current macOS: ARGB (RLE) for 16 and 32 px at 1x, PNG for the
// rest. Written here so the generator also runs on Linux CI.

import { encodePNG, decodePNG, isPNG } from './png.mjs'

/** Entry type → { size: pixel side, scale, label: iconset file name, argb? } */
export const ICNS_TYPES = {
  ic04: { size: 16, scale: 1, label: 'icon_16x16.png', argb: true },
  ic11: { size: 32, scale: 2, label: 'icon_16x16@2x.png' },
  ic05: { size: 32, scale: 1, label: 'icon_32x32.png', argb: true },
  ic12: { size: 64, scale: 2, label: 'icon_32x32@2x.png' },
  ic07: { size: 128, scale: 1, label: 'icon_128x128.png' },
  ic13: { size: 256, scale: 2, label: 'icon_128x128@2x.png' },
  ic08: { size: 256, scale: 1, label: 'icon_256x256.png' },
  ic14: { size: 512, scale: 2, label: 'icon_256x256@2x.png' },
  ic09: { size: 512, scale: 1, label: 'icon_512x512.png' },
  ic10: { size: 1024, scale: 2, label: 'icon_512x512@2x.png' }
}

/** Every icns entry Apex writes, in file order. */
export const ICNS_ORDER = ['ic04', 'ic11', 'ic05', 'ic12', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10']

/** The icns run-length scheme (shared with it32): runs of 3..130, literals of 1..128. */
export function packBits(bytes) {
  const out = []
  let i = 0
  const n = bytes.length
  while (i < n) {
    let run = 1
    while (i + run < n && run < 130 && bytes[i + run] === bytes[i]) run++
    if (run >= 3) {
      out.push(0x80 + run - 3, bytes[i])
      i += run
      continue
    }
    const start = i
    let lit = 0
    while (i < n && lit < 128) {
      if (i + 2 < n && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2]) break
      i++
      lit++
    }
    out.push(lit - 1)
    for (let k = start; k < start + lit; k++) out.push(bytes[k])
  }
  return Buffer.from(out)
}

export function unpackBits(buf, pos, count) {
  const out = new Uint8Array(count)
  let o = 0
  while (o < count) {
    const b = buf[pos++]
    if (b & 0x80) {
      const run = b - 0x80 + 3
      const v = buf[pos++]
      for (let k = 0; k < run && o < count; k++) out[o++] = v
    } else {
      const lit = b + 1
      for (let k = 0; k < lit && o < count; k++) out[o++] = buf[pos++]
    }
  }
  return { bytes: out, pos }
}

function encodeARGB(size, rgba) {
  const n = size * size
  const parts = [Buffer.from('ARGB', 'ascii')]
  for (const c of [3, 0, 1, 2]) {
    const ch = new Uint8Array(n)
    for (let i = 0; i < n; i++) ch[i] = rgba[i * 4 + c]
    parts.push(packBits(ch))
  }
  return Buffer.concat(parts)
}

function decodeARGB(size, data) {
  if (data.toString('ascii', 0, 4) !== 'ARGB') throw new Error('Not an ARGB icns entry')
  const n = size * size
  const rgba = new Uint8Array(n * 4)
  let pos = 4
  for (const c of [3, 0, 1, 2]) {
    const r = unpackBits(data, pos, n)
    pos = r.pos
    for (let i = 0; i < n; i++) rgba[i * 4 + c] = r.bytes[i]
  }
  return rgba
}

/**
 * Builds an .icns from a map of pixel side → RGBA pixels. Every side in
 * ICNS_TYPES must be present.
 */
export function writeICNS(images) {
  const entries = ICNS_ORDER.map((type) => {
    const { size, argb } = ICNS_TYPES[type]
    const px = images.get(size)
    if (!px) throw new Error(`icns needs a ${size} px image`)
    const data = argb ? encodeARGB(size, px) : encodePNG(size, size, px)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(entries)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

/** Parses an .icns into [{ type, size, scale, width, height, pixels }]. */
export function readICNS(buf) {
  if (buf.toString('ascii', 0, 4) !== 'icns') throw new Error('Not an icns file')
  const total = buf.readUInt32BE(4)
  if (total !== buf.length) throw new Error('icns length field does not match the file')
  const out = []
  let pos = 8
  while (pos < total) {
    const type = buf.toString('ascii', pos, pos + 4)
    const length = buf.readUInt32BE(pos + 4)
    if (length < 8 || pos + length > total) throw new Error(`Bad icns entry ${type}`)
    const data = buf.subarray(pos + 8, pos + length)
    const info = ICNS_TYPES[type]
    if (info) {
      if (isPNG(data)) {
        const img = decodePNG(data)
        out.push({ type, size: info.size, scale: info.scale, width: img.width, height: img.height, pixels: img.pixels })
      } else {
        out.push({ type, size: info.size, scale: info.scale, width: info.size, height: info.size, pixels: decodeARGB(info.size, data) })
      }
    } else {
      out.push({ type, size: 0, scale: 0, width: 0, height: 0, pixels: null })
    }
    pos += length
  }
  return out
}
