/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomInt } from 'node:crypto'
import { PASSKEY_ROWS_VISIBLE, type FillRow } from '@shared/autofill'
import { GENERATED_LENGTH, type AddressView, type CardView, type CredentialView } from '@shared/passwords'
import { currentLocale } from '@shared/i18n/core'
import { mainT } from '../i18n/mainT'

// The rows of each fill popup (OV-26, OV-29). A row names what it fills and
// never carries a password or a card number: picks go back to main by row id.

export const MANAGE_ROW = 'manage'
export const GENERATED_ROW = 'generated'

const BRAND_LABEL: Record<CardView['brand'], string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  maestro: 'Maestro',
  unknown: '',
}

function shortDate(ms: number, now: number): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(ms)
}

export function loginRows(creds: readonly CredentialView[], opts: { favicon: string | null; generated: boolean; now: number; passkeys?: readonly { id: string; username: string }[] }): FillRow[] {
  const rows: FillRow[] = []
  if (opts.generated) rows.push({ id: GENERATED_ROW, kind: 'generated', title: mainT('autofill.popup.generated'), subtitle: mainT('autofill.popup.generatedHint') })
  if (PASSKEY_ROWS_VISIBLE) {
    for (const p of opts.passkeys ?? []) rows.push({ id: `p:${p.id}`, kind: 'passkey', title: p.username || mainT('autofill.popup.noUsername'), subtitle: mainT('autofill.popup.passkey') })
  }
  const sorted = [...creds].sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
  for (const c of sorted) {
    rows.push({
      id: `l:${c.id}`,
      kind: 'login',
      title: c.username || mainT('autofill.popup.noUsername'),
      subtitle: mainT('autofill.popup.changed', { date: shortDate(c.updatedAt, opts.now) }),
      ...(opts.favicon ? { icon: opts.favicon } : {}),
    })
  }
  rows.push({ id: MANAGE_ROW, kind: 'manage', title: mainT('autofill.popup.manage') })
  return rows
}

export function cardRows(cards: readonly CardView[]): FillRow[] {
  const rows: FillRow[] = cards.map((c) => ({
    id: `c:${c.id}`,
    kind: 'card',
    title: `${BRAND_LABEL[c.brand] || mainT('autofill.popup.card')} •••• ${c.last4}`,
    subtitle: [c.holder, mainT('autofill.popup.expires', { date: `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear % 100).padStart(2, '0')}` })].filter(Boolean).join(' · '),
    icon: c.brand,
  }))
  rows.push({ id: MANAGE_ROW, kind: 'manage', title: mainT('autofill.popup.manageCards') })
  return rows
}

export function addressRows(addresses: readonly AddressView[]): FillRow[] {
  const rows: FillRow[] = addresses.map((a) => ({
    id: `a:${a.id}`,
    kind: 'address',
    title: [a.givenName, a.familyName].filter(Boolean).join(' ') || a.organization || a.label,
    subtitle: [a.line1, a.city].filter(Boolean).join(', '),
  }))
  rows.push({ id: MANAGE_ROW, kind: 'manage', title: mainT('autofill.popup.manageAddresses') })
  return rows
}

/** Row ids are '<kind letter>:<record id>'; anything else is not one of ours. */
export function parseRowId(id: string): { kind: 'login' | 'card' | 'address' | 'passkey'; recordId: string } | null {
  const m = /^([lcap]):(.{1,120})$/.exec(id)
  if (!m || !m[2]) return null
  const kind = ({ l: 'login', c: 'card', a: 'address', p: 'passkey' } as const)[m[1] as 'l' | 'c' | 'a' | 'p']
  return { kind, recordId: m[2] }
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '-_.!@#'

/** A strong password: every class present, no look-alike characters, from the OS's CSPRNG. */
export function generatePassword(length: number = GENERATED_LENGTH.default, pick: (max: number) => number = randomInt): string {
  const n = Math.min(GENERATED_LENGTH.max, Math.max(GENERATED_LENGTH.min, Math.round(length)))
  const all = LOWER + UPPER + DIGITS + SYMBOLS
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[pick(set.length)] ?? 'a')
  while (chars.length < n) chars.push(all[pick(all.length)] ?? 'a')
  // Fisher–Yates, so the guaranteed classes aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = pick(i + 1)
    ;[chars[i], chars[j]] = [chars[j] ?? '', chars[i] ?? '']
  }
  return chars.join('')
}
