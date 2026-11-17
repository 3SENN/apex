/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react'
import { formatBytes, formatDate, formatDateTime, formatDuration, formatList, formatNumber, formatPercent, formatRelativeTime, formatTime } from '@shared/i18n/format'
import { useLanguageVersion } from './useT'

// The chrome's locale-aware formatting: dates, relative times, numbers and
// sizes in the app language. The plain functions read the active language;
// useFormat() hands a component the same set and re-renders it on a change.
export { formatBytes, formatDate, formatDateTime, formatDuration, formatList, formatNumber, formatPercent, formatRelativeTime, formatTime }

export interface Formatters {
  number: typeof formatNumber
  percent: typeof formatPercent
  bytes: typeof formatBytes
  date: typeof formatDate
  time: typeof formatTime
  dateTime: typeof formatDateTime
  relative: typeof formatRelativeTime
  duration: typeof formatDuration
  list: typeof formatList
}

export function useFormat(): Formatters {
  const v = useLanguageVersion()
  return useMemo<Formatters>(
    () => ({
      number: formatNumber,
      percent: formatPercent,
      bytes: formatBytes,
      date: formatDate,
      time: formatTime,
      dateTime: formatDateTime,
      relative: formatRelativeTime,
      duration: formatDuration,
      list: formatList,
    }),
    [v],
  )
}
