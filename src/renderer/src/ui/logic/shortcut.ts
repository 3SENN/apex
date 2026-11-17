/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shortcut labels from Electron accelerator strings ('CmdOrCtrl+Shift+E'),
// so menus, tooltips and <Kbd> all show the same keys.

export interface ParsedShortcut {
  cmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

export function parseAccelerator(accelerator: string, mac: boolean): ParsedShortcut {
  const out: ParsedShortcut = { cmd: false, ctrl: false, alt: false, shift: false, key: '' }
  const tokens = accelerator.split('+')
  // "Cmd++" splits into a trailing empty pair: the key is "+".
  if (accelerator.endsWith('++')) tokens.splice(-2, 2, '+')
  for (const raw of tokens) {
    const t = raw.trim().toLowerCase()
    if (t === 'cmdorctrl' || t === 'commandorcontrol') {
      if (mac) out.cmd = true
      else out.ctrl = true
    } else if (t === 'cmd' || t === 'command' || t === 'super' || t === 'meta') out.cmd = true
    else if (t === 'ctrl' || t === 'control') out.ctrl = true
    else if (t === 'alt' || t === 'option' || t === 'altgr') out.alt = true
    else if (t === 'shift') out.shift = true
    else if (raw) out.key = raw.trim()
  }
  return out
}

const MAC_KEYS: Record<string, string> = {
  left: '←', right: '→', up: '↑', down: '↓',
  enter: '↩', return: '↩', backspace: '⌫', delete: '⌦', tab: '⇥',
  escape: 'Esc', esc: 'Esc', space: 'Space', plus: '+', pageup: '⇞', pagedown: '⇟',
}

const OTHER_KEYS: Record<string, string> = {
  left: '←', right: '→', up: '↑', down: '↓',
  enter: 'Enter', return: 'Enter', backspace: 'Backspace', delete: 'Del', tab: 'Tab',
  escape: 'Esc', esc: 'Esc', space: 'Space', plus: '+', pageup: 'PgUp', pagedown: 'PgDn',
}

function keyLabel(key: string, mac: boolean): string {
  const named = (mac ? MAC_KEYS : OTHER_KEYS)[key.toLowerCase()]
  if (named) return named
  return key.length === 1 ? key.toUpperCase() : key
}

/** Each key as its own label, in the platform's usual order. */
export function shortcutParts(accelerator: string, mac: boolean): string[] {
  const s = parseAccelerator(accelerator, mac)
  const parts: string[] = []
  if (mac) {
    if (s.ctrl) parts.push('⌃')
    if (s.alt) parts.push('⌥')
    if (s.shift) parts.push('⇧')
    if (s.cmd) parts.push('⌘')
  } else {
    if (s.ctrl) parts.push('Ctrl')
    if (s.alt) parts.push('Alt')
    if (s.shift) parts.push('Shift')
    if (s.cmd) parts.push('Win')
  }
  if (s.key) parts.push(keyLabel(s.key, mac))
  return parts
}

/** "⇧⌘E" on macOS, "Ctrl+Shift+E" elsewhere. */
export function formatShortcut(accelerator: string, mac: boolean): string {
  return shortcutParts(accelerator, mac).join(mac ? '' : '+')
}

const ARIA_KEYS: Record<string, string> = {
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  enter: 'Enter', return: 'Enter', backspace: 'Backspace', delete: 'Delete', tab: 'Tab',
  escape: 'Escape', esc: 'Escape', space: 'Space', plus: '+', pageup: 'PageUp', pagedown: 'PageDown',
}

/** The value for aria-keyshortcuts, e.g. "Meta+Shift+E". */
export function ariaKeyShortcut(accelerator: string, mac: boolean): string {
  const s = parseAccelerator(accelerator, mac)
  const parts: string[] = []
  if (s.ctrl) parts.push('Control')
  if (s.alt) parts.push('Alt')
  if (s.shift) parts.push('Shift')
  if (s.cmd) parts.push('Meta')
  if (s.key) parts.push(ARIA_KEYS[s.key.toLowerCase()] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key))
  return parts.join('+')
}

/** Native tooltip text: "Show sidebar (⌘S)". */
export function tooltipText(label: string, accelerator: string | undefined, mac: boolean): string {
  return accelerator ? `${label} (${formatShortcut(accelerator, mac)})` : label
}
