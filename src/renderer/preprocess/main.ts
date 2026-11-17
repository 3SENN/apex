/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The preprocessing renderer's entry. Main drives it with
// executeJavaScript: image orientation, downscaling to
// ATTACHMENT_LIMITS.imageLongEdge, EXIF removal by re-encoding, SVG
// rasterization and thumbnails. The page is sandboxed, has no
// preload, and its partition cancels every network request, so a hostile
// file can only fail to decode here.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fitWithin, THUMBNAIL_MAX_BYTES } from '@shared/attachments'

interface Prepared {
  base64: string
  mediaType: string
  width: number
  height: number
  /** data:image/webp, at most THUMBNAIL_MAX_BYTES. */
  thumbnail: string
}

interface PreprocessApi {
  version: 1
  /** Resolves to the prepared image and its webp thumbnail. */
  prepareImage(input: { base64: string; mediaType: string; longEdge: number; maxPixels: number }): Promise<Prepared>
  rasterizeSvg(input: { text: string; longEdge: number; maxPixels: number }): Promise<Prepared>
  /** The first page of a PDF as a thumbnail. */
  pdfThumbnail(input: { base64: string }): Promise<{ thumbnail: string }>
}

/** Vector art has no natural resolution worth keeping; it is drawn this large (then capped). */
const SVG_TARGET_EDGE = 1024
const THUMB_EDGE = 160
const JPEG_QUALITY = 0.85

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('encode failed'))
    reader.readAsDataURL(blob)
  })
}

const base64Of = async (blob: Blob): Promise<string> => (await dataUrlOf(blob)).replace(/^data:[^,]*,/, '')

type Source = ImageBitmap | HTMLImageElement | HTMLCanvasElement

function draw(source: Source, width: number, height: number, background?: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, height)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}

/** Any pixel that isn't fully opaque means the result must stay PNG. */
function hasAlpha(canvas: OffscreenCanvas): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true
  return false
}

/** A small webp for the chip; smaller and rougher until it fits the cap. */
async function thumbnailOf(source: Source, width: number, height: number): Promise<string> {
  for (const [edge, quality] of [[THUMB_EDGE, 0.8], [96, 0.6], [64, 0.4]] as const) {
    const size = fitWithin(width, height, edge, edge * edge)
    const blob = await draw(source, size.width, size.height).convertToBlob({ type: 'image/webp', quality })
    const url = await dataUrlOf(blob)
    if (url.length <= THUMBNAIL_MAX_BYTES) return url
  }
  return ''
}

const MAY_HAVE_ALPHA = new Set(['image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'])

async function prepareImage(input: { base64: string; mediaType: string; longEdge: number; maxPixels: number }): Promise<Prepared> {
  const blob = new Blob([bytesOf(input.base64)], { type: input.mediaType })
  // 'from-image' applies the EXIF orientation; re-encoding below drops EXIF and GPS.
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, input.longEdge, input.maxPixels)
    const canvas = draw(bitmap, width, height)
    const alpha = MAY_HAVE_ALPHA.has(input.mediaType) && hasAlpha(canvas)
    const out = await canvas.convertToBlob(alpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: JPEG_QUALITY })
    return { base64: await base64Of(out), mediaType: alpha ? 'image/png' : 'image/jpeg', width, height, thumbnail: await thumbnailOf(bitmap, bitmap.width, bitmap.height) }
  } finally {
    bitmap.close()
  }
}

async function rasterizeSvg(input: { text: string; longEdge: number; maxPixels: number }): Promise<Prepared> {
  // An <img> never runs an SVG's scripts or loads what it references.
  const url = URL.createObjectURL(new Blob([input.text], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    let w = img.naturalWidth || SVG_TARGET_EDGE
    let h = img.naturalHeight || SVG_TARGET_EDGE
    const grow = SVG_TARGET_EDGE / Math.max(w, h)
    if (grow > 1) {
      w = Math.round(w * grow)
      h = Math.round(h * grow)
    }
    const { width, height } = fitWithin(w, h, input.longEdge, input.maxPixels)
    const canvas = draw(img, width, height)
    const out = await canvas.convertToBlob({ type: 'image/png' })
    return { base64: await base64Of(out), mediaType: 'image/png', width, height, thumbnail: await thumbnailOf(img, width, height) }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function pdfThumbnail(input: { base64: string }): Promise<{ thumbnail: string }> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  // pdf.js 6 never evaluates code; glyphs are drawn as paths, so no font loads either.
  const task = pdfjs.getDocument({ data: bytesOf(input.base64), disableFontFace: true, useSystemFonts: false, useWasm: false, verbosity: 0 })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: (THUMB_EDGE * 2) / Math.max(base.width, base.height) })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    // Paper is white in both themes: this is the page itself, not Atelier's UI.
    await page.render({ canvas, viewport, background: '#ffffff' }).promise
    return { thumbnail: await thumbnailOf(canvas, canvas.width, canvas.height) }
  } finally {
    await task.destroy()
  }
}

const api: PreprocessApi = { version: 1, prepareImage, rasterizeSvg, pdfThumbnail }

;(globalThis as unknown as { atelierPreprocess: PreprocessApi }).atelierPreprocess = api
