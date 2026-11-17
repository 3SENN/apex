/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The About page's licence list: licenses.json as scripts/licenses.mjs writes it
// ([{name, version, license, text}]), checked entry by entry so a damaged
// file shows what it can, sorted by name. And the branding's trademark line.

import { format } from '@shared/i18n/core'
import { EN } from '@shared/i18n/en'

export interface LicenseEntry {
  name: string
  version: string
  license: string
  text: string
}

const MAX_ENTRIES = 5000
const MAX_TEXT = 100_000

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)

export function parseLicenses(raw: unknown): LicenseEntry[] {
  if (!Array.isArray(raw)) return []
  const out: LicenseEntry[] = []
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const name = str(r.name, 214)
    if (!name) continue
    out.push({ name, version: str(r.version, 64) ?? '', license: str(r.license, 200) || 'UNKNOWN', text: str(r.text, MAX_TEXT) ?? '' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The branding's trademark line ('' for a branding that claims no marks). The
 * official line is in the catalogues, so it reads in the app language; any
 * other branding's line shows as its branding.json writes it, name filled in.
 */
export function trademarkLine(info: string, translate: (key: 'updates.about.trademarkInfo') => string): string {
  const line = info.trim()
  if (!line) return ''
  return line === EN['updates.about.trademarkInfo'] ? translate('updates.about.trademarkInfo') : format(line)
}
