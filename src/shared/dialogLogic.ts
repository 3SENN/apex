/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DialogButton, DialogResult, DialogSpec } from './dialogs'

// How a DialogSpec behaves (OV-07), shared by the overlay surface and the
// chrome's fallback so both answer alike: which button Enter and Esc press,
// where each button sits, what the inputs start with.

/** Enter presses this button: the one marked enter, else the only primary or destructive one. */
export function enterButton(spec: DialogSpec): DialogButton | null {
  const marked = spec.buttons.find((b) => b.enter)
  if (marked) return marked
  const strong = spec.buttons.filter((b) => b.style === 'primary' || b.style === 'destructive')
  return strong.length === 1 ? (strong[0] ?? null) : null
}

/** Esc, the close button and a backdrop click press this one (null: dismissed without a button). */
export function escapeButton(spec: DialogSpec): DialogButton | null {
  return spec.buttons.find((b) => b.escape) ?? null
}

export function initialValues(spec: DialogSpec): Record<string, string> {
  return Object.fromEntries((spec.inputs ?? []).map((i) => [i.id, i.value ?? '']))
}

export function resultFor(spec: DialogSpec, button: DialogButton | null, values: Record<string, string>, checked: boolean): DialogResult {
  const inputs: Record<string, string> = {}
  for (const i of spec.inputs ?? []) inputs[i.id] = values[i.id] ?? ''
  return { button: button?.id ?? null, inputs, checked: spec.checkbox ? checked : false }
}

/** Buttons by side: 'start' ones sit left, the rest right, in the spec's order. */
export function buttonRows(spec: DialogSpec): { start: DialogButton[]; end: DialogButton[] } {
  return { start: spec.buttons.filter((b) => b.align === 'start'), end: spec.buttons.filter((b) => b.align !== 'start') }
}

/** What a key does inside the dialog. Enter in a text field submits; on a button the button itself answers. */
export function keyAction(spec: DialogSpec, key: string, target: { tag: string; type?: string }): { press: DialogButton | null } | null {
  if (key === 'Escape') return { press: escapeButton(spec) }
  if (key !== 'Enter') return null
  const tag = target.tag.toLowerCase()
  if (tag === 'button' || tag === 'textarea' || tag === 'a' || (tag === 'input' && target.type === 'checkbox')) return null
  const enter = enterButton(spec)
  return enter ? { press: enter } : null
}

/** Focus starts in the first field, else on the Enter button unless it is destructive (then on Cancel), else the first button. */
export function initialFocus(spec: DialogSpec): { kind: 'input'; id: string } | { kind: 'button'; id: string } | null {
  const first = spec.inputs?.[0]
  if (first) return { kind: 'input', id: first.id }
  const enter = enterButton(spec)
  if (enter && enter.style !== 'destructive') return { kind: 'button', id: enter.id }
  const safe = escapeButton(spec) ?? spec.buttons[0]
  return safe ? { kind: 'button', id: safe.id } : null
}

/** A plain confirm: cancel plus an action that may be destructive (OV-08). */
export function confirmSpec(o: { title: string; message?: string; confirmLabel: string; cancelLabel: string; destructive?: boolean; dedupeKey?: string }): DialogSpec {
  return {
    title: o.title,
    ...(o.message ? { description: o.message } : {}),
    ...(o.destructive ? { icon: 'danger' as const } : {}),
    buttons: [
      { id: 'cancel', label: o.cancelLabel, style: 'secondary', escape: true, align: 'end' },
      { id: 'confirm', label: o.confirmLabel, style: o.destructive ? 'destructive' : 'primary', enter: true, align: 'end' },
    ],
    ...(o.dedupeKey ? { dedupeKey: o.dedupeKey } : {}),
  }
}

/** A plain alert with one button. */
export function alertSpec(o: { title: string; message?: string; okLabel: string; icon?: DialogSpec['icon'] }): DialogSpec {
  return {
    title: o.title,
    ...(o.message ? { description: o.message } : {}),
    ...(o.icon ? { icon: o.icon } : {}),
    buttons: [{ id: 'ok', label: o.okLabel, style: 'primary', enter: true, escape: true, align: 'end' }],
  }
}
