/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { formatExpiry, matchSelectOption, parseExpiry, type FieldKind } from '@shared/fields'
import type { FieldElement, Group } from './dom'

// Filling a group: values by field kind from main, written with the
// native value setter plus input and change events so frameworks see them.
// A single expiry field gets MM/YY in the shape it asks for; month and year
// fields, and <select>s, get their own parts.

const setters = new Map<object, ((this: unknown, v: string) => void) | undefined>()

function nativeSetter(el: FieldElement): ((this: unknown, v: string) => void) | undefined {
  const proto = Object.getPrototypeOf(el) as object
  if (!setters.has(proto)) setters.set(proto, Object.getOwnPropertyDescriptor(proto, 'value')?.set)
  return setters.get(proto)
}

function dispatch(el: FieldElement): void {
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

export function setValue(el: FieldElement, value: string): void {
  const set = nativeSetter(el)
  if (set) set.call(el, value)
  else el.value = value
  dispatch(el)
}

function countryNames(code: string): string[] {
  if (!/^[A-Za-z]{2}$/.test(code)) return []
  const names: string[] = []
  for (const locale of ['en', navigator.language]) {
    try {
      const name = new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase())
      if (name) names.push(name)
    } catch {
      // An unknown locale or region: the code alone is tried.
    }
  }
  return names
}

function selectValue(el: HTMLSelectElement, wanted: string, kind: FieldKind): boolean {
  const options = Array.from(el.options, (o) => ({ value: o.value, text: o.text }))
  const i = matchSelectOption(options, wanted, kind, kind === 'country' ? countryNames(wanted) : [])
  if (i < 0) return false
  const set = nativeSetter(el)
  const value = el.options[i]?.value ?? ''
  if (set) set.call(el, value)
  else el.selectedIndex = i
  dispatch(el)
  return true
}

// Main never sends these, and a page can't make Atelier write them either.
const NEVER_FILLED = new Set<FieldKind>(['cc-csc', 'otp'])

/** The value one field should get, or null to leave it. */
function valueFor(el: FieldElement, kind: FieldKind, values: Partial<Record<FieldKind, string>>): string | null {
  if (kind === 'cc-exp' && el instanceof HTMLInputElement) {
    const exp = values['cc-exp-month'] && values['cc-exp-year'] ? { month: Number(values['cc-exp-month']), year: Number(values['cc-exp-year']) } : values['cc-exp'] ? parseExpiry(values['cc-exp']) : null
    if (!exp) return null
    return formatExpiry(exp.month, exp.year, { placeholder: el.placeholder, maxLength: el.maxLength > 0 ? el.maxLength : null, type: (el.getAttribute('type') ?? '').toLowerCase() })
  }
  if (kind === 'cc-exp-year' && el instanceof HTMLInputElement && values['cc-exp-year']) {
    const year = values['cc-exp-year']
    return el.maxLength > 0 && el.maxLength <= 2 ? year.slice(-2) : year
  }
  // A login's username box may be an email field, and the other way round.
  if (kind === 'email' && values.email === undefined && values.username !== undefined) return values.username
  if (kind === 'username' && values.username === undefined && values.email !== undefined) return values.email
  return values[kind] ?? null
}

/** Fills a group's fields from `values`; returns how many changed. The security code and one-time codes are never filled. */
export function fillGroup(group: Group, values: Partial<Record<FieldKind, string>>): number {
  let filled = 0
  for (const { el, kind } of group.fields) {
    if (!kind || NEVER_FILLED.has(kind) || el.disabled || (!(el instanceof HTMLSelectElement) && el.readOnly)) continue
    // A generated password goes into every new-password box (the password and its confirmation).
    const value = valueFor(el, kind, values)
    if (value === null || value === '') continue
    if (el instanceof HTMLSelectElement) {
      if (selectValue(el, value, kind)) filled++
      continue
    }
    if (el.value === value) continue
    setValue(el, value)
    filled++
  }
  return filled
}
