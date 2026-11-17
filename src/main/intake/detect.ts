/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { unzipSync } from 'fflate'
import type { FilePreviewable } from '@shared/files'

// What a file is, from its bytes (CH-23). The extension is never trusted to
// pick the kind: a renamed .exe stays unreadable and a .txt holding a PNG is
// an image. The name only refines the media type of text, so a .md previews
// as Markdown.

export type Sniffed =
  | { kind: 'image'; mediaType: string }
  | { kind: 'heic'; mediaType: 'image/heic' }
  | { kind: 'svg'; mediaType: 'image/svg+xml' }
  | { kind: 'pdf'; mediaType: 'application/pdf' }
  | { kind: 'office'; mediaType: string }
  | { kind: 'text'; mediaType: string }
  | { kind: 'empty' }
  | { kind: 'unsupported' }

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b)
const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to))
const u32le = (b: Uint8Array, at: number): number => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0

/** Raster formats Chromium decodes in the preprocessing renderer. */
const IMAGE_SIGNATURES: readonly { sig: readonly number[]; at?: number; mediaType: string; check?: (b: Uint8Array) => boolean }[] = [
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mediaType: 'image/png' },
  { sig: [0xff, 0xd8, 0xff], mediaType: 'image/jpeg' },
  { sig: [0x47, 0x49, 0x46, 0x38], mediaType: 'image/gif', check: (b) => b[4] === 0x37 || b[4] === 0x39 },
  { sig: [0x52, 0x49, 0x46, 0x46], mediaType: 'image/webp', check: (b) => ascii(b, 8, 12) === 'WEBP' },
  // "BM" alone could start a text file; a real bitmap names a known DIB header size at byte 14.
  { sig: [0x42, 0x4d], mediaType: 'image/bmp', check: (b) => b.length > 26 && [12, 40, 52, 56, 64, 108, 124].includes(u32le(b, 14)) },
]

/** ISO-BMFF brands: HEIF/HEIC (macOS decodes them) and AVIF (Chromium does). */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])

/** Programs and archives Apex never reads, whatever they are called. */
const EXECUTABLE_SIGNATURES: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0xca, 0xfe, 0xba, 0xbe], // universal Mach-O (and Java classes)
]

export const OFFICE_MEDIA = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const

/** Text media types by extension; anything else valid UTF-8 is text/plain. */
const TEXT_MEDIA: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  log: 'text/plain',
  txt: 'text/plain',
}

const CODE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash', 'sql', 'css', 'scss', 'lua', 'r', 'scala', 'toml', 'ini', 'vue', 'svelte'])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The media type of a text file, from its name (the bytes already proved it is text). */
export function textMediaType(name: string): string {
  const ext = extensionOf(name)
  if (TEXT_MEDIA[ext]) return TEXT_MEDIA[ext]
  return CODE_EXTENSIONS.has(ext) ? 'text/x-source' : 'text/plain'
}

/** Strict UTF-8 without NUL bytes, or null. A leading BOM is dropped. `partial` allows a cut-off last character (a file's head). */
export function decodeUtf8(bytes: Uint8Array, partial = false): string | null {
  if (bytes.includes(0)) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial })
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return null
  }
}

/** An SVG document: optional BOM, XML declaration, comments or doctype, then <svg. */
export function isSvgText(text: string): boolean {
  const head = text.slice(0, 4096).replace(/^﻿/, '')
  return /^\s*(<\?xml[^>]*\?>\s*)?((<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>]/i.test(head)
}

/** Which Office Open XML document a zip is, from its entry names; null for any other zip. */
export function officeKind(bytes: Uint8Array): keyof typeof OFFICE_MEDIA | null {
  const names: string[] = []
  try {
    // The filter sees every entry's name and decompresses none of them.
    unzipSync(bytes, {
      filter: (file) => {
        if (names.length < 2000) names.push(file.name)
        return false
      },
    })
  } catch {
    return null
  }
  if (!names.includes('[Content_Types].xml')) return null
  if (names.some((n) => n.startsWith('word/'))) return 'docx'
  if (names.some((n) => n.startsWith('xl/'))) return 'xlsx'
  if (names.some((n) => n.startsWith('ppt/'))) return 'pptx'
  return null
}

/** "MZ" plus the PE header it points at; a text file that merely starts with MZ stays text. */
function isWindowsExecutable(b: Uint8Array): boolean {
  if (!startsWith(b, [0x4d, 0x5a]) || b.length < 64) return false
  const pe = u32le(b, 0x3c)
  return pe + 4 <= b.length ? startsWith(b, [0x50, 0x45, 0, 0], pe) : b.includes(0)
}

/**
 * A PDF header within the first KB (pdf.js accepts junk before it) and an
 * end-of-file marker near the end, so a text file that mentions "%PDF-"
 * early on stays text.
 */
function isPdf(b: Uint8Array): boolean {
  const at = ascii(b, 0, Math.min(b.length, 1024)).indexOf('%PDF-')
  if (at === 0) return true
  if (at < 0) return false
  const tail = ascii(b, Math.max(0, b.length - 2048), b.length)
  return tail.includes('%%EOF') || tail.includes('startxref')
}

/** `partial`: only the file's head is given, so text may end mid-character and a zip's directory is missing. */
export function sniff(bytes: Uint8Array, name: string, partial = false): Sniffed {
  if (bytes.length === 0) return { kind: 'empty' }
  for (const s of IMAGE_SIGNATURES) {
    if (startsWith(bytes, s.sig, s.at) && (!s.check || s.check(bytes))) return { kind: 'image', mediaType: s.mediaType }
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (HEIC_BRANDS.has(brand)) return { kind: 'heic', mediaType: 'image/heic' }
    if (AVIF_BRANDS.has(brand)) return { kind: 'image', mediaType: 'image/avif' }
  }
  if (isPdf(bytes)) return { kind: 'pdf', mediaType: 'application/pdf' }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // A head alone can't show the zip's entries; the whole file decides later.
    if (partial) return { kind: 'office', mediaType: 'application/zip' }
    const office = officeKind(bytes)
    return office ? { kind: 'office', mediaType: OFFICE_MEDIA[office] } : { kind: 'unsupported' }
  }
  if (EXECUTABLE_SIGNATURES.some((sig) => startsWith(bytes, sig)) || isWindowsExecutable(bytes)) return { kind: 'unsupported' }
  const text = decodeUtf8(bytes, partial)
  if (text === null) return { kind: 'unsupported' }
  if (isSvgText(text)) return { kind: 'svg', mediaType: 'image/svg+xml' }
  return { kind: 'text', mediaType: textMediaType(name) }
}

/** How the chat files browser and the viewer preview a media type. */
export function previewableOf(mediaType: string, size: number): FilePreviewable {
  if (size === 0) return 'empty'
  if (mediaType === 'image/svg+xml') return 'svg'
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType === 'text/markdown') return 'markdown'
  if (mediaType === 'text/html') return 'html'
  if (mediaType === 'text/csv' || mediaType === 'text/tab-separated-values' || mediaType === OFFICE_MEDIA.xlsx) return 'sheet'
  if (mediaType === 'text/x-source' || mediaType === 'application/json' || mediaType === 'application/xml' || mediaType === 'application/yaml') return 'code'
  if (mediaType.startsWith('text/')) return 'text'
  if (mediaType === 'application/octet-stream' || mediaType.startsWith('application/vnd.')) return 'binary'
  return 'unknown'
}
