/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { FILE_SCHEME } from '@shared/files'

// apex-file://<token>/<name>: the viewer's images, PDFs and media,
// streamed with range requests so audio and video can seek. Only a live
// viewer token opens anything; the response can't run script or reach out.

const FILE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'; sandbox"

export interface ServedFile {
  path: string | null
  text: string | null
  mediaType: string
}

/** The token in an apex-file URL, or null. Standard schemes lowercase the host, so tokens are lowercase hex. */
export function fileTokenOf(url: string): string | null {
  const m = /^apex-file:\/\/([0-9a-f]{32})(?:\/|$)/.exec(url)
  return m?.[1] ?? null
}

/** A single byte range ("bytes=0-99", "bytes=100-", "bytes=-50"), clamped to the size; null when absent or unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

function headers(mediaType: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': mediaType,
    'content-security-policy': FILE_CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
    ...extra,
  }
}

/** Answers one apex-file request from what the token serves. */
export function serveFile(request: Request, served: ServedFile | null): Response {
  if (!served) return new Response('Not found', { status: 404 })
  if (served.text !== null && !served.path) {
    const body = Buffer.from(served.text)
    return new Response(body, { headers: headers(served.mediaType, { 'content-length': String(body.length) }) })
  }
  let size: number
  try {
    size = statSync(served.path as string).size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'invalid') return new Response(null, { status: 416, headers: headers(served.mediaType, { 'content-range': `bytes */${size}` }) })
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  if (size === 0) return new Response(new Uint8Array(0), { headers: headers(served.mediaType, { 'content-length': '0' }) })
  const stream = Readable.toWeb(createReadStream(served.path as string, { start, end })) as ReadableStream<Uint8Array>
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: headers(served.mediaType, { 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) }),
  })
}

export const FILE_PROTOCOL = FILE_SCHEME
