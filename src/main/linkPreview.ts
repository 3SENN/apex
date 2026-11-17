/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { charsetOf, parseLinkPreview, type LinkPreview } from './linkPreviewParse'
import { log } from './log'

// Link previews: ⌥ held over a link, or a long press, shows its
// title, description, image and domain. The page is fetched in main from an
// in-memory session with no cookies, with a 5 s timeout and a 512 KB cap,
// and parsed as text; nothing on it runs. Results are cached for 10 minutes.

export const PREVIEW_TIMEOUT_MS = 5000
export const PREVIEW_HTML_MAX = 512 * 1024
export const PREVIEW_IMAGE_MAX = 160 * 1024
export const PREVIEW_CACHE_MS = 10 * 60_000
const CACHE_MAX = 200

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

let fetcher: Fetcher | null = null

async function defaultFetcher(): Promise<Fetcher> {
  if (!fetcher) {
    const { session } = await import('electron')
    const ses = session.fromPartition('atelier-link-preview')
    fetcher = (url, init) => ses.fetch(url, init)
  }
  return fetcher
}

/** Tests and smoke point previews at their own fetcher. */
export function setPreviewFetcher(next: Fetcher | null): void {
  fetcher = next
}

const cache = new Map<string, { at: number; value: LinkPreview | null }>()

async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    chunks.push(value)
    if (size >= max) {
      // A page's head is near its start: keep what arrived, stop reading.
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  return Buffer.concat(chunks).subarray(0, max)
}

async function fetchImage(get: Fetcher, url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await get(url, { signal, credentials: 'omit', headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' } } as RequestInit)
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!response.ok || !/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) return null
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > PREVIEW_IMAGE_MAX) return null
    const body = await readCapped(response, PREVIEW_IMAGE_MAX + 1)
    if (!body || body.byteLength > PREVIEW_IMAGE_MAX) return null
    return `data:${type};base64,${body.toString('base64')}`
  } catch {
    return null
  }
}

/** The preview for a web link, or null when it can't be read. */
export async function linkPreview(url: string, signal?: AbortSignal, now = Date.now()): Promise<LinkPreview | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const hit = cache.get(url)
  if (hit && now - hit.at < PREVIEW_CACHE_MS) return hit.value
  const get = await defaultFetcher()
  const limit = AbortSignal.any([AbortSignal.timeout(PREVIEW_TIMEOUT_MS), ...(signal ? [signal] : [])])
  let value: LinkPreview | null = null
  try {
    const response = await get(url, { signal: limit, credentials: 'omit', redirect: 'follow', headers: { accept: 'text/html,application/xhtml+xml' } } as RequestInit)
    const type = response.headers.get('content-type')
    if (response.ok && /text\/html|application\/xhtml\+xml/i.test(type ?? '')) {
      const body = await readCapped(response, PREVIEW_HTML_MAX)
      if (body) {
        let html: string
        try {
          html = new TextDecoder(charsetOf(type)).decode(body)
        } catch {
          html = body.toString('utf8')
        }
        value = parseLinkPreview(html, response.url || url)
        if (value.imageUrl) value.image = await fetchImage(get, value.imageUrl, limit)
      }
    }
  } catch (err) {
    if (!signal?.aborted) log.debug('links', 'Link preview failed', { error: err instanceof Error ? err.message : String(err) })
    // A cancelled hover isn't remembered as a failure.
    if (signal?.aborted) return null
  }
  cache.delete(url)
  cache.set(url, { at: now, value })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  return value
}

export function clearPreviewCache(): void {
  cache.clear()
}
