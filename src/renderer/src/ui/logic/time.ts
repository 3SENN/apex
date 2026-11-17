/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Relative and absolute time labels in Atelier's own wording. The words and
// the date order follow the app language; the bodies live in the shared
// format helpers (src/shared/i18n/format.ts), the signatures stay as they were.
import { currentLocale } from '@shared/i18n/core'
import { formatDateTime, formatDuration as sharedDuration, formatRelativeTime } from '@shared/i18n/format'

export type TimeStyle = 'long' | 'short'

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "2 weeks ago",
 * then a date. Future times read "in 5 min" and so on. The short style is
 * for tight rows: "now", "5m", "3h", "4d", "2w".
 */
export function formatRelative(ms: number, now = Date.now(), style: TimeStyle = 'long', locale?: string): string {
  return formatRelativeTime(ms, now, style, locale ?? currentLocale())
}

/**
 * A length of time in its two largest units, for countdowns:
 * "2 h 5 min" (long) or "2h 5m" (short). Under a minute reads
 * "under a minute" / "<1m".
 */
export function formatDuration(ms: number, style: TimeStyle = 'long'): string {
  return sharedDuration(ms, style)
}

/** The full date and time, for tooltips. */
export function formatAbsolute(ms: number, locale?: string): string {
  return formatDateTime(ms, locale ?? currentLocale())
}
