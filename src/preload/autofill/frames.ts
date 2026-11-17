/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Bounds } from '@shared/ipc'

// Frame offsets: main asks a child frame to post a nonce to its
// parent; the parent's preload finds which <iframe> sent it and reports that
// element's content box. Main only accepts the answer from the asked frame's
// real parent, so a page posting nonces can't move a popup.

const PROBE_KEY = '__apexAutofillProbe'

/** In the child: hands the nonce to the parent frame. */
export function postProbe(nonce: string): void {
  try {
    window.parent.postMessage({ [PROBE_KEY]: nonce }, '*')
  } catch {
    // A detached frame has no parent to ask.
  }
}

/** The content box of a frame element in this frame's viewport: inside its border and padding, where the child's viewport starts. */
export function contentBox(el: HTMLIFrameElement | HTMLFrameElement): Bounds {
  const r = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const padLeft = parseFloat(style.paddingLeft) || 0
  const padTop = parseFloat(style.paddingTop) || 0
  const padRight = parseFloat(style.paddingRight) || 0
  const padBottom = parseFloat(style.paddingBottom) || 0
  return {
    x: r.left + el.clientLeft + padLeft,
    y: r.top + el.clientTop + padTop,
    width: Math.max(0, el.clientWidth - padLeft - padRight),
    height: Math.max(0, el.clientHeight - padTop - padBottom),
  }
}

/** In the parent: answers a child's nonce with that child's rect. */
export function listenForProbes(report: (nonce: string, childRect: Bounds) => void): () => void {
  const onMessage = (event: MessageEvent): void => {
    const data: unknown = event.data
    if (!data || typeof data !== 'object' || !(PROBE_KEY in data)) return
    const nonce = (data as Record<string, unknown>)[PROBE_KEY]
    if (typeof nonce !== 'string' || nonce.length > 64 || !event.source) return
    for (const el of Array.from(document.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>('iframe, frame'))) {
      if (el.contentWindow === event.source) {
        report(nonce, contentBox(el))
        return
      }
    }
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}
