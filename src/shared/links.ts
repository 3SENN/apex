/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Links (SH-46): what the link bubble and the preview
// card show, and the click rules, shared by main and the chrome.
import { middleTruncate } from './domains'

export interface LinkPreview {
  url: string
  /** The host as people read it. */
  domain: string
  title: string | null
  description: string | null
  siteName: string | null
  /** An absolute https image address from the page's tags. */
  imageUrl: string | null
  /** The image itself, fetched the same cookie-less way and small enough to send (data: URL). */
  image: string | null
}

/** The bubble's text for a hovered address: decoded where that is safe to read, Atelier pages as atelier://. */
export function bubbleText(url: string, max = 160): string {
  if (!url) return ''
  let text = url
  try {
    const decoded = decodeURI(url)
    // Spaces, control and direction characters could disguise the address; keep those encoded.
    if (!/[\s\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(decoded)) text = decoded
  } catch {
    text = url
  }
  return middleTruncate(text, max)
}

/** How a click on a link opens it. */
export type LinkOpen = 'here' | 'peek' | 'background-tab' | 'foreground-tab'

export function linkOpenFor(e: { button: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey?: boolean }, isMac: boolean): LinkOpen {
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (e.button === 1) return 'background-tab'
  if (mod && e.shiftKey) return 'foreground-tab'
  if (mod) return 'background-tab'
  if (e.shiftKey) return 'peek'
  return 'here'
}

/** Links Peek can show: web pages and local files. */
export function canPeek(url: string): boolean {
  return /^(https?|file):\/\//i.test(url)
}
