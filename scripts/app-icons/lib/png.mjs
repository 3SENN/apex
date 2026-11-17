/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// PNG encoding and decoding for 8-bit RGBA (colour type 6) and RGB (2).
// The encoder writes only IHDR, sRGB, IDAT and IEND, so the file holds no
// time stamps or tool names.

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Encodes pixels (Uint8Array, rows top to bottom) as a PNG buffer. */
export function encodePNG(width, height, pixels, channels = 4) {
  if (pixels.length !== width * height * channels) throw new Error('Pixel buffer does not match the size')
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  const prev = new Uint8Array(stride)
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride))
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    const up = y === 0 ? prev : pixels.subarray((y - 1) * stride, y * stride)
    // Try each filter; keep the one with the smallest sum of absolute values.
    let best = 0
    let bestScore = Infinity
    for (let f = 0; f < 5; f++) {
      const out = cand[f]
      let score = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels] : 0
        const b = up[i]
        const c = i >= channels ? up[i - channels] : 0
        let v
        if (f === 0) v = row[i]
        else if (f === 1) v = row[i] - a
        else if (f === 2) v = row[i] - b
        else if (f === 3) v = row[i] - ((a + b) >> 1)
        else v = row[i] - paeth(a, b, c)
        v &= 0xff
        out[i] = v
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) {
        bestScore = score
        best = f
      }
    }
    raw[y * (stride + 1)] = best
    Buffer.from(cand[best].buffer, 0, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = deflateSync(raw, { level: 9, memLevel: 9 })
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('sRGB', Buffer.from([0])),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Reads a PNG's width and height from its header. */
export function pngSize(buf) {
  if (!Buffer.from(buf.subarray(0, 8)).equals(SIGNATURE)) throw new Error('Not a PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export function isPNG(buf) {
  return buf.length >= 8 && Buffer.from(buf.subarray(0, 8)).equals(SIGNATURE)
}

/**
 * Decodes an 8-bit, non-interlaced RGB or RGBA PNG into RGBA pixels.
 * Enough for Apex's own files and for checking them.
 */
export function decodePNG(buf) {
  if (!isPNG(buf)) throw new Error('Not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat = []
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colour = data[9]
      if (depth !== 8 || (colour !== 6 && colour !== 2) || data[12] !== 0) {
        throw new Error('Only 8-bit, non-interlaced RGB(A) PNGs are supported')
      }
      channels = colour === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = px.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0
      const b = up ? up[i] : 0
      const c = up && i >= channels ? up[i - channels] : 0
      let v = src[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) v += paeth(a, b, c)
      row[i] = v & 0xff
    }
  }
  if (channels === 4) return { width, height, pixels: px }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i]
    rgba[j + 1] = px[i + 1]
    rgba[j + 2] = px[i + 2]
    rgba[j + 3] = 255
  }
  return { width, height, pixels: rgba }
}
