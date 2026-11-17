/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AutofillSettings } from '@shared/autofill'
import { luhnValid, parseExpiry } from '@shared/fields'
import type { AddressInput, AddressView, CardBrand, CardView } from '@shared/passwords'

// Whether to offer to save what a form submitted (OV-27, OV-29). Pure: the
// controller gathers the facts, these decide.

export type SaveDecision = { kind: 'new' } | { kind: 'update'; id: string } | { kind: 'same'; id: string } | null

export interface LoginFacts {
  settings: Pick<AutofillSettings, 'offerSave'>
  agentControlled: boolean
  neverSave: boolean
  username: string
  password: string
  decision: SaveDecision
}

export type LoginOffer = { mode: 'save' } | { mode: 'update'; id: string } | { mode: 'used'; id: string } | null

/**
 * Apex's own password offers step aside for a password extension: while a
 * running extension holds the browser's password saving off (Apple
 * Passwords does through chrome.privacy) and the person lets it
 * (yieldToPasswordExtension), Apex neither suggests saved or generated
 * passwords nor offers to save one. Address and card autofill are untouched.
 */
export function stepAsideForPasswordExtension(settings: AutofillSettings, heldBy: string | null): AutofillSettings {
  if (!heldBy || !settings.yieldToPasswordExtension) return settings
  return { ...settings, offerLogins: false, offerSave: false, offerGenerated: false }
}

/** 'used' means the login is already saved as typed: mark it used, offer nothing. */
export function decideLoginOffer(f: LoginFacts): LoginOffer {
  if (f.agentControlled || !f.password) return null
  if (f.decision?.kind === 'same') return { mode: 'used', id: f.decision.id }
  if (!f.settings.offerSave || f.neverSave || !f.decision) return null
  return f.decision.kind === 'new' ? { mode: 'save' } : { mode: 'update', id: f.decision.id }
}

/** A login's username and password out of submitted values; a password page takes the remembered first-page username. */
export function loginFromValues(values: Record<string, string>, rememberedUsername: string | null): { username: string; password: string } | null {
  const password = values['new-password'] || values['current-password'] || ''
  const username = values.username || values.email || rememberedUsername || ''
  if (!password && !username) return null
  return { username: username.trim(), password }
}

// ── cards ──

export function brandOf(number: string): CardBrand {
  const d = number.replace(/\D/g, '')
  if (/^4/.test(d)) return 'visa'
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return 'mastercard'
  if (/^3[47]/.test(d)) return 'amex'
  if (/^(6011|65|64[4-9])/.test(d)) return 'discover'
  if (/^3(0[0-5]|[68])/.test(d)) return 'diners'
  if (/^35(2[89]|[3-8])/.test(d)) return 'jcb'
  if (/^62/.test(d)) return 'unionpay'
  if (/^(5018|5020|5038|6304|6759|676[1-3])/.test(d)) return 'maestro'
  return 'unknown'
}

export interface SubmittedCard {
  number: string
  holder: string
  expMonth: number
  expYear: number
}

/** A card out of submitted values (the security code is never among them). */
export function cardFromValues(values: Record<string, string>): SubmittedCard | null {
  const number = (values['cc-number'] ?? '').replace(/\D/g, '')
  if (!luhnValid(number)) return null
  let exp = values['cc-exp'] ? parseExpiry(values['cc-exp']) : null
  if (!exp && values['cc-exp-month'] && values['cc-exp-year']) {
    exp = parseExpiry(`${values['cc-exp-month']}/${values['cc-exp-year']}`)
  }
  if (!exp) return null
  return { number, holder: (values['cc-name'] ?? '').trim(), expMonth: exp.month, expYear: exp.year }
}

export interface CardFacts {
  settings: Pick<AutofillSettings, 'cards'>
  agentControlled: boolean
  secure: boolean
  certificateException: boolean
  card: SubmittedCard | null
  saved: readonly CardView[]
  offerAllowed: boolean
}

export function decideCardOffer(f: CardFacts): boolean {
  if (!f.card || !f.settings.cards || f.agentControlled || !f.secure || f.certificateException || !f.offerAllowed) return false
  const last4 = f.card.number.slice(-4)
  const brand = brandOf(f.card.number)
  return !f.saved.some((c) => c.last4 === last4 && (c.brand === brand || c.brand === 'unknown') && c.expMonth === f.card?.expMonth && c.expYear === f.card?.expYear)
}

export function maskedNumber(number: string): string {
  return `•••• ${number.replace(/\D/g, '').slice(-4)}`
}

// ── addresses ──

export function addressFromValues(values: Record<string, string>): AddressInput {
  const v = (k: string): string => (values[k] ?? '').trim()
  let givenName = v('given-name')
  let familyName = v('family-name')
  if (!givenName && !familyName && v('name')) {
    // A single name field: the last word is the family name.
    const parts = v('name').split(/\s+/)
    familyName = parts.length > 1 ? (parts.pop() ?? '') : ''
    givenName = parts.join(' ')
  }
  return {
    givenName,
    additionalName: v('additional-name'),
    familyName,
    organization: v('organization'),
    line1: v('address-line1'),
    line2: v('address-line2'),
    line3: v('address-line3'),
    city: v('address-level2'),
    region: v('address-level1'),
    postalCode: v('postal-code'),
    country: v('country').length === 2 ? v('country').toUpperCase() : v('country'),
    email: v('email'),
    tel: v('tel'),
  }
}

/** Enough to be worth keeping: a name, a street line, and a city or postal code. */
export function addressComplete(a: AddressInput): boolean {
  return Boolean((a.givenName || a.familyName) && a.line1 && (a.city || a.postalCode))
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ')
}

export interface AddressFacts {
  settings: Pick<AutofillSettings, 'addresses'>
  agentControlled: boolean
  address: AddressInput
  saved: readonly AddressView[]
}

export function decideAddressOffer(f: AddressFacts): boolean {
  if (!f.settings.addresses || f.agentControlled || !addressComplete(f.address)) return false
  return !f.saved.some((s) => same(s.line1, f.address.line1) && same(s.postalCode, f.address.postalCode) && same(s.familyName, f.address.familyName))
}

/** The fill values for a saved address, by field kind. */
export function addressValues(a: AddressInput): Record<string, string> {
  const name = [a.givenName, a.additionalName, a.familyName].filter(Boolean).join(' ')
  const out: Record<string, string> = {
    'given-name': a.givenName,
    'additional-name': a.additionalName,
    'family-name': a.familyName,
    name,
    organization: a.organization,
    'address-line1': a.line1,
    'address-line2': a.line2,
    'address-line3': a.line3,
    'address-level2': a.city,
    'address-level1': a.region,
    'postal-code': a.postalCode,
    country: a.country,
    email: a.email,
    tel: a.tel,
  }
  for (const key of Object.keys(out)) if (!out[key]) delete out[key]
  return out
}
