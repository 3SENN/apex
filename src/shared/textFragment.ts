/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// "Copy link to highlight" (OV-05): a text fragment URL (#:~:text=…) that
// scrolls to and highlights the selection when opened. Short selections are
// quoted whole; long ones by their first and last words.

/** Selections up to this many words are quoted whole. */
export const EXACT_WORDS = 10
/** Long selections keep this many words at each end. */
export const EDGE_WORDS = 4

/** Percent-encodes a fragment term; the syntax reserves '-', ',' and '&' too. */
export function encodeTerm(text: string): string {
  return encodeURIComponent(text).replace(/-/g, '%2D')
}

/** The page's address with a text fragment for `selection`, or null when no link can be made. */
export function textFragmentUrl(pageUrl: string, selection: string): string | null {
  let url: URL
  try {
    url = new URL(pageUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const words = selection.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length === 0) return null
  const directive =
    words.length <= EXACT_WORDS
      ? encodeTerm(words.join(' '))
      : `${encodeTerm(words.slice(0, EDGE_WORDS).join(' '))},${encodeTerm(words.slice(-EDGE_WORDS).join(' '))}`
  url.hash = ''
  return `${url.href}#:~:text=${directive}`
}
