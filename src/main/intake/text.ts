/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mainT } from '../i18n/mainT'

// Text rules for attachments: line counts the chips show, caps, and the
// small framing Atelier adds around a selection so the agent sees its source.

/** Characters of a saved chat attached as context (CH-25). */
export const CHAT_ATTACH_MAX_CHARS = 200_000
/** A dragged page image or link is fetched up to this size. */
export const PAGE_FETCH_MAX_BYTES = 25_000_000
/** Attachment names stay short; chips truncate further. */
export const NAME_MAX = 200

/** Lines as an editor counts them: a trailing newline doesn't start another. */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return text.endsWith('\n') ? lines - 1 : lines
}

/** Cuts text to `max` characters on a line boundary when one is near, with a marker saying so. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const cut = text.lastIndexOf('\n', max)
  const end = cut > max * 0.9 ? cut : max
  return { text: `${text.slice(0, end)}\n\n${mainT('intake.text.truncated')}`, truncated: true }
}

/** Caps a string by UTF-8 bytes rather than characters (the per-type caps are in bytes). */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  // Leave room for the marker; characters are at most 4 bytes, so this lands under the cap.
  return capText(text, Math.floor((maxBytes - 200) / 4) * 3)
}

/** A one-line label from free text, for chips: collapsed whitespace, at most `max` characters. */
export function excerpt(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export function cleanName(name: string): string {
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (trimmed || mainT('intake.name.untitled')).slice(0, NAME_MAX)
}

/** A selection as the agent gets it (OV-20): the quote, then where it came from and its links. */
export function selectionText(input: { text: string; url: string; title: string; links?: { text: string; url: string }[] }): string {
  const parts = [input.text.trim(), '', mainT('intake.text.source', { title: input.title || input.url, url: input.url })]
  const links = (input.links ?? []).filter((l) => l.url)
  if (links.length > 0) {
    parts.push('', mainT('intake.text.links'))
    for (const link of links) parts.push(`- ${link.text.trim() ? `${excerpt(link.text, 120)}: ` : ''}${link.url}`)
  }
  return parts.join('\n')
}
