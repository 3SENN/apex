/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// JPEG EXIF rules, as pure functions. The preprocessing renderer
// applies the orientation while decoding (createImageBitmap 'from-image') and
// re-encodes, which drops every metadata segment; these read and build the
// segments so tests and smoke can prove the result has no EXIF or GPS left.

const SOI = [0xff, 0xd8]

interface Segment {
  marker: number
  /** Offset of the 0xFF that starts the segment. */
  start: number
  /** Offset of the payload (after the length field). */
  data: number
  end: number
}

/** The JPEG's header segments up to the start of scan; empty for anything that isn't a JPEG. */
export function jpegSegments(bytes: Uint8Array): Segment[] {
  if (bytes[0] !== SOI[0] || bytes[1] !== SOI[1]) return []
  const out: Segment[] = []
  let at = 2
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
    if (length < 2) break
    out.push({ marker, start: at, data: at + 4, end: at + 2 + length })
    // Start of scan: entropy-coded data follows, no more header segments.
    if (marker === 0xda) break
    at += 2 + length
  }
  return out
}

function exifPayload(bytes: Uint8Array): Uint8Array | null {
  for (const s of jpegSegments(bytes)) {
    if (s.marker !== 0xe1) continue
    const p = bytes.subarray(s.data, Math.min(s.end, bytes.length))
    if (p[0] === 0x45 && p[1] === 0x78 && p[2] === 0x69 && p[3] === 0x66 && p[4] === 0 && p[5] === 0) return p.subarray(6)
  }
  return null
}

/** Whether a JPEG still carries an EXIF (APP1) segment. */
export function hasExif(bytes: Uint8Array): boolean {
  return exifPayload(bytes) !== null
}

interface Ifd0 {
  orientation: number
  gps: boolean
}

function readIfd0(tiff: Uint8Array): Ifd0 | null {
  if (tiff.length < 8) return null
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null
  const u16 = (at: number): number => (little ? (tiff[at] ?? 0) | ((tiff[at + 1] ?? 0) << 8) : ((tiff[at] ?? 0) << 8) | (tiff[at + 1] ?? 0))
  const u32 = (at: number): number => (little ? u16(at) + u16(at + 2) * 0x10000 : u16(at) * 0x10000 + u16(at + 2))
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return null
  const count = u16(ifd)
  const result: Ifd0 = { orientation: 1, gps: false }
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > tiff.length) break
    const tag = u16(entry)
    if (tag === 0x0112) result.orientation = u16(entry + 8)
    if (tag === 0x8825) result.gps = true
  }
  return result
}

/** The EXIF orientation (1–8); 1 when there is none or it is out of range. */
export function jpegOrientation(bytes: Uint8Array): number {
  const tiff = exifPayload(bytes)
  const o = tiff ? (readIfd0(tiff)?.orientation ?? 1) : 1
  return o >= 1 && o <= 8 ? o : 1
}

/** Whether a JPEG's EXIF points at GPS data. */
export function hasGps(bytes: Uint8Array): boolean {
  const tiff = exifPayload(bytes)
  return tiff ? (readIfd0(tiff)?.gps ?? false) : false
}

/** The upright size of an image stored as width × height with this orientation (5–8 turn it a quarter). */
export function orientedSize(width: number, height: number, orientation: number): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
}

/**
 * An APP1 EXIF segment with an orientation and, optionally, a GPS position
 * (for tests and smoke fixtures). Big-endian TIFF, IFD0 with one or two
 * entries, and a minimal GPS IFD with a latitude reference.
 */
export function exifSegment(options: { orientation: number; gps?: boolean }): Uint8Array {
  const entries = options.gps ? 2 : 1
  const ifd0Size = 2 + entries * 12 + 4
  const gpsAt = 8 + ifd0Size
  const tiff: number[] = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]
  const u16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff]
  const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  tiff.push(...u16(entries))
  tiff.push(...u16(0x0112), ...u16(3), ...u32(1), ...u16(options.orientation), 0, 0)
  if (options.gps) tiff.push(...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsAt))
  tiff.push(...u32(0))
  // GPS IFD: GPSLatitudeRef 'N'.
  if (options.gps) tiff.push(...u16(1), ...u16(0x0001), ...u16(2), ...u32(2), 0x4e, 0, 0, 0, ...u32(0))
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  return Uint8Array.from([0xff, 0xe1, ...u16(payload.length + 2), ...payload])
}

/** The JPEG with a segment inserted right after its start-of-image marker. */
export function insertSegment(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + segment.length)
  out.set(jpeg.subarray(0, 2), 0)
  out.set(segment, 2)
  out.set(jpeg.subarray(2), 2 + segment.length)
  return out
}
