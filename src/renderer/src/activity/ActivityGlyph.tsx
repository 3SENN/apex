/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The activity-memory glyph (OV-24, DS-24) in the toolbar's
// contextual cluster, on websites only. Hidden while activity memory is
// off; it breathes slowly while capturing (and stays still under reduced
// motion), and rests dimmed while paused or outside your hours. A click opens the
// status popover.
import { useRef, type ReactElement } from 'react'
import { useT } from '../i18n/useT'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import { IconButton, cx } from '../ui'
import { statusLine } from './logic'
import { useActivityStatus } from './useActivity'
import './activity.css'

/** Atelier's own mark: an eye-shaped lens with a pupil, drawn at 16 px like the lucide set. */
export function ActivityMark({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg className="am-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12c2.4-4 5.4-6 9-6s6.6 2 9 6c-2.4 4-5.4 6-9 6s-6.6-2-9-6Z" />
      <circle className="am-mark__pupil" cx="12" cy="12" r="2.6" />
    </svg>
  )
}

export function ActivityGlyph({ visible = true }: { visible?: boolean }): ReactElement | null {
  const t = useT()
  const { status } = useActivityStatus()
  const button = useRef<HTMLButtonElement>(null)
  if (!visible || !status || status.state === 'off') return null
  const label = t('memory.activity.statusLabel', { state: statusLine(status, Date.now(), t) })
  return (
    <IconButton
      ref={button}
      size="md"
      label={label}
      className={cx('am-glyph', `am-glyph--${status.state}`)}
      data-state={status.state}
      aria-haspopup="dialog"
      icon={<ActivityMark />}
      onClick={(e) => {
        void openSurface('activity-status', anchorFromElement(e.currentTarget), {}).catch(() => undefined)
      }}
    />
  )
}
