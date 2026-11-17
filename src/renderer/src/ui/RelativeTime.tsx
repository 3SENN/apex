/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { useNow } from './hooks'
import { cx } from './logic/format'
import { formatAbsolute, formatRelative, type TimeStyle } from './logic/time'

export interface RelativeTimeProps {
  /** Epoch milliseconds, past or future. */
  value: number
  /** 'long' reads "5 min ago"; 'short' reads "5m" for tight rows. */
  style?: TimeStyle
  className?: string
}

/** A relative time that keeps itself current, with the full date as its tooltip. */
export function RelativeTime({ value, style = 'long', className }: RelativeTimeProps): ReactElement {
  const now = useNow()
  if (!Number.isFinite(value)) return <time className={cx('ui-time', className)} />
  return (
    <time dateTime={new Date(value).toISOString()} title={formatAbsolute(value)} className={cx('ui-time', className)}>
      {formatRelative(value, now, style)}
    </time>
  )
}
