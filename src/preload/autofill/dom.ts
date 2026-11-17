/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { classifyField, formRoleOf, guardOf, type FieldAttributes, type FieldKind, type FormRole, type GuardKind } from '@shared/fields'
import type { Bounds } from '@shared/ipc'

// Reading the page for autofill: an element's attributes for the shared
// classifier, the group of fields it belongs to, and stable ids for fields
// and groups. Runs in every frame's isolated world; nothing here is visible
// to the page.

export type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'password', 'number', 'url', 'month'])
const MAX_FIELDS = 400

export function isFieldElement(el: unknown): el is FieldElement {
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
}

function tagOf(el: FieldElement): FieldAttributes['tag'] {
  return el instanceof HTMLSelectElement ? 'select' : el instanceof HTMLTextAreaElement ? 'textarea' : 'input'
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** The field's label: its <label>s, aria-label and aria-labelledby. */
function labelOf(el: FieldElement): string {
  const parts: string[] = []
  for (const label of Array.from(el.labels ?? [])) parts.push(textOf(label))
  const aria = el.getAttribute('aria-label')
  if (aria) parts.push(aria)
  const by = el.getAttribute('aria-labelledby')
  if (by) for (const id of by.split(/\s+/)) parts.push(textOf(el.ownerDocument.getElementById(id)))
  return parts.filter(Boolean).join(' ').slice(0, 300)
}

export function attributesOf(el: FieldElement): FieldAttributes {
  const max = el instanceof HTMLInputElement && el.maxLength > 0 ? el.maxLength : null
  return {
    tag: tagOf(el),
    type: el instanceof HTMLInputElement ? (el.getAttribute('type') ?? 'text').toLowerCase() : '',
    autocomplete: el.getAttribute('autocomplete') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.id,
    placeholder: el.getAttribute('placeholder') ?? '',
    label: labelOf(el),
    inputMode: el.getAttribute('inputmode') ?? '',
    maxLength: max,
  }
}

export function kindOf(el: FieldElement): FieldKind | null {
  if (el.disabled) return null
  return classifyField(attributesOf(el))
}

/** The guard of an element, for the agent bridge and the capture mask; null for ordinary elements. */
export function guardOfElement(el: Element | null): GuardKind | null {
  return isFieldElement(el) ? guardOf(classifyField(attributesOf(el))) : null
}

export function isVisible(el: Element): boolean {
  if (!el.isConnected || el.getClientRects().length === 0) return false
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

function isTextLike(el: FieldElement): boolean {
  return el instanceof HTMLInputElement ? TEXT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase()) : el instanceof HTMLTextAreaElement
}

function fieldsIn(root: ParentNode): FieldElement[] {
  return Array.from(root.querySelectorAll('input, select, textarea')).slice(0, MAX_FIELDS).filter(isFieldElement)
}

/**
 * The element whose fields are filled and captured together: the field's
 * <form>, or, for a page without one, the nearest ancestor holding another
 * field (a sign-in drawn with divs), or the body.
 */
export function groupRoot(el: FieldElement): Element {
  if (el.form) return el.form
  let node: Element | null = el.parentElement
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    if (node.querySelectorAll('input:not([type=hidden]), select').length >= 2) return node
  }
  return el.ownerDocument.body ?? el.ownerDocument.documentElement
}

export interface GroupField {
  el: FieldElement
  kind: FieldKind | null
}

export interface Group {
  root: Element
  id: string
  role: FormRole | null
  fields: GroupField[]
}

const ids = new WeakMap<Element, string>()
const roots = new Map<string, WeakRef<Element>>()
let nextId = 1

/** A stable id for a field or a group; the same element keeps its id while the document lives. */
export function idOf(el: Element, prefix: 'f' | 'g'): string {
  let id = ids.get(el)
  if (!id) {
    id = `${prefix}${nextId++}`
    ids.set(el, id)
    if (prefix === 'g') roots.set(id, new WeakRef(el))
  }
  return id
}

export function rootById(id: string): Element | null {
  const root = roots.get(id)?.deref() ?? null
  if (!root) roots.delete(id)
  return root
}

/** The visible fields of a group, classified, and what the group is for. `all` keeps hidden ones too (a form being removed). */
export function readGroup(root: Element, opts: { all?: boolean } = {}): Group {
  const fields = fieldsIn(root)
    .filter((el) => (el.form ? el.form === root || root.contains(el.form) || el.form.contains(root) : true))
    .filter((el) => opts.all || isVisible(el))
    .map((el) => ({ el, kind: kindOf(el) }))
  const texts = fields.filter((f) => isTextLike(f.el)).length
  return { root, id: idOf(root, 'g'), role: formRoleOf(fields.map((f) => f.kind), texts), fields }
}

/** The focused element, through open shadow roots (not into frames: each frame runs its own copy). */
export function deepActiveElement(doc: Document = document): Element | null {
  let el: Element | null = doc.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  return el
}

export function rectOf(el: Element): Bounds {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/** Every visible guarded field's rect in this frame's viewport, clipped to what can be seen. */
export function guardedRects(doc: Document = document): Bounds[] {
  const view = { width: doc.defaultView?.innerWidth ?? 0, height: doc.defaultView?.innerHeight ?? 0 }
  const out: Bounds[] = []
  for (const el of fieldsIn(doc)) {
    if (guardOfElement(el) === null || !isVisible(el)) continue
    const r = rectOf(el)
    if (r.x + r.width <= 0 || r.y + r.height <= 0 || r.x >= view.width || r.y >= view.height) continue
    out.push(r)
    if (out.length >= 500) break
  }
  return out
}

const ADDRESS_PART = new Set<FieldKind>(['given-name', 'additional-name', 'family-name', 'name', 'organization', 'address-line1', 'address-line2', 'address-line3', 'address-level2', 'address-level1', 'postal-code', 'country', 'tel'])

/** Every purpose a group serves: a checkout form can hold an address and a card, or a sign-up and an address. */
export function rolesOf(group: Group): Set<FormRole> {
  const roles = new Set<FormRole>()
  if (group.role) roles.add(group.role)
  const kinds = group.fields.map((f) => f.kind)
  if (kinds.includes('cc-number')) roles.add('card')
  if (kinds.filter((k) => k !== null && ADDRESS_PART.has(k)).length >= 2) roles.add('address')
  return roles
}

/** What a focused field is for within its group, or null when Atelier offers nothing there. */
export function roleForField(kind: FieldKind, group: Group): FormRole | null {
  const roles = rolesOf(group)
  const login = group.role === 'login' || group.role === 'signup' ? group.role : null
  if ((kind === 'username' || kind === 'current-password' || kind === 'new-password') && login) return login
  if (kind.startsWith('cc-') && roles.has('card')) return 'card'
  if ((ADDRESS_PART.has(kind) || kind === 'email') && roles.has('address') && !(kind === 'email' && login)) return 'address'
  if (kind === 'email' && login) return login
  return null
}
