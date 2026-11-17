/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents } from 'electron'
import { cdp } from './cdp'

// Agent input goes through the Chrome DevTools Protocol, the way Playwright
// drives Chromium. Unlike webContents.sendInputEvent, CDP input does not need
// the window to have OS focus, so the agent keeps working while the user is
// in another app. Events are trusted (isTrusted === true) in the page.
// Coordinates are CSS pixels relative to the main frame's viewport.

export type Modifier = 'shift' | 'control' | 'alt' | 'meta'
export type MouseButton = 'left' | 'right' | 'middle'
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export interface KeyStroke {
  key: string
  modifiers: Modifier[]
}

export interface Point {
  x: number
  y: number
}

const MODIFIER_ALIASES: Record<string, Modifier> = {
  shift: 'shift',
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
}

const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: 'Space',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  page_up: 'PageUp',
  prior: 'PageUp',
  pagedown: 'PageDown',
  page_down: 'PageDown',
  next: 'PageDown',
  insert: 'Insert',
}

export function parseModifiers(text: string | null | undefined): Modifier[] {
  if (!text) return []
  return text.split('+').map((part) => {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()]
    if (!modifier) throw new Error(`Unknown modifier "${part}". Use shift, ctrl, alt, or cmd.`)
    return modifier
  })
}

/** Parses one combo such as "Enter", "ctrl+a", or "shift+Tab". */
export function parseKeyCombo(combo: string): KeyStroke {
  const parts = combo.split('+')
  // A literal "+" key: "ctrl++" splits into ['ctrl', '', ''].
  if (combo.endsWith('++')) parts.splice(-2, 2, '+')
  const keyPart = parts.pop()
  if (!keyPart) throw new Error(`"${combo}" names no key.`)
  const modifiers = parts.map((part) => {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()]
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${combo}".`)
    return modifier
  })
  const lower = keyPart.toLowerCase()
  let key: string
  if (KEY_ALIASES[lower]) key = KEY_ALIASES[lower]
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) key = lower.toUpperCase()
  else if (keyPart.length === 1) key = keyPart
  else throw new Error(`Unknown key "${keyPart}" in "${combo}".`)
  return { key, modifiers }
}

/** Parses a space-separated sequence such as "ctrl+a Delete". */
export function parseKeySequence(text: string): KeyStroke[] {
  const combos = text.trim().split(/\s+/).filter(Boolean)
  if (combos.length === 0) throw new Error('No keys given.')
  return combos.map(parseKeyCombo)
}

export type EditCommand = 'selectAll' | 'copy' | 'paste' | 'cut' | 'undo' | 'redo'

/**
 * Editing shortcuts carry an explicit editor command. Ctrl and Cmd are both
 * accepted: on macOS these shortcuts are normally dispatched through the app
 * menu, so the key event alone would not select anything.
 */
export function editCommandFor(stroke: KeyStroke): EditCommand | null {
  const primary = stroke.modifiers.filter((m) => m === 'control' || m === 'meta')
  const others = stroke.modifiers.filter((m) => m !== 'control' && m !== 'meta')
  if (primary.length !== 1) return null
  const key = stroke.key.toLowerCase()
  if (others.length === 0) {
    const map: Record<string, EditCommand> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' }
    return map[key] ?? null
  }
  return others.length === 1 && others[0] === 'shift' && key === 'z' ? 'redo' : null
}

// ---- CDP event construction (pure) ----

const MODIFIER_BITS: Record<Modifier, number> = { alt: 1, control: 2, meta: 4, shift: 8 }
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 }

export function modifierMask(modifiers: Modifier[]): number {
  return modifiers.reduce((mask, m) => mask | MODIFIER_BITS[m], 0)
}

interface KeyDefinition {
  key: string
  code: string
  keyCode: number
  text?: string
}

const SPECIAL_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  Right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
}

const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  ' ': { code: 'Space', keyCode: 32 },
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '+': { code: 'Equal', keyCode: 187 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  '`': { code: 'Backquote', keyCode: 192 },
}

