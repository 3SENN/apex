/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The stack of open modal layers. Only the top one takes Esc and focus;
// the app root and every layer under it are inert while it is open.

const stack: HTMLElement[] = []

function apply(): void {
  const top = stack[stack.length - 1]
  const root = document.getElementById('root')
  if (root) root.inert = stack.length > 0
  for (const el of stack) el.inert = el !== top
}

export function pushLayer(el: HTMLElement): () => void {
  stack.push(el)
  apply()
  return () => {
    const i = stack.indexOf(el)
    if (i >= 0) stack.splice(i, 1)
    apply()
  }
}

export function isTopLayer(el: HTMLElement): boolean {
  return stack[stack.length - 1] === el
}

export function hasOpenLayer(): boolean {
  return stack.length > 0
}

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',')

/** Focusable elements in tab order that are actually rendered. */
export function tabbables(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[inert]'))
}
