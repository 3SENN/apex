/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS, LONG_PASTE, fitWithin, isLongPaste } from '../src/shared/attachments'
import { decodeUtf8, isSvgText, officeKind, previewableOf, sniff } from '../src/main/intake/detect'
import { exifSegment, hasExif, hasGps, insertSegment, jpegOrientation, jpegSegments, orientedSize } from '../src/main/intake/exif'
import { IntakeError, fileRefusal, prepareFile, prepareText, type PrepareDeps } from '../src/main/intake/prepare'
import { PREPROCESS_CSP, preprocessAllow, preprocessFile } from '../src/main/intake/preprocess'
import { capBytes, capText, cleanName, countLines, excerpt, selectionText } from '../src/main/intake/text'
import { buildDocx, buildPdf, executableBytes, SVG_FIXTURE } from '../src/main/smokeFilesConnectors/intakeFixtures'

// CH-22, CH-23: what a file is from its bytes, the limits and
// their reasons, the EXIF and orientation rules, text rules, and the hidden
// renderer's locked-down partition.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
/** The smallest JPEG shape the segment reader accepts: SOI, an APP0, then start of scan. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9])
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('sniff: magic bytes, never the extension', () => {
  it('recognises images whatever they are called', () => {
    expect(sniff(PNG, 'notes.txt')).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(sniff(JPEG, 'a')).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(sniff(bytes('GIF89a....'), 'x')).toEqual({ kind: 'image', mediaType: 'image/gif' })
    expect(sniff(bytes('RIFF\0\0\0\0WEBPVP8 '), 'x')).toEqual({ kind: 'image', mediaType: 'image/webp' })
    const bmp = new Uint8Array(40)
    bmp.set([0x42, 0x4d])
    bmp[14] = 40
    expect(sniff(bmp, 'x').kind).toBe('image')
    expect(sniff(bytes('BM is how this note starts'), 'x').kind).toBe('text')
  })

  it('tells HEIC, PDF, SVG and Office apart', () => {
    expect(sniff(bytes('\0\0\0\x18ftypheic\0\0\0\0'), 'x.jpg')).toEqual({ kind: 'heic', mediaType: 'image/heic' })
    expect(sniff(buildPdf(1), 'report.txt').kind).toBe('pdf')
    expect(sniff(bytes(SVG_FIXTURE), 'pic.txt').kind).toBe('svg')
    expect(sniff(buildDocx(), 'renamed.zip')).toEqual({ kind: 'office', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    expect(officeKind(buildDocx())).toBe('docx')
  })

  it('refuses executables and archives, even renamed', () => {
    expect(sniff(executableBytes(), 'readme.txt').kind).toBe('unsupported')
    expect(sniff(bytes('\x7fELF\x02\x01\x01'), 'a.md').kind).toBe('unsupported')
    expect(sniff(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'a.docx').kind).toBe('unsupported')
    expect(sniff(new Uint8Array(0), 'a.txt').kind).toBe('empty')
  })

  it('keeps text a text file, with the name refining its media type', () => {
    expect(sniff(bytes('# Title\n'), 'readme.md')).toEqual({ kind: 'text', mediaType: 'text/markdown' })
    expect(sniff(bytes('a,b\n1,2\n'), 'table.csv')).toEqual({ kind: 'text', mediaType: 'text/csv' })
    expect(sniff(bytes('This note mentions %PDF- early\nbut is text'), 'note.txt').kind).toBe('text')
    expect(sniff(Uint8Array.from([0xc3, 0x28]), 'bad.txt').kind).toBe('unsupported')
    expect(decodeUtf8(bytes('﻿hi'))).toBe('hi')
    expect(decodeUtf8(Uint8Array.from([0x68, 0, 0x69]))).toBeNull()
    expect(isSvgText('<!-- art -->\n<svg viewBox="0 0 1 1"/>')).toBe(true)
    expect(isSvgText('<html><svg/></html>')).toBe(false)
  })

  it('previews by media type', () => {
    expect(previewableOf('image/svg+xml', 10)).toBe('svg')
    expect(previewableOf('text/csv', 10)).toBe('sheet')
    expect(previewableOf('application/json', 10)).toBe('code')
    expect(previewableOf('text/plain', 0)).toBe('empty')
  })
})

describe('limits and reasons', () => {
  it('refuses oversized files of each type before reading them', () => {
    expect(fileRefusal({ kind: 'image', mediaType: 'image/png' }, ATTACHMENT_LIMITS.imageInputBytes + 1)).toMatch(/30 MB/)
    expect(fileRefusal({ kind: 'pdf', mediaType: 'application/pdf' }, ATTACHMENT_LIMITS.pdfBytes + 1)).toBeTruthy()
    expect(fileRefusal({ kind: 'text', mediaType: 'text/plain' }, ATTACHMENT_LIMITS.textBytes + 1)).toBeTruthy()
    expect(fileRefusal({ kind: 'office', mediaType: 'x' }, ATTACHMENT_LIMITS.officeBytes + 1)).toBeTruthy()
    expect(fileRefusal({ kind: 'text', mediaType: 'text/plain' }, 10)).toBeNull()
    expect(fileRefusal({ kind: 'unsupported' }, 10)).toBe(`${BRAND_NAME} can't read this kind of file`)
  })

  it('has the contract limits', () => {
    expect(ATTACHMENT_LIMITS.perMessage).toBe(20)
    expect(ATTACHMENT_LIMITS.requestBytes).toBe(32_000_000)
    expect(ATTACHMENT_LIMITS.imageLongEdge).toBe(1568)
  })
})

describe('prepareFile', () => {
  const fakeImages = (): PrepareDeps['images'] => ({
    prepareImage: async () => ({ bytes: new Uint8Array(5), mediaType: 'image/jpeg', width: 10, height: 20, thumbnail: 'data:image/webp;base64,AA==' }),
    rasterizeSvg: async () => ({ bytes: new Uint8Array(7), mediaType: 'image/png', width: 40, height: 20, thumbnail: null }),
    pdfThumbnail: async () => null,
    dispose: () => {},
  })
  const deps = (over: Partial<PrepareDeps> = {}): PrepareDeps => ({
    images: fakeImages(),
    pdf: { read: async () => ({ ok: true, pages: 3, text: 'x' }) },
    heic: () => null,
    documentsOn: () => false,
    pdfMaxPages: () => 600,
    platform: 'darwin',
    ...over,
  })
  const input = (name: string, data: Uint8Array) => ({ chatId: 'c', name, bytes: data, originalPath: '/nope' })

  it('re-encodes images and rasterizes SVG to PNG', async () => {
    expect(await prepareFile(input('a.png', PNG), deps())).toMatchObject({ kind: 'image', mediaType: 'image/png', size: 5, image: { mediaType: 'image/jpeg' } })
    expect(await prepareFile(input('a.svg', bytes(SVG_FIXTURE)), deps())).toMatchObject({ kind: 'image', mediaType: 'image/svg+xml', image: { mediaType: 'image/png' } })
  })

  it('needs Files and documents for office files', async () => {
    await expect(prepareFile(input('a.docx', buildDocx()), deps())).rejects.toThrow('Turn on Files and documents in Settings › Model and key to attach this')
    expect(await prepareFile(input('a.docx', buildDocx()), deps({ documentsOn: () => true }))).toMatchObject({ kind: 'office' })
  })

  it('refuses executables with a reason, and HEIC off macOS', async () => {
    await expect(prepareFile(input('setup.txt', executableBytes()), deps())).rejects.toBeInstanceOf(IntakeError)
    await expect(prepareFile(input('a.heic', bytes('\0\0\0\x18ftypheic\0\0\0\0')), deps({ platform: 'linux' }))).rejects.toBeInstanceOf(IntakeError)
  })

  it('counts pages and lines', async () => {
    expect(await prepareFile(input('a.pdf', buildPdf(3)), deps())).toMatchObject({ kind: 'pdf', pages: 3 })
    expect(await prepareFile(input('a.ts', bytes('one\ntwo\nthree\n')), deps())).toMatchObject({ kind: 'text', lines: 3 })
  })

  it('a decoding failure becomes a plain reason', async () => {
    const broken = deps({ images: { ...fakeImages(), prepareImage: async () => Promise.reject(new Error('decode')) } })
    await expect(prepareFile(input('a.png', PNG), broken)).rejects.toBeInstanceOf(IntakeError)
  })
})

describe('EXIF and orientation', () => {
  it('reads orientation and GPS, and finds no EXIF once re-encoded', () => {
    const tagged = insertSegment(JPEG, exifSegment({ orientation: 6, gps: true }))
    expect(hasExif(tagged)).toBe(true)
    expect(jpegOrientation(tagged)).toBe(6)
    expect(hasGps(tagged)).toBe(true)
    expect(jpegSegments(tagged).some((s) => s.marker === 0xe1)).toBe(true)
    expect(hasExif(JPEG)).toBe(false)
    expect(jpegOrientation(JPEG)).toBe(1)
    expect(hasGps(insertSegment(JPEG, exifSegment({ orientation: 3 })))).toBe(false)
  })

  it('turns sizes a quarter for orientations 5 to 8', () => {
    expect(orientedSize(400, 200, 6)).toEqual({ width: 200, height: 400 })
    expect(orientedSize(400, 200, 3)).toEqual({ width: 400, height: 200 })
  })

  it('downscales to the long edge and the pixel budget', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
    const wide = fitWithin(4000, 1000)
    expect(Math.max(wide.width, wide.height)).toBeLessThanOrEqual(1568)
    const big = fitWithin(2000, 2000)
    expect(big.width * big.height).toBeLessThanOrEqual(ATTACHMENT_LIMITS.imageMaxPixels)
    expect(fitWithin(0, 10)).toEqual({ width: 0, height: 0 })
  })
})

describe('text rules', () => {
  it('counts lines as an editor does', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb\nc')).toBe(3)
  })

  it('treats long pastes as chips past either threshold', () => {
    expect(isLongPaste('x'.repeat(LONG_PASTE.chars))).toBe(true)
    expect(isLongPaste('x'.repeat(LONG_PASTE.chars - 1))).toBe(false)
    expect(isLongPaste(Array.from({ length: LONG_PASTE.lines }, (_, i) => `${i}`).join('\n'))).toBe(true)
    expect(isLongPaste('short\npaste')).toBe(false)
  })

  it('refuses an oversized paste but cuts fetched text', () => {
    const huge = 'x'.repeat(ATTACHMENT_LIMITS.textBytes + 10)
    expect(() => prepareText('paste', huge)).toThrow(IntakeError)
    const tab = prepareText('tab', huge)
    expect(tab.size).toBeLessThanOrEqual(ATTACHMENT_LIMITS.textBytes)
    expect(capBytes('é'.repeat(2000), 1000).truncated).toBe(true)
    expect(capText('short', 100)).toEqual({ text: 'short', truncated: false })
  })

  it('cleans names and frames selections with their source and links', () => {
    expect(cleanName('  a\u0000b  ')).toBe('ab')
    expect(cleanName('')).toBeTruthy()
    expect(excerpt('one   two\nthree', 8)).toBe('one two…')
    const text = selectionText({ text: ' quoted ', url: 'https://x.test/a', title: 'X', links: [{ text: 'More', url: 'https://x.test/b' }] })
    expect(text.startsWith('quoted')).toBe(true)
    expect(text).toContain('https://x.test/a')
    expect(text).toContain('- More: https://x.test/b')
  })
})

describe('the preprocessing partition', () => {
  it('cancels every network request and serves only its page', () => {
    expect(preprocessAllow('https://example.com/a.png')).toBe(false)
    expect(preprocessAllow('http://127.0.0.1:9/x')).toBe(false)
    expect(preprocessAllow('file:///etc/passwd')).toBe(false)
    expect(preprocessAllow('blob:app://apex/123')).toBe(true)
    expect(preprocessAllow('data:image/png;base64,AA==')).toBe(true)
    expect(preprocessAllow('http://localhost:5173/preprocess.html', 'http://localhost:5173')).toBe(true)
    expect(preprocessAllow('https://example.com/', 'http://localhost:5173')).toBe(false)
    expect(PREPROCESS_CSP).toContain("default-src 'none'")
    expect(PREPROCESS_CSP).toContain('img-src blob: data:')
  })

  it('maps only the page and its assets to files', () => {
    expect(preprocessFile('/r', 'app://apex/preprocess.html')).toBe(resolve('/r', 'preprocess.html'))
    expect(preprocessFile('/r', 'app://apex/index.html')).toBeNull()
    expect(preprocessFile('/r', 'app://apex/../etc/passwd')).toBeNull()
  })
})
