/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { t } from '@shared/i18n/core'
// Grouping and labels for the History, Bookmarks and Downloads pages.

/** "Today", "Yesterday", or the weekday and date (with the year when it isn't this year). */
export function dayLabel(ms: number, now = Date.now(), locale?: string): string {
  const day = new Date(ms)
  const today = new Date(now)
  const start = (d: Date, back = 0): number => new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()
  const at = start(day)
  if (at === start(today)) return t('settings.collections.today')
  if (at === start(today, 1)) return t('settings.collections.yesterday')
  const sameYear = day.getFullYear() === today.getFullYear()
  return day.toLocaleDateString(locale, sameYear ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

export interface DayGroup<T> {
  label: string
  items: T[]
}

/** Consecutive items under their day's label; the input order is kept (newest first). */
export function groupByDay<T>(items: readonly T[], timeOf: (item: T) => number, now = Date.now(), locale?: string): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  for (const item of items) {
    const label = dayLabel(timeOf(item), now, locale)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** The letter a site's placeholder icon shows. */
export function siteInitial(url: string, title = ''): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host) return host[0]?.toUpperCase() ?? '?'
  } catch {
    // Not a URL; fall back to the title.
  }
  return title.trim()[0]?.toUpperCase() ?? '?'
}
