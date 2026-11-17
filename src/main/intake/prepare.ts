/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ATTACHMENT_LIMITS, type AttachmentKind } from '@shared/attachments'
import { mainT } from '../i18n/mainT'
import type { PdfReader } from '../pdf/client'
import { decodeUtf8, sniff, type Sniffed } from './detect'
import { capBytes, countLines } from './text'

// Turns an attachment's bytes or text into what a request carries (CH-22,
// CH-23). Images and SVGs go to the hidden
// preprocessing renderer, PDFs to a worker thread; everything here only
// decides, checks limits and words the reasons.

/** A failure the chip shows as is: the message is already in Apex's words. */
export class IntakeError extends Error {
  override name = 'IntakeError'
}

/** The hidden renderer's work, as main sees it (preprocess.ts). */
export interface ImageProcessor {
  prepareImage(bytes: Uint8Array, mediaType: string): Promise<ImageResult>
  rasterizeSvg(text: string): Promise<ImageResult>
  /** A first-page thumbnail, or null when it can't be drawn. */
  pdfThumbnail(bytes: Uint8Array): Promise<string | null>
  dispose(): void
}

export interface ImageResult {
  bytes: Uint8Array
  mediaType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  /** data:image/webp, or null. */
  thumbnail: string | null
}

export interface PrepareDeps {
  images: ImageProcessor
  pdf: PdfReader
  /** macOS decodes HEIC through NSImage; JPEG bytes, or null where it can't. */
  heic(path: string): Uint8Array | null
  /** Whether the Files and documents ability is on for this chat (office files need it). */
  documentsOn(chatId: string): boolean
  /** The PDF page cap for this chat's model. */
  pdfMaxPages(chatId: string): number
  platform: NodeJS.Platform
}

/** What preparation produced; the store saves it next to the original. */
export interface Prepared {
  kind: AttachmentKind
  /** The original's type, as the chip and viewer describe it. */
  mediaType: string
  /** The re-encoded image the request carries (prepared.jpg or prepared.png). */
  image?: { bytes: Uint8Array; mediaType: string }
  /** Text the request (or an engine that needs text) carries: prepared.txt. */
  text?: string
  thumbnail: string | null
  /** Bytes the request will carry. */
  size: number
  lines?: number
  pages?: number
}

const reason = (key: Parameters<typeof mainT>[0], vars?: Parameters<typeof mainT>[1]): IntakeError => new IntakeError(mainT(key, vars))

/** The page cap: 100 for models with a 200k context, 600 otherwise. */
export function pdfPageLimit(model: string): number {
  return /haiku/i.test(model) ? ATTACHMENT_LIMITS.pdfPagesSmallContext : ATTACHMENT_LIMITS.pdfPages
}

/**
 * Why a file can't be attached, from its type and size alone (checked before
 * anything is saved or decoded); null when it may go on. Office files also
 * need the Files and documents ability, checked while preparing.
 */
export function fileRefusal(type: Sniffed, size: number): string | null {
  switch (type.kind) {
    case 'empty':
      return mainT('intake.reason.empty')
    case 'unsupported':
      return mainT('intake.reason.unsupported')
    case 'image':
    case 'heic':
    case 'svg':
      return size > ATTACHMENT_LIMITS.imageInputBytes ? mainT('intake.reason.imageTooLarge') : null
    case 'pdf':
      return size > ATTACHMENT_LIMITS.pdfBytes ? mainT('intake.reason.pdfTooLarge') : null
    case 'office':
      return size > ATTACHMENT_LIMITS.officeBytes ? mainT('intake.reason.officeTooLarge') : null
    case 'text':
      return size > ATTACHMENT_LIMITS.textBytes ? mainT('intake.reason.textTooLarge') : null
  }
}

/** A file, a pasted or dropped image, or a page download: sniffed, checked and prepared. */
export async function prepareFile(input: { chatId: string; name: string; bytes: Uint8Array; originalPath: string }, deps: PrepareDeps): Promise<Prepared> {
  const { bytes } = input
  const type = sniff(bytes, input.name)
  const refused = fileRefusal(type, bytes.length)
  if (refused) throw new IntakeError(refused)
  switch (type.kind) {
    case 'empty':
      throw reason('intake.reason.empty')
    case 'unsupported':
      throw reason('intake.reason.unsupported')
    case 'image':
    case 'heic': {
      let source = bytes
      let sourceType: string = type.mediaType
      if (type.kind === 'heic') {
        if (deps.platform !== 'darwin') throw reason('intake.reason.heicUnsupported')
        const jpeg = deps.heic(input.originalPath)
        if (!jpeg) throw reason('intake.reason.imageBroken')
        source = jpeg
        sourceType = 'image/jpeg'
      }
      const image = await deps.images.prepareImage(source, sourceType).catch(() => {
        throw reason('intake.reason.imageBroken')
      })
      return { kind: 'image', mediaType: type.mediaType, image: { bytes: image.bytes, mediaType: image.mediaType }, thumbnail: image.thumbnail, size: image.bytes.length }
    }
    case 'svg': {
      const text = decodeUtf8(bytes) ?? ''
      const image = await deps.images.rasterizeSvg(text).catch(() => {
        throw reason('intake.reason.imageBroken')
      })
      return { kind: 'image', mediaType: type.mediaType, image: { bytes: image.bytes, mediaType: image.mediaType }, thumbnail: image.thumbnail, size: image.bytes.length }
    }
    case 'pdf': {
      const pdf = await preparePdfText(bytes, deps.pdfMaxPages(input.chatId), deps.pdf)
      const thumbnail = await deps.images.pdfThumbnail(bytes).catch(() => null)
      return { kind: 'pdf', mediaType: type.mediaType, text: pdf.text, pages: pdf.pages, thumbnail, size: bytes.length }
    }
    case 'office': {
      if (!deps.documentsOn(input.chatId)) throw reason('intake.reason.officeOff')
      return { kind: 'office', mediaType: type.mediaType, thumbnail: null, size: bytes.length }
    }
    case 'text': {
      const text = decodeUtf8(bytes) ?? ''
      return { kind: 'text', mediaType: type.mediaType, text, thumbnail: null, size: bytes.length, lines: countLines(text) }
    }
  }
}

/** A PDF's text and page count, or the reason it can't be attached. */
export async function preparePdfText(bytes: Uint8Array, maxPages: number, pdf: PdfReader): Promise<{ text: string; pages: number }> {
  const result = await pdf.read(bytes, maxPages)
  if (result.ok) return { text: result.text, pages: result.pages }
  switch (result.error) {
    case 'encrypted':
      throw reason('intake.reason.pdfEncrypted')
    case 'too-many-pages':
      throw reason('intake.reason.pdfTooManyPages', { pages: result.pages ?? maxPages + 1, max: maxPages })
    case 'timeout':
      throw reason('intake.reason.pdfTimeout')
    default:
      throw reason('intake.reason.pdfBroken')
  }
}

/** Text that arrives as text (pastes, tabs, selections, chats, meetings, records): capped and counted. */
export function prepareText(kind: AttachmentKind, text: string, mediaType = 'text/plain'): Prepared {
  // A paste over the cap is refused (the composer keeps it); fetched content is cut instead.
  if (kind === 'paste' && Buffer.byteLength(text) > ATTACHMENT_LIMITS.textBytes) throw reason('intake.reason.textTooLarge')
  const capped = capBytes(text, ATTACHMENT_LIMITS.textBytes).text
  return { kind, mediaType, text: capped, thumbnail: null, size: Buffer.byteLength(capped), lines: countLines(capped) }
}
