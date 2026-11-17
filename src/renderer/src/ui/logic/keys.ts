/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Keyboard movement shared by tab lists, segmented controls and focus traps.

export type RovingOrientation = 'horizontal' | 'vertical' | 'both'

export interface RovingOptions {
  orientation?: RovingOrientation
  /** Wrap from the last item to the first (default true). */
  loop?: boolean
  disabled?: (index: number) => boolean
}

/**
 * The index focus moves to for a key, skipping disabled items, or null when
 * the key is not a move (or nothing is enabled).
 */
export function rovingIndex(key: string, current: number, count: number, o: RovingOptions = {}): number | null {
  const orientation = o.orientation ?? 'horizontal'
  const loop = o.loop ?? true
  const enabled = (i: number): boolean => !o.disabled?.(i)
  const horizontal = orientation !== 'vertical'
  const vertical = orientation !== 'horizontal'
  let dir: 1 | -1
  if ((horizontal && key === 'ArrowRight') || (vertical && key === 'ArrowDown')) dir = 1
  else if ((horizontal && key === 'ArrowLeft') || (vertical && key === 'ArrowUp')) dir = -1
  else if (key === 'Home' || key === 'End') {
    const order = Array.from({ length: count }, (_, i) => (key === 'Home' ? i : count - 1 - i))
    return order.find(enabled) ?? null
  } else return null

  for (let step = 1; step <= count; step++) {
    let i = current + dir * step
    if (i < 0 || i >= count) {
      if (!loop) return null
      i = (i + count * 2) % count
    }
    if (enabled(i)) return i
  }
  return null
}

/** Where Tab lands inside a focus trap: wraps at both ends. */
export function trapFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return backwards ? count - 1 : 0
  return (current + (backwards ? -1 : 1) + count) % count
}

/** One spot the keyboard audit flags: a click handler on an element that can't take focus or keys. */
export interface KeyboardFinding {
  line: number
  tag: string
}

const STATIC_TAGS = new Set(['div', 'span', 'li', 'img', 'p', 'section', 'article', 'header', 'footer', 'td', 'tr', 'svg'])

/**
 * The keyboard audit over TSX source: an opening tag of a non-interactive
 * element with onClick needs a role plus tabIndex, or a key handler, or an
 * explicit aria-hidden (a pointer-only shortcut beside a real control, such
 * as a scrim). Options and menu items are fine with a role alone: their list
 * moves focus for them (aria-activedescendant). Pure text matching, so it
 * runs in a unit test.
 */
export function auditKeyboard(source: string): KeyboardFinding[] {
  const out: KeyboardFinding[] = []
  const tag = /<([a-z][a-z0-9]*)\b([^<>]*?(?:=>[^<>]*?)*)\/?>/g
  for (const m of source.matchAll(tag)) {
    const name = m[1] ?? ''
    const attrs = m[2] ?? ''
    if (!STATIC_TAGS.has(name) || !/\bonClick=/.test(attrs)) continue
    const focusable = /\brole=/.test(attrs) && /\btabIndex=/.test(attrs)
    const managed = /\brole=(?:"(?:option|menuitem|menuitemcheckbox|menuitemradio|treeitem|gridcell)"|\{role\})/.test(attrs)
    const keyed = /\bonKey(Down|Up)=/.test(attrs)
    const hidden = /\baria-hidden\b/.test(attrs)
    if (focusable || managed || keyed || hidden) continue
    out.push({ line: source.slice(0, m.index).split('\n').length, tag: name })
  }
  return out
}
