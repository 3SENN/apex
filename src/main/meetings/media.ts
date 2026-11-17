/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createReadStream, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { Session } from 'electron'
import { MEDIA_SCHEME } from '../appProtocol'
import { log } from '../log'

// The atelier-media:// handler: meeting audio and the microphone test, with
// Range support so <audio> can seek. Only two shapes of address are served,
// each confined to its own folder, and only on the chrome and float session
// (the default session); web and profile partitions never get the handler.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The file an atelier-media address names, or null for anything else or anything that escapes its folder. */
export function mediaTarget(url: string, dataDir: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.search || parsed.username || parsed.password || parsed.port) return null
  let base: string
  let file: string
  if (parsed.host === 'meeting') {
    const match = /^\/([^/]+)\/audio$/.exec(parsed.pathname)
    if (!match?.[1] || !UUID.test(match[1])) return null
    base = resolve(dataDir, 'meetings')
    file = join(base, match[1].toLowerCase(), 'audio.m4a')
  } else if (parsed.host === 'speech' && parsed.pathname === '/test') {
    base = resolve(dataDir, 'speech')
    file = join(base, 'test.m4a')
  } else {
    return null
  }
  const target = resolve(file)
  return target.startsWith(base + sep) ? target : null
}

/**
 * One `bytes=` range against a file of `size` bytes: null for no (or an
 * ignorable) header, 'unsatisfiable' for a 416. Only single ranges; a
 * multi-range request gets the whole file, which browsers accept.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, a = '', b = ''] = match
  if (a === '' && b === '') return null
  let start: number
  let end: number
  if (a === '') {
    // A suffix: the last N bytes.
    const n = Number(b)
    if (n === 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/** Builds the response for a request; exported so tests can drive it without Electron. */
export function mediaResponse(url: string, rangeHeader: string | null, dataDir: string): Response {
  const file = mediaTarget(url, dataDir)
  if (!file) return new Response('Not found', { status: 404 })
  let size: number
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return new Response('Not found', { status: 404 })
    size = stat.size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const headers: Record<string, string> = {
    'content-type': 'audio/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  const range = parseRange(rangeHeader, size)
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  const body = length === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>)
  headers['content-length'] = String(length)
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** Serves atelier-media on one session (the chrome and floats share the default one). Returns the undo. */
export function handleMediaProtocol(ses: Session, dataDir: string): () => void {
  try {
    if (ses.protocol.isProtocolHandled(MEDIA_SCHEME)) ses.protocol.unhandle(MEDIA_SCHEME)
    ses.protocol.handle(MEDIA_SCHEME, (request) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
      return mediaResponse(request.url, request.headers.get('range'), dataDir)
    })
  } catch (err) {
    log.error('meetings', 'Serving atelier-media failed', { error: String(err) })
    return () => undefined
  }
  return () => {
    try {
      ses.protocol.unhandle(MEDIA_SCHEME)
    } catch {
      // Already gone at quit.
    }
  }
}
