/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session } from 'electron'
import { VIEW_SOURCE_MAX_BYTES, type ViewSourceResult } from '@shared/dialogs'

// View source: apex://view-source asks main for the document's text.
// It is fetched again through the tab's own session, so cookies and the
// cache match what the page saw; only http and https are fetched, and the
// text is capped.

export async function loadSource(session: Session, url: string, maxBytes = VIEW_SOURCE_MAX_BYTES): Promise<ViewSourceResult> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only web pages have a source to show.')
  // The cache is preferred: view source should show what loaded, not refetch a changed page.
  const response = await session.fetch(parsed.href, { cache: 'force-cache', redirect: 'follow' })
  const contentType = response.headers.get('content-type') ?? ''
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      if (size + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size))
        size = maxBytes
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(value)
      size += value.length
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8'
  let text: string
  try {
    text = new TextDecoder(charset, { fatal: false }).decode(bytes)
  } catch {
    text = new TextDecoder('utf-8').decode(bytes)
  }
  return { url: response.url || parsed.href, text, truncated, contentType, status: response.status }
}
