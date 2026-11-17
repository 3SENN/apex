/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where the caret is in a textarea, in viewport coordinates, so the waiting
// companion can look at it while you type (DS-72). A hidden mirror with the
// same text metrics lays the text out up to the caret.

const COPIED = [
  'boxSizing', 'width', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize', 'overflowWrap',
] as const

export function caretPoint(field: HTMLTextAreaElement): { x: number; y: number } {
  const style = getComputedStyle(field)
  const mirror = document.createElement('div')
  for (const prop of COPIED) mirror.style[prop] = style[prop]
  Object.assign(mirror.style, { position: 'fixed', left: '0', top: '0', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', height: 'auto' })
  const end = field.selectionEnd ?? field.value.length
  mirror.textContent = field.value.slice(0, end)
  const marker = document.createElement('span')
  marker.textContent = '​'
  mirror.append(marker)
  document.body.append(mirror)
  const box = field.getBoundingClientRect()
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4
  const point = {
    x: box.left + marker.offsetLeft - field.scrollLeft,
    y: box.top + marker.offsetTop - field.scrollTop + lineHeight / 2,
  }
  mirror.remove()
  return point
}
