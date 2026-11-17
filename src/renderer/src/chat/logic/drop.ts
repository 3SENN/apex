/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ATTACHMENT_FILE_BASE64_MAX, ATTACHMENT_LIMITS, type AttachmentSource } from '@shared/attachments'

// Pure rules for drops on the chat (CH-23): when the overlay shows,
// which files are turned away before they are read (and why), and what a
// drag from the page becomes. The intake in main checks every file again.

/** The overlay is for files; text and links dropped on the composer are handled there. */
export function carriesFiles(types: readonly string[]): boolean {
  return types.includes('Files')
}

/**
 * Nested elements fire dragenter and dragleave in pairs, so the overlay
 * follows a count: it shows above zero and hides at zero. A drop or a
 * cancelled drag resets it.
 */
export function dragDepth(depth: number, event: 'enter' | 'leave' | 'drop' | 'end'): number {
  if (event === 'enter') return depth + 1
  if (event === 'leave') return Math.max(0, depth - 1)
  return 0
}

/** The largest file the renderer reads: what fits in the intake's base64 cap. */
export const FILE_BYTES_MAX = Math.floor((ATTACHMENT_FILE_BASE64_MAX * 3) / 4)

export interface FileFacts {
  name: string
  size: number
  /** From the drop's entry: a folder dragged in from Finder. */
  directory?: boolean
}

export type FileRejection = 'too-large' | 'too-many' | 'folder'

/** Which files go to the intake, and the reason for each one that doesn't. `already` counts the draft's attachments. */
export function preflightFiles(files: readonly FileFacts[], already: number): { accept: number[]; reject: { index: number; reason: FileRejection }[] } {
  const accept: number[] = []
  const reject: { index: number; reason: FileRejection }[] = []
  let room = Math.max(0, ATTACHMENT_LIMITS.perMessage - already)
  files.forEach((file, index) => {
    if (file.directory) reject.push({ index, reason: 'folder' })
    else if (file.size > FILE_BYTES_MAX) reject.push({ index, reason: 'too-large' })
    else if (room === 0) reject.push({ index, reason: 'too-many' })
    else {
      accept.push(index)
      room--
    }
  })
  return { accept, reject }
}

const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic)(?:[?#]|$)/i

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function httpUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(decodeEntities(raw.trim()), base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** The first URL in a text/uri-list (comment lines start with #). */
function firstUri(list: string): string {
  return list.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? ''
}

export interface PageDrag {
  uriList: string
  html: string
  text: string
}

export interface ActivePage {
  tabId: string
  url: string
  title: string
}

const LINKS_MAX = 50

/**
 * What a drag from the active page becomes: a dragged image is a
 * `page-url` source (main downloads it through the tab's session); dragged
 * text with markup is a `selection` quoted with its links and the page's
 * address. Plain text from other apps, and links, type as usual (null).
 * Chromium puts HTML on drags that start in a web page, which is how a page
 * drag is told apart from text dragged in from elsewhere.
 */
export function pageDragSource(drag: PageDrag, page: ActivePage | null): AttachmentSource | null {
  if (!page || !/^https?:/.test(page.url)) return null
  const img = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(drag.html)?.[1]
  const uri = firstUri(drag.uriList)
  const textOnly = drag.text.trim()
  const imageUrl = img ? httpUrl(img, page.url) : uri && IMAGE_URL.test(uri) ? httpUrl(uri, page.url) : null
  // A picture dragged on its own (no words selected with it) is the picture.
  if (imageUrl && (!textOnly || textOnly === uri)) return { type: 'page-url', tabId: page.tabId, url: imageUrl }
  if (drag.html.trim() === '' || textOnly === '' || textOnly === uri) return null
  const links: { text: string; url: string }[] = []
  const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (let m = anchor.exec(drag.html); m && links.length < LINKS_MAX; m = anchor.exec(drag.html)) {
    const url = httpUrl(m[1] ?? '', page.url)
    const text = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (url) links.push({ text: text.slice(0, 1024), url })
  }
  // The intake's caps: the text, the title and each address.
  const fits = links.filter((l) => l.url.length <= 8192)
  return { type: 'selection', text: textOnly.slice(0, 200_000), url: page.url, title: page.title.slice(0, 1024), ...(fits.length ? { links: fits } : {}) }
}
