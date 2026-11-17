/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { capturedKinds, type FieldKind, type FormRole } from '@shared/fields'
import type { SubmitTrigger } from '@shared/autofill'
import { PASSWORD_MAX } from '@shared/passwords'
import { readGroup, rolesOf, type FieldElement, type Group } from './dom'

// Submissions (OV-27, OV-28, OV-29): what a login, card or address form held
// when it was sent. Values come only from those forms, only for the kinds the
// form's role keeps (never the security code or a one-time code), and main
// decides what, if anything, to offer.

export interface Submission {
  form: 'login' | 'card' | 'address'
  values: Partial<Record<FieldKind, string>>
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function fieldValue(el: FieldElement, kind: FieldKind): string {
  if (!(el instanceof HTMLSelectElement)) return el.value
  const option = el.selectedOptions[0]
  if (!option) return ''
  if (kind === 'cc-exp-month') {
    const digits = /\d{1,2}/.exec(option.value) ?? /\d{1,2}/.exec(option.text)
    if (digits) return digits[0]
    const name = MONTHS.findIndex((m) => option.text.trim().toLowerCase().startsWith(m))
    return name >= 0 ? String(name + 1) : ''
  }
  if (kind === 'cc-exp-year') return (/\d{2,4}/.exec(option.value) ?? /\d{2,4}/.exec(option.text) ?? [''])[0]
  // A country select's value is usually its code; otherwise its name is kept.
  return kind === 'country' && /^[A-Za-z]{2}$/.test(option.value) ? option.value : option.text.trim() || option.value
}

function formOf(role: FormRole): Submission['form'] {
  return role === 'signup' ? 'login' : role
}

/** What each purpose of a group held, skipping purposes with nothing worth reporting. */
export function snapshot(group: Group): Submission[] {
  const out: Submission[] = []
  for (const role of rolesOf(group)) {
    const kinds = capturedKinds(role)
    const values: Partial<Record<FieldKind, string>> = {}
    for (const { el, kind } of group.fields) {
      if (!kind || !kinds.has(kind) || kind === 'cc-csc') continue
      const value = fieldValue(el, kind).slice(0, PASSWORD_MAX)
      if (value && values[kind] === undefined) values[kind] = value
    }
    const form = formOf(role)
    const worth =
      form === 'login' ? Boolean(values['current-password'] || values['new-password'] || values.username || values.email) : form === 'card' ? Boolean(values['cc-number']) : Object.keys(values).length >= 2
    if (worth) out.push({ form, values })
  }
  return out
}

const SUBMIT_WORDS = /\b(sign ?in|log ?in|sign ?up|register|continue|next|submit|create|join|pay|place order|checkout|check out|save|confirm|aanmelden|inloggen|anmelden|weiter|volgende)\b/i

/** Whether a click target submits its group: a submit button, or a button-like control named like one. */
export function isSubmitControl(target: Element, root: Element): boolean {
  const control = target.closest('button, input[type=submit], input[type=image], [role=button], a')
  if (!control || !root.contains(control)) return false
  if (control instanceof HTMLButtonElement) return control.type === 'submit' || (control.form === null && SUBMIT_WORDS.test(control.textContent ?? ''))
  if (control instanceof HTMLInputElement) return true
  return SUBMIT_WORDS.test(`${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''}`)
}

export interface Sender {
  (s: Submission, trigger: SubmitTrigger): void
}

/**
 * Watches groups the person typed in: sends them on submit, Enter, a click
 * on a submit control, the group leaving the page, or the page going away.
 * The same values are sent once per few seconds at most.
 */
export class SubmitWatcher {
  readonly #send: Sender
  // Groups typed in, with their last values (a removed form can't be read again reliably).
  readonly #dirty = new Map<Element, Submission[]>()
  #last = { key: '', at: 0 }
  #observer: MutationObserver | null = null

  constructor(send: Sender) {
    this.#send = send
  }

  /** A trusted input in a classified field: remember the group's values. */
  touched(root: Element): void {
    const subs = snapshot(readGroup(root))
    if (subs.length > 0) this.#dirty.set(root, subs)
    else this.#dirty.delete(root)
    this.#watchRemovals()
  }

  isDirty(root: Element): boolean {
    return this.#dirty.has(root)
  }

  dirtyRoots(): Element[] {
    return [...this.#dirty.keys()]
  }

  /** The group is being sent now. */
  submitted(root: Element, trigger: SubmitTrigger): void {
    const subs = snapshot(readGroup(root))
    const sent = subs.length > 0 ? subs : (this.#dirty.get(root) ?? [])
    this.#dirty.delete(root)
    this.#emit(sent, trigger)
  }

  /** The page is going away: everything typed and not yet sent goes now. */
  pageHidden(): void {
    for (const [root, subs] of [...this.#dirty]) {
      this.#dirty.delete(root)
      this.#emit(root.isConnected ? snapshot(readGroup(root, { all: true })) : subs, 'pagehide')
    }
  }

  #emit(subs: Submission[], trigger: SubmitTrigger): void {
    for (const s of subs) {
      const key = `${s.form}:${JSON.stringify(s.values)}`
      const now = Date.now()
      if (key === this.#last.key && now - this.#last.at < 3000) continue
      this.#last = { key, at: now }
      this.#send(s, trigger)
    }
  }

  // A single-page sign-in often swaps the form out instead of navigating.
  #watchRemovals(): void {
    if (this.#observer || this.#dirty.size === 0) return
    this.#observer = new MutationObserver(() => {
      for (const [root, subs] of [...this.#dirty]) {
        if (!gone(root, subs)) continue
        this.#dirty.delete(root)
        this.#emit(subs, 'removed')
      }
      if (this.#dirty.size === 0) {
        this.#observer?.disconnect()
        this.#observer = null
      }
    })
    this.#observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  dispose(): void {
    this.#observer?.disconnect()
    this.#observer = null
    this.#dirty.clear()
  }
}

/** The group left the page, or a login group lost its password box (the step after signing in). */
function gone(root: Element, subs: readonly Submission[]): boolean {
  if (!root.isConnected) return true
  const typedPassword = subs.some((s) => s.form === 'login' && (s.values['current-password'] || s.values['new-password']))
  return typedPassword && root.querySelector('input[type=password]') === null
}