function keyDefinition(stroke: KeyStroke): KeyDefinition {
  const special = SPECIAL_KEYS[stroke.key]
  if (special) return special
  const fn = /^F(\d{1,2})$/.exec(stroke.key)
  if (fn) return { key: stroke.key, code: stroke.key, keyCode: 111 + Number(fn[1]) }
  const char = stroke.key
  if (/^[a-z]$/i.test(char)) {
    const upper = char.toUpperCase()
    const shifted = stroke.modifiers.includes('shift')
    const typed = shifted ? upper : char
    return { key: typed, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: typed }
  }
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}`, keyCode: 48 + Number(char), text: char }
  const punct = PUNCTUATION[char]
  return { key: char, code: punct?.code ?? '', keyCode: punct?.keyCode ?? 0, text: char }
}

export type CdpParams = Record<string, unknown>

/** The keyDown/keyUp pair for one stroke, as Input.dispatchKeyEvent params. */
export function keyEvents(stroke: KeyStroke): [CdpParams, CdpParams] {
  const def = keyDefinition(stroke)
  const modifiers = modifierMask(stroke.modifiers)
  const chorded = stroke.modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt')
  const text = chorded ? undefined : def.text
  const edit = editCommandFor(stroke)
  const common = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers }
  const down: CdpParams = {
    ...common,
    type: text ? 'keyDown' : 'rawKeyDown',
    ...(text ? { text, unmodifiedText: text } : {}),
    ...(edit ? { commands: [edit] } : {}),
  }
  return [down, { ...common, type: 'keyUp' }]
}

/** Wheel deltas in DOM convention: positive scrolls down or right. */
export function wheelDelta(direction: ScrollDirection, notches: number): { deltaX: number; deltaY: number } {
  const distance = 100 * notches
  switch (direction) {
    case 'up': return { deltaX: 0, deltaY: -distance }
    case 'down': return { deltaX: 0, deltaY: distance }
    case 'left': return { deltaX: -distance, deltaY: 0 }
    case 'right': return { deltaX: distance, deltaY: 0 }
  }
}

// ---- dispatch ----

// Agent input shares the tab's one debugger attachment with force dark and
// screenshots through cdp.ts; the hold is released with the tab.
const holds = new WeakMap<WebContents, { ready: Promise<void>; release: () => void }>()

/** Attaches the debugger for agent input, once per tab. */
export function attachInput(wc: WebContents): Promise<void> {
  let hold = holds.get(wc)
  if (!hold) {
    const release = cdp.acquire(wc)
    wc.debugger.once('detach', () => holds.delete(wc))
    // Keep the page focused for the agent even when Apex is not frontmost.
    const ready = cdp.send(wc, 'Emulation.setFocusEmulationEnabled', { enabled: true }).then(() => undefined)
    hold = { ready, release }
    holds.set(wc, hold)
  }
  return hold.ready
}

export function detachInput(wc: WebContents): void {
  const hold = holds.get(wc)
  holds.delete(wc)
  pointers.delete(wc)
  hold?.release()
}

async function send(wc: WebContents, method: string, params: CdpParams): Promise<void> {
  await attachInput(wc)
  await cdp.send(wc, method, params)
}

// ---- the agent's pointer (OV-22: the shield draws it) ----

type PointerListener = (wc: WebContents, point: Point) => void
const pointerListeners = new Set<PointerListener>()
const pointers = new WeakMap<WebContents, Point>()

/** Hears every move of the agent's pointer, in CSS px of the tab's viewport. */
export function onAgentPointer(listener: PointerListener): () => void {
  pointerListeners.add(listener)
  return () => pointerListeners.delete(listener)
}

/** Where the agent's pointer last was on this tab, if it has moved there. */
export function agentPointer(wc: WebContents): Point | null {
  return pointers.get(wc) ?? null
}

function notePointer(wc: WebContents, point: Point): void {
  pointers.set(wc, point)
  for (const listener of pointerListeners) {
    try {
      listener(wc, point)
    } catch {
      // A listener's failure never stops the agent's input.
    }
  }
}

const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) })

export async function mouseMove(wc: WebContents, point: Point, held: MouseButton | null = null): Promise<void> {
  notePointer(wc, round(point))
  await send(wc, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    ...round(point),
    button: held ?? 'none',
    buttons: held ? BUTTON_BITS[held] : 0,
  })
}

export async function mouseDown(wc: WebContents, point: Point, button: MouseButton = 'left', clickCount = 1, modifiers: Modifier[] = []): Promise<void> {
  await send(wc, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', ...round(point), button, buttons: BUTTON_BITS[button], clickCount, modifiers: modifierMask(modifiers),
  })
}

export async function mouseUp(wc: WebContents, point: Point, button: MouseButton = 'left', clickCount = 1, modifiers: Modifier[] = []): Promise<void> {
  await send(wc, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', ...round(point), button, buttons: 0, clickCount, modifiers: modifierMask(modifiers),
  })
}

export async function click(wc: WebContents, point: Point, button: MouseButton, clickCount: number, modifiers: Modifier[]): Promise<void> {
  await mouseMove(wc, point)
  for (let count = 1; count <= clickCount; count++) {
    await mouseDown(wc, point, button, count, modifiers)
    await mouseUp(wc, point, button, count, modifiers)
  }
}

export async function scroll(wc: WebContents, point: Point, direction: ScrollDirection, notches: number): Promise<void> {
  await mouseMove(wc, point)
  await send(wc, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...round(point), ...wheelDelta(direction, notches) })
}

export async function pressKey(wc: WebContents, stroke: KeyStroke): Promise<void> {
  const [down, up] = keyEvents(stroke)
  await send(wc, 'Input.dispatchKeyEvent', down)
  await send(wc, 'Input.dispatchKeyEvent', up)
}

export async function keyDown(wc: WebContents, stroke: KeyStroke): Promise<void> {
  await send(wc, 'Input.dispatchKeyEvent', { ...keyEvents(stroke)[0], type: 'rawKeyDown', autoRepeat: false })
}

export async function keyUp(wc: WebContents, stroke: KeyStroke): Promise<void> {
  await send(wc, 'Input.dispatchKeyEvent', keyEvents(stroke)[1])
}

export async function insertText(wc: WebContents, text: string): Promise<void> {
  await send(wc, 'Input.insertText', { text })
}
