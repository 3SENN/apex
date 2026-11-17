/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LinkPreview } from '@shared/links'
import { decodeEntities } from './bookmarksHtml'

export type { LinkPreview }

// Reads a link preview from a page's HTML: Open Graph and Twitter
// card tags first, then <title> and the meta description. Text only: the
// page's scripts never run.

export const PREVIEW_TEXT_MAX = 300

function clean(text: string | null | undefined, max = PREVIEW_TEXT_MAX): string | null {
  if (!text) return null
  const value = decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
  if (!value) return null
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value
}

function metaAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null
}

export function parseLinkPreview(html: string, url: string): LinkPreview {
  // Only the head matters; a body full of markup isn't scanned.
  const headEnd = html.search(/<\/head\s*>/i)
  const head = headEnd === -1 ? html.slice(0, 200_000) : html.slice(0, headEnd)
  const metas = new Map<string, string>()
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0]
    const key = (metaAttr(tag, 'property') ?? metaAttr(tag, 'name') ?? '').toLowerCase()
    const content = metaAttr(tag, 'content')
    if (key && content !== null && !metas.has(key)) metas.set(key, content)
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = metas.get(key)
      if (value) return value
    }
    return null
  }
  let domain = ''
  try {
    domain = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    // A bad address keeps an empty domain.
  }
  const rawImage = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')
  let imageUrl: string | null = null
  if (rawImage) {
    try {
      const absolute = new URL(decodeEntities(rawImage.trim()), url)
      if (absolute.protocol === 'https:') imageUrl = absolute.href
    } catch {
      imageUrl = null
    }
  }
  return {
    url,
    domain,
    title: clean(pick('og:title', 'twitter:title') ?? titleTag, 200),
    description: clean(pick('og:description', 'twitter:description', 'description')),
    siteName: clean(pick('og:site_name', 'application-name'), 80),
    imageUrl,
    image: null,
  }
}

/** The charset a Content-Type names, or utf-8. */
export function charsetOf(contentType: string | null): string {
  const m = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '')
  return (m?.[1] ?? 'utf-8').toLowerCase()
}
