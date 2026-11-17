/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { CircleAlert, CircleArrowDown, CircleArrowUp } from 'lucide-react'
import { call } from '../api'
import { ProgressRing, Spinner, cx } from '../ui'
import { useT } from '../i18n/useT'
import { clickAction, pillHint, pillKind, pillLabel, percentOf } from './logic/labels'
import { useUpdateStatus } from './useUpdateStatus'
import './updates.css'

// The sidebar footer's update capsule (SH-16, DS-18): a solid profile-hue
// capsule with on-hue text, growing in from the footer's right edge. It shows
// while an update downloads ("Updating 42%" with a determinate ring), waits
// for a go-ahead, is ready ("Restart to update"), restarts, or failed
// ("Update failed", click to try again). Nothing otherwise.
export function UpdatePill(): ReactElement | null {
  const t = useT()
  const status = useUpdateStatus()
  const kind = pillKind(status)
  if (!status || !kind) return null
  const label = pillLabel(kind, status)
  const hint = pillHint(kind, status)

  const onClick = (): void => {
    const action = clickAction(status)
    if (action === 'install') void call('updates', 'install')
    else if (action === 'download') void call('updates', 'download')
    else if (action === 'check') void call('updates', 'check')
    // While downloading, the pill opens About, where the progress and the switch live.
    else if (kind === 'downloading') void call('pages', 'open', 'apex://settings/about')
  }

  const icon =
    kind === 'downloading' ? (
      <ProgressRing value={status.progress ?? 0} size={14} stroke={2} className="update-pill__ring" />
    ) : kind === 'installing' ? (
      <Spinner size={12} className="update-pill__spinner" />
    ) : kind === 'failed' ? (
      <CircleAlert size={14} aria-hidden />
    ) : kind === 'available' ? (
      <CircleArrowDown size={14} aria-hidden />
    ) : (
      <CircleArrowUp size={14} aria-hidden />
    )

  return (
    <button
      type="button"
      className={cx('footer-capsule', 'update-pill', `update-pill--${kind}`)}
      onClick={onClick}
      disabled={kind === 'installing'}
      title={hint}
      aria-description={hint}
      data-update-pill={kind}
      data-percent={kind === 'downloading' ? percentOf(status) : undefined}
    >
      {icon}
      <span className="update-pill__label" aria-live="polite">
        {label}
      </span>
      {kind === 'failed' && <span className="ui-sr-only">{t('updates.about.tryAgain')}</span>}
    </button>
  )
}
