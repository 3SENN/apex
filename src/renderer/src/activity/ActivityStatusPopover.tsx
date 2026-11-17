/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The activity-memory status popover (`activity-status`, OV-24, DS-24),
// opened from the toolbar glyph. It says what activity memory is doing and
// that captures stay on this device, pauses it for 15 minutes, an hour,
// three hours or the rest of today, turns it on until tomorrow outside your
// hours, resumes a pause, and links to Settings › Activity memory. Esc or a
// click outside closes it (MENU_POLICY).
import { useId, useState, type ReactElement } from 'react'
import { HardDrive, Settings } from 'lucide-react'
import { nextLocalMidnight, type ActivityStatus } from '@shared/activity'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { Button, ErrorState, SkeletonRows, cx } from '../ui'
import { ActivityMark } from './ActivityGlyph'
import { PAUSE_CHOICES, PAUSE_KEYS, statusLine, whenLabel, type PauseChoice } from './logic'
import { useActivityStatus } from './useActivity'
import './activity.css'

export function ActivityStatusPopover({ close }: SurfaceComponentProps<Record<string, never>>): ReactElement {
  const t = useT()
  const titleId = useId()
  const { status, error, reload } = useActivityStatus()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const now = Date.now()

  const act = async (run: () => Promise<ActivityStatus>, closeAfter = false): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailed(null)
    try {
      await run()
      if (closeAfter) close()
    } catch (err) {
      setFailed(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const pause = (choice: PauseChoice): void => void act(() => call('activity', 'pause', choice === 'today' ? 'today' : Date.now() + choice * 60_000), true)
  const openSettings = (): void => {
    void call('pages', 'open', 'apex://settings/activity')
    close()
  }

  if (error && !status) {
    return (
      <div className="am-pop" role="dialog" aria-label={t('memory.activity.title')}>
        <ErrorState compact message={error} onRetry={reload} />
      </div>
    )
  }
  if (!status) {
    return (
      <div className="am-pop" role="dialog" aria-busy="true" aria-label={t('memory.activity.title')}>
        <SkeletonRows rows={3} label={t('memory.activity.title')} />
      </div>
    )
  }

  const line = statusLine(status, now, t)
  return (
    <div className="am-pop" role="dialog" aria-labelledby={titleId}>
      <header className="am-pop__head">
        <span className={cx('am-pop__mark', `am-pop__mark--${status.state}`)} aria-hidden="true">
          <ActivityMark size={18} />
        </span>
        <div className="am-pop__titles">
          <h2 id={titleId} className="am-pop__title">
            {t('memory.activity.title')}
          </h2>
          <p className="am-pop__state" role="status">
            {line}
          </p>
        </div>
      </header>
      <p className="am-pop__device">
        <HardDrive size={14} aria-hidden />
        {t('memory.activity.onDevice')}
      </p>

      {status.state === 'paused' && (
        <div className="am-pop__section">
          <Button variant="primary" size="sm" fullWidth loading={busy} onClick={() => void act(() => call('activity', 'resume'), true)}>
            {t('memory.activity.resume')}
          </Button>
        </div>
      )}

      {status.state === 'capturing' && (
        <div className="am-pop__section" role="group" aria-labelledby={`${titleId}-pause`}>
          <h3 id={`${titleId}-pause`} className="am-pop__label">
            {t('memory.activity.pause')}
          </h3>
          <div className="am-pop__choices">
            {PAUSE_CHOICES.map((choice) => (
              <button key={String(choice)} type="button" className="am-pop__choice" disabled={busy} onClick={() => pause(choice)}>
                {t(PAUSE_KEYS[choice])}
              </button>
            ))}
          </div>
          {status.overrideUntil !== null && (
            <button type="button" className="am-pop__choice am-pop__choice--wide" disabled={busy} onClick={() => void act(() => call('activity', 'override', { kind: 'none' }))}>
              {t('memory.activity.clearOverride')}
            </button>
          )}
        </div>
      )}

      {status.state === 'outside-hours' && (
        <div className="am-pop__section">
          {status.nextChange !== null && <p className="am-pop__hint">{t('memory.activity.next', { time: whenLabel(status.nextChange, now) })}</p>}
          <Button variant="secondary" size="sm" fullWidth loading={busy} onClick={() => void act(() => call('activity', 'override', { kind: 'on-until', until: nextLocalMidnight(Date.now()) }), true)}>
            {t('memory.activity.onUntilTomorrow')}
          </Button>
        </div>
      )}

      {failed && (
        <p className="am-pop__error" role="alert">
          {failed}
        </p>
      )}

      <footer className="am-pop__foot">
        <button type="button" className="am-pop__link" onClick={openSettings}>
          <Settings size={14} aria-hidden />
          {t('memory.activity.settings')}
        </button>
      </footer>
    </div>
  )
}
