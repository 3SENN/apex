/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Locale-aware formatting: numbers, sizes, dates, times, relative times
// and lists in the active app language (currentLocale()). Word labels come
// from the catalogue (core.time.*, core.size.*), so Dutch reads "3 dagen
// geleden" and the en-XA pseudo-locale shows them accented. Every helper takes
// an optional locale for tests and for callers that format for someone else.
import { currentLocale, t } from './core'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>()

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(kind: 'n' | 'd', locale: string, options: object, make: (l: string) => T): T {
  const id = `${kind}|${locale}|${JSON.stringify(options)}`
  let hit = cache.get(id) as T | undefined
  if (!hit) {
    try {
      hit = make(locale)
    } catch {
      hit = make('en')
    }
    if (cache.size > 200) cache.clear()
    cache.set(id, hit)
  }
  return hit
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached('n', locale, options, (l) => new Intl.NumberFormat(l, options))
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached('d', locale, options, (l) => new Intl.DateTimeFormat(l, options))
}

/** 1234.5 → "1,234.5" (en) or "1.234,5" (nl). */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions, locale = currentLocale()): string {
  return numberFormat(locale, options).format(n)
}

/** 0.42 → "42%" (en) or "42%" (nl), whole percents unless `digits` says otherwise. */
export function formatPercent(fraction: number, digits = 0, locale = currentLocale()): string {
  return numberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(fraction)
}

const SIZE_KEYS = ['core.size.kb', 'core.size.mb', 'core.size.gb', 'core.size.tb'] as const

/** "512 B", "1.4 MB" (en), "1,4 MB" (nl): binary steps, one decimal under ten. */
export function formatBytes(bytes: number, locale = currentLocale()): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  if (safe < 1024) return t('core.size.bytes', { n: formatNumber(Math.round(safe), undefined, locale) })
  let value = safe / 1024
  let unit = 0
  while (value >= 1024 && unit < SIZE_KEYS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = value < 10 ? 1 : 0
  return t(SIZE_KEYS[unit] ?? 'core.size.tb', { n: formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits }, locale) })
}

export type DateStyle = 'short' | 'medium' | 'long'

/** A calendar date: "Mar 3" this year, "Mar 3, 2025" otherwise (medium); "3 mrt." in Dutch. */
export function formatDate(ms: number, style: DateStyle = 'medium', now = Date.now(), locale = currentLocale()): string {
  if (style === 'long') return dateFormat(locale, { dateStyle: 'long' }).format(ms)
  if (style === 'short') return dateFormat(locale, { dateStyle: 'short' }).format(ms)
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return dateFormat(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(ms)
}

/** A weekday's name, 0 = Sunday: "Mon" or "Monday" (en), "ma" or "maandag" (nl). */
export function formatWeekday(day: number, style: 'short' | 'long' = 'short', locale = currentLocale()): string {
  if (!Number.isInteger(day) || day < 0 || day > 6) return ''
  // 4 January 2026 was a Sunday.
  return dateFormat(locale, { weekday: style, timeZone: 'UTC' }).format(Date.UTC(2026, 0, 4 + day))
}

/** The clock time in the locale's own style: "3:05 PM" (en-US), "15:05" (nl). */
export function formatTime(ms: number, locale = currentLocale()): string {
  return dateFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(ms)
}

/** The full date and time, for tooltips. */
export function formatDateTime(ms: number, locale = currentLocale()): string {
  return dateFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}

export type RelativeStyle = 'long' | 'short'

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "2 weeks ago",
 * then a date; future times read "in 5 min". The short style is for tight
 * rows: "now", "5m", "3h", "4d", "2w". Words come from the catalogue.
 */
export function formatRelativeTime(ms: number, now = Date.now(), style: RelativeStyle = 'long', locale = currentLocale()): string {
  const diff = now - ms
  const future = diff < 0
  const abs = Math.abs(diff)
  const short = style === 'short'
  if (abs < 45_000) return short ? t('core.time.now') : t('core.time.justNow')
  if (abs >= 5 * WEEK) return formatDate(ms, 'medium', now, locale)

  let span: string
  if (abs < HOUR) {
    const n = Math.max(1, Math.floor(abs / MINUTE))
    span = t(short ? 'core.time.minutes.short' : 'core.time.minutes', { n })
  } else if (abs < DAY) {
    const n = Math.floor(abs / HOUR)
    span = t(short ? 'core.time.hours.short' : 'core.time.hours', { n })
  } else if (abs < WEEK) {
    const n = Math.floor(abs / DAY)
    if (n === 1 && !short) return future ? t('core.time.tomorrow') : t('core.time.yesterday')
    span = t(short ? 'core.time.days.short' : 'core.time.days', { n })
  } else {
    const n = Math.floor(abs / WEEK)
    span = t(short ? 'core.time.weeks.short' : 'core.time.weeks', { n })
  }
  if (future) return t('core.time.in', { span })
  return short ? span : t('core.time.ago', { span })
}

/**
 * A length of time in its two largest units, for countdowns: "2 h 5 min"
 * (long) or "2h 5m" (short). Under a minute reads "under a minute" / "<1m".
 */
export function formatDuration(ms: number, style: RelativeStyle = 'long'): string {
  const short = style === 'short'
  const total = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (total < MINUTE) return short ? t('core.time.underMinute.short') : t('core.time.underMinute')
  const days = Math.floor(total / DAY)
  const hours = Math.floor((total % DAY) / HOUR)
  const minutes = Math.floor((total % HOUR) / MINUTE)
  const parts: string[] = []
  if (days) parts.push(t(short ? 'core.time.days.short' : 'core.time.days', { n: days }))
  if (hours) parts.push(t(short ? 'core.time.hours.short' : 'core.time.hours', { n: hours }))
  if (minutes && !days) parts.push(t(short ? 'core.time.minutes.short' : 'core.time.minutes', { n: minutes }))
  return parts.slice(0, 2).join(' ')
}

/** "a, b and c" (en) or "a, b en c" (nl). */
export function formatList(items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction', locale = currentLocale()): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type }).format(items)
  } catch {
    return items.join(', ')
  }
}
