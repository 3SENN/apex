/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents, Input } from 'electron'
import { SHORTCUTS, type ShortcutDef, type ShortcutId } from '@shared/shortcuts'
import type { WindowContext } from './features/types'

// Shortcut hooks for features. Input interceptors run before
// the ShortcutRouter, highest priority first; 'handled' stops the key there
// (the voice chord). Runtime shortcuts serve extension commands and show
// in the ⌘/ sheet under their owner.

export type InputInterceptor = (input: Input, wc: WebContents, win: WindowContext | null) => 'handled' | 'pass'

export interface RuntimeShortcut extends Omit<ShortcutDef, 'id' | 'label'> {
  id: string
  owner: string
  /** Runtime shortcuts bring their own text (an extension's command description). */
  title: string
}

export type RegisterRuntimeResult = { ok: true; dispose(): void } | { ok: false; clash: ShortcutId }

/** Accelerators compare without case, spaces or the CmdOrCtrl spelling. */
export function normalizeAccelerator(accelerator: string, platform: string = process.platform): string {
  const mac = platform === 'darwin'
  const parts = accelerator
    .replace(/\s+/g, '')
    .split('+')
    .filter(Boolean)
    .map((p) => p.toLowerCase())
    .map((p) => (p === 'cmdorctrl' || p === 'commandorcontrol' ? (mac ? 'cmd' : 'ctrl') : p === 'command' ? 'cmd' : p === 'control' ? 'ctrl' : p === 'option' ? 'alt' : p))
  const key = parts.pop() ?? ''
  return [...parts.sort(), key].join('+')
}

const interceptors: { fn: InputInterceptor; priority: number; seq: number }[] = []
let seq = 0
const runtime = new Map<string, RuntimeShortcut>()

export const shortcuts = {
  addInputInterceptor(fn: InputInterceptor, opts: { priority?: number } = {}): () => void {
    const entry = { fn, priority: opts.priority ?? 0, seq: seq++ }
    interceptors.push(entry)
    // Highest priority first; equal priorities keep registration order.
    interceptors.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
    return () => {
      const i = interceptors.indexOf(entry)
      if (i >= 0) interceptors.splice(i, 1)
    }
  },

  /** Runs the interceptors for one key event; true when one handled it (the router then calls preventDefault). */
  intercept(input: Input, wc: WebContents, win: WindowContext | null): boolean {
    for (const { fn } of [...interceptors]) {
      if (fn(input, wc, win) === 'handled') return true
    }
    return false
  },

  clashesWith(accelerator: string): ShortcutId | null {
    const wanted = normalizeAccelerator(accelerator)
    const hit = SHORTCUTS.find((s) => !s.accelerator.startsWith('Hold+') && normalizeAccelerator(s.accelerator) === wanted)
    return hit?.id ?? null
  },

  registerRuntime(def: RuntimeShortcut): RegisterRuntimeResult {
    const clash = shortcuts.clashesWith(def.accelerator)
    if (clash) return { ok: false, clash }
    const key = `${def.owner}:${def.id}`
    runtime.set(key, def)
    return {
      ok: true,
      dispose: () => {
        if (runtime.get(key) === def) runtime.delete(key)
      },
    }
  },

  /** Runtime shortcuts, for the ⌘/ sheet and the router. */
  runtime(): RuntimeShortcut[] {
    return [...runtime.values()]
  },
}

// SH-66
// Every chrome, overlay and tab webContents feeds before-input-event here.
// Interceptors run first, then the key-state machine, then the table:
// overridesPage keys always go to the browser; other keys pass, so the page
// (or a text field: ⌘← and ⌘→) gets them first and the menu accelerator
// runs only when the page left the key alone. Keys that would act on an
// agent-controlled tab (reload, back, close) wait for a take-over.

/** Where the key was pressed. */
export type InputSource = 'chrome' | 'overlay' | 'page'

export interface RouteContext {
  source: InputSource
  platform: string
  /** The active tab shows a website (not a chrome-drawn page). */
  website: boolean
  /** The active tab is under the agent's control. */
  agentControlled: boolean
}

export type RouteDecision = { kind: 'pass' } | { kind: 'run'; id: ShortcutId } | { kind: 'wait'; id: ShortcutId }

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Slash: '/',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
}
const NAMED_KEYS: Record<string, string> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ' ': 'space',
  '+': 'plus',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Enter: 'enter',
  Tab: 'tab',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Home: 'home',
  End: 'end',
}

/** The normalized accelerators one key event can stand for (its typed key and its physical key). */
export function inputAccelerators(input: Pick<Input, 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift'>, platform: string = process.platform): string[] {
  const keys = new Set<string>()
  const named = NAMED_KEYS[input.key]
  if (named) keys.add(named)
  else if (/^F\d{1,2}$/.test(input.key)) keys.add(input.key.toLowerCase())
  else if (input.key.length === 1) keys.add(input.key.toLowerCase())
  const physical = CODE_KEYS[input.code] ?? (/^Digit\d$/.test(input.code) ? input.code.slice(5) : /^Key[A-Z]$/.test(input.code) ? input.code.slice(3).toLowerCase() : null)
  // Shifted punctuation (⌘⇧] types "}") matches on the physical key; letters keep the layout's.
  if (physical && !/^[a-z]$/.test(physical)) keys.add(physical)
  const out: string[] = []
  for (const key of keys) {
    // "+" needs Shift on most layouts, but ⌘+ is written without it.
    const shift = input.shift && key !== 'plus'
    const mods = [input.meta ? 'cmd' : '', input.control ? 'ctrl' : '', input.alt ? 'alt' : '', shift ? 'shift' : ''].filter(Boolean)
    out.push(normalizeAccelerator([...mods, key].join('+'), platform))
  }
  return out
}

/** The table row a key event presses, if any (holds never match). */
export function matchShortcut(input: Pick<Input, 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift'>, platform: string = process.platform): ShortcutDef | null {
  const wanted = new Set(inputAccelerators(input, platform))
  if (wanted.size === 0) return null
  const mac = platform === 'darwin'
  for (const def of SHORTCUTS) {
    const keys = mac ? def.keys.mac : def.keys.other
    if (keys.startsWith('Hold+')) continue
    if (wanted.has(normalizeAccelerator(keys, platform))) return def
  }
  return null
}

/** What the router does with one key event. */
export function routeShortcut(input: Pick<Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift'>, ctx: RouteContext): RouteDecision {
  if (input.type !== 'keyDown') return { kind: 'pass' }
  const def = matchShortcut(input, ctx.platform)
  if (!def) return { kind: 'pass' }
  if (def.when === 'website' && !ctx.website) return { kind: 'pass' }
  if (def.when === 'apex-page' && ctx.website) return { kind: 'pass' }
  if (def.waitsForTakeOver && ctx.agentControlled) return { kind: 'wait', id: def.id }
  if (def.overridesPage) return { kind: 'run', id: def.id }
  // Everything else: the page or text field first, then the menu accelerator.
  return { kind: 'pass' }
}
