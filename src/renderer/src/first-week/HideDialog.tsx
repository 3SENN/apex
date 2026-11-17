/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useState, type ReactElement } from 'react'
import { HIDE_NOTE_MAX, HIDE_REASONS, HIDE_REASON_LABELS, type FirstWeekHideReason } from '@shared/firstWeek'
import { Button, Dialog } from '../ui'
import { useT } from '../i18n/useT'

interface HideDialogProps {
  open: boolean
  onClose(): void
  onHide(reason: FirstWeekHideReason, note: string): void
}

/** Hiding the plan asks why, so the reason is on record; it can be shown again from the same menu. */
export function HideDialog({ open, onClose, onHide }: HideDialogProps): ReactElement {
  const t = useT()
  const [reason, setReason] = useState<FirstWeekHideReason>('know-my-way')
  const [note, setNote] = useState('')
  const name = useId()
  const noteId = useId()
  useEffect(() => {
    if (!open) return
    setReason('know-my-way')
    setNote('')
  }, [open])
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={t('firstRun.weekHideDialog.hideGettingStarted')}
      description={t('firstRun.weekHideDialog.thePlanGoesAway')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('firstRun.weekHideDialog.cancel')}</Button>
          <Button variant="primary" onClick={() => onHide(reason, note)}>{t('firstRun.weekHideDialog.hide')}</Button>
        </>
      }
    >
      <fieldset className="fw-hide">
        <legend className="fw-hide__legend">{t('firstRun.weekHideDialog.whatMadeYouHide')}</legend>
        {HIDE_REASONS.map((r) => (
          <label key={r} className="fw-hide__option">
            <input type="radio" name={name} value={r} checked={reason === r} onChange={() => setReason(r)} />
            <span>{HIDE_REASON_LABELS[r]}</span>
          </label>
        ))}
        {reason === 'other' && (
          <>
            <label className="fw-hide__note-label" htmlFor={noteId}>{t('firstRun.weekHideDialog.addANoteOptional')}</label>
            <textarea id={noteId} className="fw-hide__note" rows={3} maxLength={HIDE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
          </>
        )}
      </fieldset>
    </Dialog>
  )
}
