/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The clear-browsing-data dialog (⇧⌘⌫, ST-36): a time range, history,
// cookies and site data, and the cache. Clearing history asks once more in
// place. Shown by the overlay host (surface 'clear-data') and, until that
// host is up, by Settings › Privacy (?clear=1).
import { useId, useState, type ReactElement } from 'react'
import type { ClearRange } from '@shared/services/settings'
import { call } from '../api'
import { useT } from '../i18n/useT'
import { Button, Dialog, Select, Switch, useAsyncAction, useToast } from '../ui'
import { CLEAR_KINDS, CLEAR_RANGE_LABELS, CLEAR_RANGES, canClear, defaultClearRequest, needsHistoryConfirm, siteDataDescription, toggleKind, type ClearKind } from './logic/clearData'
import './settingsPages.css'

const KIND_LABELS = {
  history: ['settings.clearData.history', 'settings.clearData.history.description'],
  siteData: ['settings.clearData.siteData', 'settings.clearData.siteData.description'],
  cache: ['settings.clearData.cache', 'settings.clearData.cache.description'],
} as const

export interface ClearDataDialogProps {
  open: boolean
  range?: ClearRange
  onClose(): void
  /** After a successful clear (the toast has been shown, unless `toast` is false). */
  onDone?(): void
  /** False in the overlay surface: main's window toast says it worked instead. */
  toast?: boolean
}

export function ClearDataDialog({ open, range, onClose, onDone, toast: showToast = true }: ClearDataDialogProps): ReactElement | null {
  const t = useT()
  const toast = useToast()
  const rangeId = useId()
  const [request, setRequest] = useState(() => defaultClearRequest(range))
  const [confirming, setConfirming] = useState(false)
  const clear = useAsyncAction(async () => {
    await call('storage', 'clearBrowsingData', request)
    if (showToast) toast.show({ tone: 'success', message: t('settings.clearData.done') })
    if (onDone) onDone()
    else onClose()
  })
  const ready = canClear(request)

  const submit = (): void => {
    if (!ready || clear.busy) return
    if (needsHistoryConfirm(request) && !confirming) {
      setConfirming(true)
      return
    }
    void clear.run()
  }
  const set = (kind: ClearKind, on: boolean): void => {
    setConfirming(false)
    setRequest((r) => toggleKind(r, kind, on))
  }

  return (
    <Dialog
      open={open}
      onClose={() => !clear.busy && onClose()}
      title={t('settings.clearData.title')}
      description={t('settings.clearData.description')}
      size="md"
      role={confirming ? 'alertdialog' : 'dialog'}
      footer={
        <>
          <Button variant="ghost" disabled={clear.busy} onClick={confirming ? () => setConfirming(false) : onClose}>
            {confirming ? t('settings.clearData.back') : t('settings.clearData.cancel')}
          </Button>
          <Button variant="danger" loading={clear.busy} disabled={!ready} onClick={submit} data-autofocus={confirming ? true : undefined}>
            {confirming ? t('settings.clearData.confirmHistory.button') : t('settings.clearData.confirm')}
          </Button>
        </>
      }
    >
      <div className="sp-clear">
        <label className="sp-clear__range" htmlFor={rangeId}>
          <span>{t('settings.clearData.range')}</span>
          <Select
            id={rangeId}
            value={request.range}
            disabled={clear.busy}
            options={CLEAR_RANGES.map((value) => ({ value, label: t(CLEAR_RANGE_LABELS[value]) }))}
            onChange={(value) => {
              setConfirming(false)
              setRequest((r) => ({ ...r, range: value }))
            }}
          />
        </label>
        <div className="sp-clear__kinds">
          {CLEAR_KINDS.map((kind) => (
            <Switch
              key={kind}
              label={t(KIND_LABELS[kind][0])}
              description={t(kind === 'siteData' ? siteDataDescription(request.range) : KIND_LABELS[kind][1])}
              checked={request[kind]}
              disabled={clear.busy}
              onChange={(on) => set(kind, on)}
            />
          ))}
        </div>
        {!ready && (
          <p className="sp-field__hint" role="status">
            {t('settings.clearData.nothing')}
          </p>
        )}
        {confirming && (
          <p className="sp-clear__confirm" role="alert">
            {t('settings.clearData.confirmHistory', { range: t(CLEAR_RANGE_LABELS[request.range]).toLowerCase() })}
          </p>
        )}
        {clear.error && (
          <p className="sp-field__error" role="alert">
            {clear.error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
