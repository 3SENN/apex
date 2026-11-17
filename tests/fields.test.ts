/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  capturedKinds,
  classifyField,
  formRoleOf,
  formatExpiry,
  guardOf,
  luhnValid,
  matchSelectOption,
  normalizeHint,
  parseExpiry,
  type FieldAttributes,
  type FieldKind,
} from '@shared/fields'
import { guardOfDescription, guardOfName } from '../src/main/autofill/agentGuard'
import type { ElementDescription } from '@shared/ipc'

// The page-field classifier against an Atelier-written corpus, plus the
// form roles, guards and fill helpers built on it.

interface Case {
  note?: string
  a: Partial<FieldAttributes>
  kind: FieldKind | null
}

const corpus = JSON.parse(readFileSync(join(__dirname, 'fixtures/autofill/fields.json'), 'utf8')) as { cases: Case[] }

function attrs(a: Partial<FieldAttributes>): FieldAttributes {
  return { tag: 'input', type: 'text', autocomplete: '', name: '', id: '', placeholder: '', label: '', inputMode: '', maxLength: null, ...a }
}

describe('classifyField corpus', () => {
  it('has a real corpus', () => {
    expect(corpus.cases.length).toBeGreaterThan(40)
  })
  for (const c of corpus.cases) {
    it(`${JSON.stringify(c.a)} -> ${String(c.kind)}${c.note ? ` (${c.note})` : ''}`, () => {
      expect(classifyField(attrs(c.a))).toBe(c.kind)
    })
  }
})

describe('normalizeHint', () => {
  it('reads camelCase, snake_case and kebab-case alike', () => {
    expect(normalizeHint('cardNumber')).toBe('card number')
    expect(normalizeHint('card_number')).toBe('card number')
    expect(normalizeHint('card-number')).toBe('card number')
  })
})

describe('guards', () => {
  it('maps kinds to guards', () => {
    expect(guardOf('current-password')).toBe('password')
    expect(guardOf('new-password')).toBe('password')
    expect(guardOf('cc-number')).toBe('card')
    expect(guardOf('cc-exp-month')).toBe('card')
    expect(guardOf('cc-csc')).toBe('cvc')
    expect(guardOf('otp')).toBe('otp')
    expect(guardOf('cc-name')).toBeNull()
    expect(guardOf('email')).toBeNull()
    expect(guardOf(null)).toBeNull()
  })

  it('judges a field by its accessible name', () => {
    expect(guardOfName('Card number')).toBe('card')
    expect(guardOfName('CVC')).toBe('cvc')
    expect(guardOfName('Verification code')).toBe('otp')
    expect(guardOfName('Email')).toBeNull()
    expect(guardOfName('', 'password')).toBe('password')
    expect(guardOfName('Date of birth')).toBeNull()
  })

  const base: ElementDescription = { role: 'textbox', name: '', tag: 'input', inputType: 'text', isPassword: false, isPaymentField: false, formSubmitName: null, inForm: true, formHasPaymentFields: false }

  it('fills ElementDescription.guard from the page flags and the name', () => {
    expect(guardOfDescription({ ...base, isPassword: true, inputType: 'password' })).toBe('password')
    expect(guardOfDescription({ ...base, isPaymentField: true, name: 'Card number' })).toBe('card')
    expect(guardOfDescription({ ...base, isPaymentField: true, name: 'Security code' })).toBe('cvc')
    expect(guardOfDescription({ ...base, name: 'One-time code' })).toBe('otp')
    expect(guardOfDescription({ ...base, name: 'Search' })).toBeNull()
    expect(guardOfDescription({ ...base, guard: 'otp' })).toBe('otp')
    expect(guardOfDescription({ ...base, tag: 'button', role: 'button', name: 'Card number help' })).toBeNull()
    expect(guardOfDescription(null)).toBeNull()
  })
})

describe('formRoleOf', () => {
  it('finds logins, signups, cards and addresses', () => {
    expect(formRoleOf(['username', 'current-password'])).toBe('login')
    expect(formRoleOf(['email', 'new-password', 'new-password'])).toBe('signup')
    expect(formRoleOf(['cc-number', 'cc-exp', 'cc-csc'])).toBe('card')
    expect(formRoleOf(['given-name', 'family-name', 'address-line1', 'postal-code'])).toBe('address')
  })

  it('treats a lone username among few fields as the first page of a split login', () => {
    expect(formRoleOf(['email'], 1)).toBe('login')
    expect(formRoleOf(['email', null, null], 3)).toBeNull()
  })

  it('needs two address parts, and email alone is not one', () => {
    expect(formRoleOf(['email', 'tel'], 5)).toBeNull()
    expect(formRoleOf(['email', 'tel', 'postal-code'], 5)).toBe('address')
  })

  it('never captures the security code', () => {
    expect(capturedKinds('card').has('cc-csc')).toBe(false)
    expect(capturedKinds('card').has('cc-number')).toBe(true)
  })
})

describe('fill helpers', () => {
  it('matches month and year options by number and name', () => {
    const months = [{ value: '', text: 'Month' }, ...['Jan', 'Feb', 'Mar', 'Apr', 'May'].map((m, i) => ({ value: String(i + 1).padStart(2, '0'), text: m }))]
    expect(matchSelectOption(months, '5', 'cc-exp-month')).toBe(5)
    const named = [{ value: 'x', text: 'January' }, { value: 'y', text: 'May' }]
    expect(matchSelectOption(named, '05', 'cc-exp-month')).toBe(1)
    const years = [{ value: '26', text: '2026' }, { value: '27', text: '2027' }]
    expect(matchSelectOption(years, '2027', 'cc-exp-year')).toBe(1)
  })

  it('matches countries by value, text, alternates and prefix', () => {
    const countries = [{ value: 'BE', text: 'Belgium' }, { value: 'NL', text: 'Netherlands' }]
    expect(matchSelectOption(countries, 'NL', 'country')).toBe(1)
    expect(matchSelectOption(countries, 'XX', 'country', ['Belgium'])).toBe(0)
    expect(matchSelectOption(countries, 'Nether', 'country')).toBe(1)
    expect(matchSelectOption(countries, 'Fr', 'country')).toBe(-1)
  })

  it('formats one expiry field the way it asks', () => {
    expect(formatExpiry(5, 2027, { placeholder: 'MM/YY', maxLength: null, type: 'text' })).toBe('05/27')
    expect(formatExpiry(5, 2027, { placeholder: 'MM / YYYY', maxLength: null, type: 'text' })).toBe('05 / 2027')
    expect(formatExpiry(5, 2027, { placeholder: '', maxLength: 4, type: 'text' })).toBe('0527')
    expect(formatExpiry(5, 2027, { placeholder: '', maxLength: null, type: 'month' })).toBe('2027-05')
  })

  it('reads typed expiries', () => {
    expect(parseExpiry('05/27')).toEqual({ month: 5, year: 2027 })
    expect(parseExpiry('5 / 2027')).toEqual({ month: 5, year: 2027 })
    expect(parseExpiry('0527')).toEqual({ month: 5, year: 2027 })
    expect(parseExpiry('2027-05')).toEqual({ month: 5, year: 2027 })
    expect(parseExpiry('13/27')).toBeNull()
    expect(parseExpiry('soon')).toBeNull()
  })

  it('checks card numbers with Luhn', () => {
    expect(luhnValid('4242 4242 4242 4242')).toBe(true)
    expect(luhnValid('4242 4242 4242 4241')).toBe(false)
    expect(luhnValid('1234')).toBe(false)
  })
})
