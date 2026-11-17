/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A quoted selection (OV-20): what the selection chip, ⌘J and the page menu
// hand the composer, and how it reads in the message that goes out. Pure, so
// the page preload, main and the composer share one copy.
import { PAGE_SELECTION_LINKS_MAX, PAGE_SELECTION_TEXT_MAX } from './ipc'
import type { QuoteInput } from './services/chat'

/** Characters of a quote shown on the composer's chip and in the page menu. */
export const QUOTE_PREVIEW_CHARS = 140

function httpUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** Collapses runs of blank lines and trailing spaces; keeps line breaks. */
export function cleanSelection(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, PAGE_SELECTION_TEXT_MAX)
}

/** Web links only, each once, at most the page channel's limit. */
export function cleanLinks(links: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of links) {
    const url = httpUrl(raw)
    if (url && !out.includes(url)) out.push(url)
    if (out.length >= PAGE_SELECTION_LINKS_MAX) break
  }
  return out
}

export function normalizeQuote(input: QuoteInput): QuoteInput {
  return { text: cleanSelection(input.text), url: httpUrl(input.url) ?? input.url, links: cleanLinks(input.links) }
}

/** A one-line preview for chips and menus. */
export function quotePreview(text: string, max = QUOTE_PREVIEW_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export function quoteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * The quote as it goes out ahead of the person's words: a Markdown block
 * quote, then where it came from and its links. Page text is the person's
 * pick, but still the page's words, so it is marked as quoted.
 */
export function quoteBlock(quote: QuoteInput): string {
  const lines: string[] = []
  const text = cleanSelection(quote.text)
  if (text) lines.push(...text.split('\n').map((l) => (l ? `> ${l}` : '>')), '')
  if (quote.url) lines.push(`Source: ${quote.url}`)
  const links = cleanLinks(quote.links).filter((l) => l !== quote.url)
  if (links.length > 0) lines.push(`Links in the quote: ${links.join(' ')}`)
  return lines.join('\n').trim()
}

/** The message to send: the quote, then what the person typed (either may be empty). */
export function withQuote(quote: QuoteInput | null, message: string): string {
  if (!quote) return message
  const block = quoteBlock(quote)
  const typed = message.trim()
  return [block, typed].filter(Boolean).join('\n\n')
}
