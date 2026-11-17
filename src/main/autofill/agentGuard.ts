/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GuardKind } from '@shared/autofill'
import { classifyField, guardOf } from '@shared/fields'
import type { Bounds, ElementDescription } from '@shared/ipc'
import { mainT } from '../i18n/mainT'

// The agent's side of guarded fields (CH-18/ST-12): the hooks the
// browser tool calls before typing and after capturing. Autofill registers
// them at start-up; until it does (unit tests, the external MCP executor in a
// test), screenshots pass through and no frame guard is known.

export interface AgentGuardHooks {
  /** The guard of the field focused in any frame of the tab, cross-origin ones included. */
  focusedGuard(tabId: string): Promise<GuardKind | null>
  /** Paints over guarded fields. `region` is the captured DIP rect within the view, for zoomed captures. */
  mask(tabId: string, image: Electron.NativeImage, region?: Electron.Rectangle): Promise<Electron.NativeImage>
  /** Every visible guarded field in DIP relative to the tab view, from every frame. */
  guardedRects?(tabId: string): Promise<Bounds[]>
}

let hooks: AgentGuardHooks | null = null

export function setAgentGuardHooks(next: AgentGuardHooks | null): void {
  hooks = next
}

export async function agentFocusedGuard(tabId: string): Promise<GuardKind | null> {
  return hooks ? hooks.focusedGuard(tabId).catch(() => null) : null
}

export async function maskForAgent(tabId: string, image: Electron.NativeImage, region?: Electron.Rectangle): Promise<Electron.NativeImage> {
  return hooks ? hooks.mask(tabId, image, region) : image
}

/** Whether a point (DIP, relative to the tab view) lies on a visible guarded field in any frame. */
export async function agentGuardedAt(tabId: string, point: { x: number; y: number }): Promise<boolean> {
  if (!hooks?.guardedRects) return false
  const rects = await hooks.guardedRects(tabId).catch(() => [] as Bounds[])
  return rects.some((r) => point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height)
}

/** The guard a field's accessible name alone implies ("Card number", "CVC", "Verification code"). */
export function guardOfName(name: string, inputType: string | null = null): GuardKind | null {
  if (!name.trim()) return inputType === 'password' ? 'password' : null
  return guardOf(
    classifyField({ tag: 'input', type: inputType ?? 'text', autocomplete: '', name: '', id: '', placeholder: '', label: name, inputMode: '', maxLength: null }),
  )
}

/** The guard of a described element: the page's own answer first, then its password and payment flags, then its name. */
export function guardOfDescription(d: ElementDescription | null | undefined): GuardKind | null {
  if (!d) return null
  if (d.guard) return d.guard
  const byName = guardOfName(d.name, d.inputType)
  if (d.isPassword) return 'password'
  if (d.isPaymentField) return byName === 'cvc' ? 'cvc' : 'card'
  return d.tag === 'input' || d.tag === 'textarea' ? byName : null
}

/** The description with its guard filled in (ElementDescription.guard). */
export function withGuard<T extends ElementDescription>(d: T): T
export function withGuard<T extends ElementDescription>(d: T | null): T | null
export function withGuard<T extends ElementDescription>(d: T | null): T | null {
  return d ? { ...d, guard: guardOfDescription(d) } : null
}

// One read_page or find line for a field: indent, role, the quoted name, its ref, then the rest.
const FIELD_LINE = /^(\s*)(textbox|searchbox|combobox|spinbutton)( "(?:[^"\\]|\\.)*")? \[(ref_\d+)\](.*)$/
const VALUE_PART = / value=(?:"(?:[^"\\]|\\.)*"|\S+)/
/** read_page lines resolved per call: past this, a field is judged by its name and flags only. */
export const MAX_RESOLVED_FIELDS = 40

function nameOf(quoted: string | undefined): string {
  if (!quoted) return ''
  try {
    return String(JSON.parse(quoted.trim()))
  } catch {
    return quoted.trim().slice(1, -1)
  }
}

/**
 * Marks guarded fields in read_page and find output and replaces
 * their values with `<hidden>`, so the agent never reads a password, a card
 * number, a security code or a one-time code. `resolve` gives the real guard
 * of a ref that shows a value (`true` when it is guarded but its kind is
 * unknown); lines without a value are judged by their name.
 */
export async function redactGuarded(text: string, resolve: (ref: string) => Promise<GuardKind | true | null>): Promise<string> {
  const lines = text.split('\n')
  let resolved = 0
  for (let i = 0; i < lines.length; i++) {
    const m = FIELD_LINE.exec(lines[i] ?? '')
    if (!m) continue
    const [, indent = '', role = '', quoted, ref = '', rest = ''] = m
    if (/ guarded\b/.test(rest)) continue
    const name = nameOf(quoted)
    const shown = VALUE_PART.exec(rest)
    let guard: GuardKind | true | null = rest.includes('value=<hidden>') ? 'password' : guardOfName(name)
    if (!guard && shown && resolved < MAX_RESOLVED_FIELDS) {
      resolved++
      guard = await resolve(ref).catch(() => null)
    }
    if (!guard) continue
    const tail = shown ? rest.replace(VALUE_PART, ' value=<hidden>') : rest
    lines[i] = `${indent}${role}${quoted ?? ''} [${ref}] ${guard === true ? 'guarded' : `guarded=${guard}`}${tail}`
  }
  return lines.join('\n')
}

/** The refusal for a field that is guarded but whose kind isn't known. */
export function guardedRefusal(): string {
  return mainT('autofill.guarded.refused')
}

/** Why the agent may not enter a value: the same answer in every approval mode. */
export function guardRefusal(guard: GuardKind, subject: 'focused' | 'target' = 'focused'): string {
  const what = mainT(`autofill.guard.${guard}`)
  return mainT(subject === 'focused' ? 'autofill.guard.refused' : 'autofill.guard.refusedTarget', { what })
}

/** Keys that would change a field's value: characters, deleting, pasting, cutting, undo and redo. */
export function editsField(stroke: { key: string; modifiers: readonly string[] }): boolean {
  const command = stroke.modifiers.includes('meta') || stroke.modifiers.includes('control')
  if (command) return /^[vxzy]$/i.test(stroke.key)
  if (stroke.key.length === 1) return true
  return stroke.key === 'Backspace' || stroke.key === 'Delete'
}
