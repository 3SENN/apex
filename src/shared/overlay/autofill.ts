/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Overlay domain `autofill`: the fill popups, the save and update
// cards and the password import hint. Policies and components live in
// src/renderer/src/overlay/surfaces/autofill/index.ts.
import { PASSKEY_ROWS_VISIBLE, type FillPopupProps, type FillRow, type ImportHintProps, type SaveOfferProps } from '../autofill'

export const AUTOFILL_SURFACES = [
  'autofill-login',
  'autofill-card',
  'autofill-address',
  'save-login',
  'save-card',
  'save-address',
  'password-import-hint',
] as const

export type AutofillSurfaceId = (typeof AUTOFILL_SURFACES)[number]

/** Props per autofill surface. */
export interface AutofillSurfaceProps {
  'autofill-login': FillPopupProps
  'autofill-card': FillPopupProps
  'autofill-address': FillPopupProps
  'save-login': SaveOfferProps
  'save-card': SaveOfferProps
  'save-address': SaveOfferProps
  'password-import-hint': ImportHintProps
}

// ── surface helpers ── (pure; the renderer's surfaces use them, and the
// sizes match src/main/autofill/placement.ts, which places them before they draw)

export const ROW_HEIGHT = 44
export const FOOTER_HEIGHT = 36
export const HEADER_HEIGHT = 30
export const POPUP_PADDING = 8

/** The rows a popup lists, and the manage link that sits in its footer. */
export function splitRows(rows: readonly FillRow[]): { items: FillRow[]; manage: FillRow | null } {
  // Passkey rows are designed in but stay hidden until the entitlement exists.
  const items = rows.filter((r) => r.kind !== 'manage' && (r.kind !== 'passkey' || PASSKEY_ROWS_VISIBLE))
  return { items, manage: rows.find((r) => r.kind === 'manage') ?? null }
}

const BRAND_MARK: Record<string, string> = {
  visa: 'VISA',
  mastercard: 'MC',
  amex: 'AMEX',
  discover: 'DISC',
  diners: 'DC',
  jcb: 'JCB',
  unionpay: 'UP',
  maestro: 'MAE',
}

/** The short mark drawn on a card row's chip; null draws a plain card glyph. */
export function brandMark(brand: string | undefined): string | null {
  return (brand && BRAND_MARK[brand]) || null
}

/** The letter on a login row's tile when the site has no icon. */
export function siteInitial(site: string): string {
  const host = site.replace(/^www\./, '')
  const ch = [...host].find((c) => /\p{L}|\p{N}/u.test(c))
  return (ch ?? '•').toLocaleUpperCase()
}

/** True for icons the popup may load: page favicons over http(s) and inline images. */
export function loadableIcon(src: string | undefined): src is string {
  return !!src && /^(https?:|data:image\/)/i.test(src)
}

/** What a pick result asks of the popup: close, show why nothing was filled, or stay as it is. */
export function pickOutcome(result: string): 'close' | 'cancelled' | 'stay' {
  if (result === 'gone') return 'close'
  if (result === 'auth-cancelled') return 'cancelled'
  return 'stay'
}
