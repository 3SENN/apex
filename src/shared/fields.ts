/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The field model autofill and the agent guard share: what kind of
// value a form field holds, and whether it is guarded (passwords, cards,
// security codes and one-time codes are never handed to the agent).
// Everything here is pure, so the page preload, main and
// the tests use the same rules.

export type FieldKind =
  | 'username'
  | 'email'
  | 'current-password'
  | 'new-password'
  | 'otp'
  | 'cc-number'
  | 'cc-name'
  | 'cc-exp'
  | 'cc-exp-month'
  | 'cc-exp-year'
  | 'cc-csc'
  | 'given-name'
  | 'additional-name'
  | 'family-name'
  | 'name'
  | 'organization'
  | 'address-line1'
  | 'address-line2'
  | 'address-line3'
  | 'address-level2'
  | 'address-level1'
  | 'postal-code'
  | 'country'
  | 'tel'

export type GuardKind = 'password' | 'card' | 'cvc' | 'otp'

/** What a frame reads off an input to classify it. */
export interface FieldAttributes {
  tag: 'input' | 'select' | 'textarea'
  type: string
  autocomplete: string
  name: string
  id: string
  placeholder: string
  /** The text of its <label>, aria-label or aria-labelledby. */
  label: string
  inputMode: string
  maxLength: number | null
}

/** What a group of fields is for, from the kinds in it. */
export type FormRole = 'login' | 'signup' | 'card' | 'address'

// HTML's autofill field names that map onto a kind outright.
const AUTOCOMPLETE: Record<string, FieldKind> = {
  username: 'username',
  email: 'email',
  'current-password': 'current-password',
  'new-password': 'new-password',
  'one-time-code': 'otp',
  'cc-number': 'cc-number',
  'cc-name': 'cc-name',
  'cc-given-name': 'cc-name',
  'cc-family-name': 'cc-name',
  'cc-exp': 'cc-exp',
  'cc-exp-month': 'cc-exp-month',
  'cc-exp-year': 'cc-exp-year',
  'cc-csc': 'cc-csc',
  'given-name': 'given-name',
  'additional-name': 'additional-name',
  'family-name': 'family-name',
  name: 'name',
  organization: 'organization',
  'street-address': 'address-line1',
  'address-line1': 'address-line1',
  'address-line2': 'address-line2',
  'address-line3': 'address-line3',
  'address-level2': 'address-level2',
  'address-level1': 'address-level1',
  'postal-code': 'postal-code',
  country: 'country',
  'country-name': 'country',
  tel: 'tel',
  'tel-national': 'tel',
  'tel-local': 'tel',
}

// Field names that are real autofill tokens but none of Apex's kinds. They
// stop the heuristics, so a birthday or a promo field is never guessed as a card.
const KNOWN_OTHER = new Set([
  'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo', 'impp', 'language', 'nickname',
  'honorific-prefix', 'honorific-suffix', 'organization-title', 'cc-type', 'transaction-currency',
  'transaction-amount', 'address-level3', 'address-level4', 'tel-country-code', 'tel-area-code',
  'tel-local-prefix', 'tel-local-suffix', 'tel-extension',
])

