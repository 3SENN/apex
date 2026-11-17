/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Clear activity memory (ST-51): today, the last 7 days or all time, each
// with the dates it covers, then a report of how many items were deleted.
import { useId, useState, type ReactElement } from 'react'
import { clearRange } from '@shared/activity'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, Dialog } from '../ui'
import { CLEAR_CHOICES, clearRangeText, type ClearChoice } from './logic'

const LABEL = { today: 'memory.activity.clearToday', week: 'memory.activity.clearWeek', all: 'memory.activity.clearAll' } as const

export function ClearDialog({ onClose, onCleared }: { onClose(): void; onCleared(deleted: number): void }): ReactElement {
  const t = useT()
  const ids = useId()
  const [choice, setChoice] = useState<ClearChoice>('today')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<{ deleted: number; text: string } | null>(null)
  const now = Date.now()

  const clear = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await call('activity', 'clear', choice)
      setReport({ deleted: result.deleted, text: clearRangeText(result, Date.now(), t) })
      onCleared(result.deleted)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (report) {
    return (
      <Dialog
        open
        onClose={onClose}
        size="sm"
        title={t('memory.activity.clear')}
        footer={
          <Button variant="primary" onClick={onClose} data-autofocus>
            {t('memory.activity.clearDone')}
          </Button>
        }
      >
        <p className="am-clear__report" role="status">
          {t('memory.activity.cleared', { count: report.deleted })} <span className="am-clear__range">{report.text}</span>
        </p>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={t('memory.activity.clear')}
      description={t('memory.activity.clearHint')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('memory.build.cancel')}
          </Button>
          <Button variant="danger" onClick={() => void clear()} loading={busy}>
            {t('memory.activity.clearConfirm')}
          </Button>
        </>
      }
    >
      <div className="am-clear" role="radiogroup" aria-labelledby={`${ids}-label`}>
        <span id={`${ids}-label`} className="am-visually-hidden">
          {t('memory.activity.clearRow')}
        </span>
        {CLEAR_CHOICES.map((c) => (
          <label key={c} className="am-clear__choice">
            <input type="radio" name={`${ids}-range`} value={c} checked={choice === c} onChange={() => setChoice(c)} />
            <span className="am-clear__text">
              <span className="am-clear__title">{t(LABEL[c])}</span>
              <span className="am-clear__range">{clearRangeText(clearRange(c, now), now, t)}</span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p className="sp-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
