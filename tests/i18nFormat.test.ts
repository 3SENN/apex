/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@shared/i18n/core'
import { formatBytes, formatDate, formatDateTime, formatDuration, formatList, formatNumber, formatPercent, formatRelativeTime, formatTime } from '@shared/i18n/format'
import { formatAbsolute, formatRelative } from '../src/renderer/src/ui/logic/time'

// The format helpers follow the active language and its region.

const min = 60_000
const hour = 60 * min
const day = 24 * hour
const now = new Date(2026, 9, 29, 15, 5).getTime()

afterEach(() => setLanguage('en'))

describe('format helpers', () => {
  it('formats numbers, percents and sizes per locale', () => {
    setLanguage('en', { locale: 'en-US' })
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatPercent(0.42)).toBe('42%')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1.4 * 1024 * 1024)).toBe('1.4 MB')
    expect(formatBytes(23 * 1024 * 1024)).toBe('23 MB')
    expect(formatBytes(-1)).toBe('0 B')
    setLanguage('nl', { locale: 'nl-NL' })
    expect(formatNumber(1234.5)).toBe('1.234,5')
    expect(formatBytes(1.4 * 1024 * 1024)).toBe('1,4 MB')
    expect(formatBytes(5 * 1024 ** 5)).toBe('5.120 TB')
  })

  it('formats dates and times per locale', () => {
    const at = new Date(2026, 2, 3, 15, 5).getTime()
    setLanguage('en', { locale: 'en-US' })
    expect(formatDate(at, 'medium', now)).toBe('Mar 3')
    expect(formatDate(new Date(2025, 2, 3).getTime(), 'medium', now)).toBe('Mar 3, 2025')
    expect(formatTime(at)).toMatch(/^3:05\sPM$/)
    setLanguage('nl', { locale: 'nl-NL' })
    expect(formatDate(at, 'medium', now)).toBe('3 mrt')
    expect(formatTime(at)).toBe('15:05')
    expect(formatDateTime(at)).toContain('15:05')
  })

  it('says relative times in English and Dutch', () => {
    setLanguage('en')
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * min, now)).toBe('5 min ago')
    expect(formatRelativeTime(now - 4 * day, now)).toBe('4 days ago')
    expect(formatRelativeTime(now - day - hour, now)).toBe('yesterday')
    expect(formatRelativeTime(now + 2 * hour, now, 'short')).toBe('in 2h')
    setLanguage('nl', { locale: 'nl-NL' })
    expect(formatRelativeTime(now - 10_000, now)).toBe('zojuist')
    expect(formatRelativeTime(now - 5 * min, now)).toBe('5 min geleden')
    expect(formatRelativeTime(now - 3 * hour, now)).toBe('3 u geleden')
    expect(formatRelativeTime(now - 4 * day, now)).toBe('4 dagen geleden')
    expect(formatRelativeTime(now - 8 * day, now)).toBe('1 week geleden')
    expect(formatRelativeTime(now - day - hour, now)).toBe('gisteren')
    expect(formatRelativeTime(now + day + hour, now)).toBe('morgen')
    expect(formatRelativeTime(now + 3 * day, now)).toBe('over 3 dagen')
    expect(formatRelativeTime(now - 3 * hour, now, 'short')).toBe('3u')
  })

  it('formats durations and lists', () => {
    setLanguage('en')
    expect(formatDuration(3 * day + 4 * hour)).toBe('3 days 4 h')
    expect(formatList(['a', 'b', 'c'])).toBe('a, b, and c')
    setLanguage('nl', { locale: 'nl' })
    expect(formatDuration(20_000)).toBe('minder dan een minuut')
    expect(formatDuration(2 * hour + 5 * min, 'short')).toBe('2u 5m')
    expect(formatList(['a', 'b', 'c'])).toBe('a, b en c')
  })

  it('keeps the time.ts signatures, now locale-aware', () => {
    setLanguage('nl', { locale: 'nl-NL' })
    expect(formatRelative(now - 5 * min, now)).toBe('5 min geleden')
    expect(formatRelative(new Date(2026, 2, 3).getTime(), now, 'long', 'en-US')).toBe('Mar 3')
    expect(formatAbsolute(new Date(2026, 2, 3, 15, 5).getTime())).toContain('15:05')
    setLanguage('en')
    expect(formatRelative(now - 5 * min, now)).toBe('5 min ago')
  })
})