const NOT_FILLABLE = new Set(['hidden', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color', 'search', 'date', 'datetime-local', 'time', 'week'])

/** Splits camelCase and separators so 'cardNumber', 'card_number' and 'card-number' read alike. */
export function normalizeHint(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_\-.[\]:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const RX = {
  never: /\b(birth|birthday|bday|dob|date of birth|geboorte|geburt|promo|coupon|discount|voucher|gift|referral|captcha|search)\b/,
  otp: /\b(one ?time|otp|totp|2fa|two ?factor|mfa|verification code|verify code|auth(entication)? code|sms code|passcode|security code (sent|we sent)|code (sent|we sent)|enter (the )?code)\b/,
  csc: /\b(cvv2?|cvc2?|csc|cvn|cid|card (security|verification|validation) (code|number|value)|security code|card code)\b/,
  ccNumber: /\b(card ?num(ber)?|cc ?num(ber)?|ccnum|cc ?no|card ?no|credit ?card( number)?|debit ?card( number)?|kaartnummer|kartennummer|numero de (la )?(tarjeta|carte)|pan)\b/,
  ccName: /\b((card|cc) ?(holder|owner)( name)?|name on (the )?card|cardholder|holder ?name|card ?name|cc ?name)\b/,
  exp: /\b(exp|expir\w*|expiry|valid (thru|through|until|to)|gultig|geldig)\b/,
  month: /\b(month|mm|mon|maand|monat|mes|mois)\b/,
  year: /\b(year|yy|yyyy|jaar|jahr|ano|annee)\b/,
  mmYy: /^\s*mm\s*\/?\s*(yy|yyyy|jj|aa)\s*$/,
  newPassword: /\b(new|confirm|repeat|retype|re ?enter|choose|create|verify|again|nieuw|neues?)\b/,
  pin: /\b(pin)\b/,
  email: /\b(e ?mail|email address)\b/,
  username: /\b(user ?name|user ?id|login( id| name)?|account( name| id)?|user|benutzer(name)?|gebruikersnaam|sign ?in( id)?|member ?id|log ?in)\b/,
  givenName: /\b(first ?name|given ?name|fname|forename|vorname|voornaam|prenom|nombre)\b/,
  familyName: /\b(last ?name|family ?name|surname|lname|nachname|achternaam|apellidos?)\b/,
  additionalName: /\b(middle ?name|mname|additional ?name|middle initial)\b/,
  fullName: /\b(full ?name|your name|name|naam)\b/,
  notName: /\b(user ?name|company|business|organi[sz]ation|file|display|screen|nick ?name|domain|host|card|holder|account)\b/,
  organization: /\b(company|organi[sz]ation|business( name)?|firm|bedrijf|firma|employer)\b/,
  line3: /\b(address ?(line)? ?3|addr ?3|street ?3)\b/,
  line2: /\b(address ?(line)? ?2|addr ?2|street ?2|apt|apartment|suite|unit|flat|floor|building|toevoeging)\b/,
  line1: /\b(address ?(line)? ?1?|addr ?1?|street( address)?|strasse|stra(ss|ß)e|adres|direccion|house ?(number|no)|address)\b/,
  notAddress: /\b(e ?mail|ip|web|url|mac|wallet|billing (same|as))\b/,
  city: /\b(city|town|locality|suburb|stadt|ort|plaats|woonplaats|ville|ciudad)\b/,
  region: /\b(state|province|region|county|prefecture|provincie|bundesland)\b/,
  postal: /\b(zip( ?code)?|postal( ?code)?|post ?code|postcode|plz|postleitzahl|cap)\b/,
  country: /\b(country|nation|land|pais|pays)\b/,
  tel: /\b(phone|mobile|tel|telephone|cell|telefoon|telefon|handy)\b/,
}

function fromAutocomplete(autocomplete: string): FieldKind | 'other' | null {
  const tokens = autocomplete.toLowerCase().split(/\s+/).filter(Boolean)
  for (const token of tokens) {
    const kind = AUTOCOMPLETE[token]
    if (kind) return kind
    if (KNOWN_OTHER.has(token)) return 'other'
  }
  return null
}

/** The kind of a password-typed field: a card code or one-time code hiding behind type=password stays what it is. */
function passwordKind(hint: string, a: FieldAttributes): FieldKind {
  if (RX.otp.test(hint)) return 'otp'
  if (RX.csc.test(hint) || (a.maxLength !== null && a.maxLength > 0 && a.maxLength <= 4 && /\b(cvv|cvc|code)\b/.test(hint))) return 'cc-csc'
  if (RX.pin.test(hint) && a.maxLength !== null && a.maxLength <= 8) return 'otp'
  return RX.newPassword.test(hint) ? 'new-password' : 'current-password'
}

function expiryKind(hint: string, a: FieldAttributes): FieldKind {
  if (a.type === 'month') return 'cc-exp'
  if (RX.month.test(hint) && !RX.year.test(hint)) return 'cc-exp-month'
  if (RX.year.test(hint) && !RX.month.test(hint)) return 'cc-exp-year'
  return 'cc-exp'
}

/**
 * The kind of value a field holds, or null for ordinary fields. Autocomplete
 * tokens come first (including `section-`, `shipping` and `billing`); then the
 * label, name, id and placeholder. Birthday fields are never card fields, and
 * `autocomplete="off"` never hides a guarded field.
 */
export function classifyField(a: FieldAttributes): FieldKind | null {
  const type = a.type.toLowerCase()
  if (a.tag === 'input' && NOT_FILLABLE.has(type)) return null
  const token = fromAutocomplete(a.autocomplete)
  if (token === 'other') return type === 'password' ? 'current-password' : null
  if (token) return token

  const hint = normalizeHint([a.label, a.name, a.id, a.placeholder].filter(Boolean).join(' '))
  if (type === 'password') return passwordKind(hint, a)
  if (RX.never.test(hint)) return null
  if (RX.otp.test(hint) || (/^(otp|code|token|pin)$/.test(normalizeHint(a.name)) && a.maxLength !== null && a.maxLength >= 4 && a.maxLength <= 8)) return 'otp'
  if (RX.csc.test(hint)) return 'cc-csc'
  if (RX.ccNumber.test(hint)) return 'cc-number'
  if (RX.ccName.test(hint)) return 'cc-name'
  if (RX.exp.test(hint) || RX.mmYy.test(normalizeHint(a.placeholder).replace(/ /g, '/'))) return expiryKind(hint, a)
  if (type === 'email' || RX.email.test(hint)) return 'email'
  if (RX.username.test(hint)) return 'username'
  if (RX.givenName.test(hint)) return 'given-name'
  if (RX.familyName.test(hint)) return 'family-name'
  if (RX.additionalName.test(hint)) return 'additional-name'
  if (RX.organization.test(hint)) return 'organization'
  if (RX.fullName.test(hint) && !RX.notName.test(hint)) return 'name'
  if (!RX.notAddress.test(hint)) {
    if (RX.line3.test(hint)) return 'address-line3'
    if (RX.line2.test(hint)) return 'address-line2'
    if (RX.line1.test(hint)) return 'address-line1'
  }
  if (RX.city.test(hint)) return 'address-level2'
  if (RX.postal.test(hint)) return 'postal-code'
  if (RX.region.test(hint)) return 'address-level1'
  if (RX.country.test(hint)) return 'country'
  if (type === 'tel' || RX.tel.test(hint)) return 'tel'
  return null
}

/** Which guard a kind falls under; null for fields the agent may read and fill. */
export function guardOf(k: FieldKind | null): GuardKind | null {
  switch (k) {
    case 'current-password':
    case 'new-password':
      return 'password'
    case 'cc-number':
    case 'cc-exp':
    case 'cc-exp-month':
    case 'cc-exp-year':
      return 'card'
    case 'cc-csc':
      return 'cvc'
    case 'otp':
      return 'otp'
    default:
      return null
  }
}

const LOGIN_KINDS = new Set<FieldKind>(['username', 'email', 'current-password', 'new-password'])
const CARD_KINDS = new Set<FieldKind>(['cc-number', 'cc-name', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc'])
const ADDRESS_KINDS = new Set<FieldKind>([
  'given-name', 'additional-name', 'family-name', 'name', 'organization', 'address-line1', 'address-line2',
  'address-line3', 'address-level2', 'address-level1', 'postal-code', 'country', 'tel', 'email',
])

export function isLoginKind(k: FieldKind): boolean {
  return LOGIN_KINDS.has(k)
}

export function isCardKind(k: FieldKind): boolean {
  return CARD_KINDS.has(k)
}

export function isAddressKind(k: FieldKind): boolean {
  return ADDRESS_KINDS.has(k)
}

/**
 * What a group of fields is for. Passwords make it a login (two new-password
 * fields or a new-password field make it a signup); a card number makes it a
 * card form; two or more address parts (email alone doesn't count) make it an
 * address form; a lone username or email field among few text fields is the
 * first page of a split login.
 */
export function formRoleOf(kinds: readonly (FieldKind | null)[], textFieldCount = kinds.length): FormRole | null {
  const present = kinds.filter((k): k is FieldKind => k !== null)
  const has = (k: FieldKind): boolean => present.includes(k)
  if (has('new-password')) return 'signup'
  if (has('current-password')) return 'login'
  if (has('cc-number')) return 'card'
  const addressParts = present.filter((k) => ADDRESS_KINDS.has(k) && k !== 'email').length
  if (addressParts >= 2) return 'address'
  if ((has('username') || has('email')) && textFieldCount <= 2) return 'login'
  return null
}

/** The fields a role fills and captures: never the card security code. */
export function capturedKinds(role: FormRole): ReadonlySet<FieldKind> {
  if (role === 'card') return new Set([...CARD_KINDS].filter((k) => k !== 'cc-csc'))
  if (role === 'address') return ADDRESS_KINDS
  return LOGIN_KINDS
}

// ── fill helpers ──

export interface OptionLike {
  value: string
  text: string
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * The index of the <option> that best matches a value, or -1. Months and
 * years match by number (5, 05, May, 2027, 27); other values by value, then
 * text, then any of the alternates (a country's names), then a prefix.
 */
export function matchSelectOption(options: readonly OptionLike[], wanted: string, kind: FieldKind | null, alternates: readonly string[] = []): number {
  if (kind === 'cc-exp-month') {
    const month = Number(wanted)
    return options.findIndex((o) => monthOf(o) === month)
  }
  if (kind === 'cc-exp-year') {
    const year = Number(wanted) % 100
    return options.findIndex((o) => {
      const n = Number((/\d{2,4}/.exec(o.value) ?? /\d{2,4}/.exec(o.text) ?? [''])[0])
      return Number.isFinite(n) && n > 0 && n % 100 === year
    })
  }
  const targets = [wanted, ...alternates].map(fold).filter(Boolean)
  if (targets.length === 0) return -1
  for (const pick of [(o: OptionLike) => fold(o.value), (o: OptionLike) => fold(o.text)]) {
    for (const target of targets) {
      const i = options.findIndex((o) => pick(o) === target)
      if (i >= 0) return i
    }
  }
  const first = targets[0] ?? ''
  if (first.length >= 3) return options.findIndex((o) => fold(o.text).startsWith(first))
  return -1
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function monthOf(o: OptionLike): number | null {
  for (const raw of [o.value, o.text]) {
    const text = raw.trim().toLowerCase()
    const digits = /^\d{1,2}\b/.exec(text)
    if (digits) {
      const n = Number(digits[0])
      if (n >= 1 && n <= 12) return n
    }
    const name = MONTH_NAMES.findIndex((m) => text.startsWith(m) || text.includes(` ${m}`))
    if (name >= 0) return name + 1
  }
  return null
}

/** How a single expiry field wants it: MM/YY by default, MM/YYYY or MMYY when the field says so. */
export function formatExpiry(month: number, year: number, hint: { placeholder: string; maxLength: number | null; type: string }): string {
  const mm = String(month).padStart(2, '0')
  if (hint.type === 'month') return `${year}-${mm}`
  const long = /yyyy|jjjj|aaaa/i.test(hint.placeholder) || (hint.maxLength !== null && hint.maxLength >= 7 && !/yy/i.test(hint.placeholder))
  const yy = long ? String(year) : String(year % 100).padStart(2, '0')
  if (hint.maxLength === 4) return `${mm}${String(year % 100).padStart(2, '0')}`
  const roomy = hint.maxLength === null || hint.maxLength >= mm.length + yy.length + 3
  const sep = /\s\/\s/.test(hint.placeholder) && roomy ? ' / ' : '/'
  return `${mm}${sep}${yy}`
}

/** Reads a typed expiry ('05/27', '5 / 2027', '0527', '2027-05') as a month and a four-digit year. */
export function parseExpiry(text: string): { month: number; year: number } | null {
  const t = text.trim()
  let m: RegExpExecArray | null
  let month: number
  let year: number
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(t))) {
    year = Number(m[1])
    month = Number(m[2])
  } else if ((m = /^(\d{1,2})\s*[/\-.\s]\s*(\d{2}|\d{4})$/.exec(t))) {
    month = Number(m[1])
    year = Number(m[2])
  } else if ((m = /^(\d{2})(\d{2})$/.exec(t))) {
    month = Number(m[1])
    year = Number(m[2])
  } else {
    return null
  }
  if (year < 100) year += 2000
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null
  return { month, year }
}

/** The Luhn check card numbers carry. */
export function luhnValid(number: string): boolean {
  const digits = number.replace(/\D/g, '')
  if (digits.length < 12 || digits.length > 19) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}
