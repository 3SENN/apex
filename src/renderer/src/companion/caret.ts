/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useState } from 'react'
import type { LookTarget } from './view'

// Where the caret is on screen, so a live companion can watch you type
// (DS-72, DS-74). Text fields do not expose it, so a hidden mirror with the
// same text metrics measures it.

const COPIED = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontVariant',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'tabSize',
] as const

/** The caret's viewport position in a text field, or null when it has none. */
export function caretPoint(field: HTMLInputElement | HTMLTextAreaElement): LookTarget | null {
  const index = field.selectionEnd ?? field.value.length
  const style = window.getComputedStyle(field)
  const mirror = document.createElement('div')
  const multiline = field instanceof HTMLTextAreaElement
  for (const prop of COPIED) mirror.style[prop] = style[prop]
  mirror.style.position = 'fixed'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.overflow = 'hidden'
  mirror.style.whiteSpace = multiline ? 'pre-wrap' : 'pre'
  mirror.style.overflowWrap = multiline ? 'break-word' : 'normal'
  if (!multiline) mirror.style.width = 'auto'
  mirror.textContent = field.value.slice(0, index)
  const marker = document.createElement('span')
  marker.textContent = '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  try {
    const rect = field.getBoundingClientRect()
    const x = rect.left + marker.offsetLeft - field.scrollLeft
    const y = rect.top + marker.offsetTop - field.scrollTop + marker.offsetHeight / 2
    // Clamped to the field: a long line scrolled out of view still looks at its edge.
    return { x: Math.min(rect.right, Math.max(rect.left, x)), y: Math.min(rect.bottom, Math.max(rect.top, y)) }
  } finally {
    mirror.remove()
  }
}

/**
 * A look target that follows the caret: call `track` from the field's
 * input and selection handlers. The live view hands the gaze back to the
 * pointer once the mouse moves a few pixels; `clear` does so at once.
 */
export function useCaretGaze(): { lookAt: LookTarget | null; track(field: HTMLInputElement | HTMLTextAreaElement | null): void; clear(): void } {
  const [lookAt, setLookAt] = useState<LookTarget | null>(null)
  const track = useCallback((field: HTMLInputElement | HTMLTextAreaElement | null) => {
    setLookAt(field ? caretPoint(field) : null)
  }, [])
  const clear = useCallback(() => setLookAt(null), [])
  return { lookAt, track, clear }
}
