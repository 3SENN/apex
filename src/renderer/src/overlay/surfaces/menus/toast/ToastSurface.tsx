/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import type { ToastOutcome, ToastSurfaceProps } from '@shared/dialogs'
import { toastTiming } from '@shared/toastTiming'
import { useT } from '../../../../i18n/useT'
import { cx } from '../../../../ui/logic/format'
import type { SurfaceComponentProps } from '../../../types'
import './toast.css'

// The `toast` surface (OV-05): a small pill at the top centre of the
// tab. It closes by itself after its time (paused while the pointer is on
// it), on a tab switch (the host closes it), or on its buttons. The same id
// shown again replaces the text in place and restarts the clock.

const ICON = { success: <CircleCheck />, error: <CircleAlert />, info: <Info /> }

export function ToastSurface({ props, resolve, exiting }: SurfaceComponentProps<ToastSurfaceProps>): ReactElement {
  const t = useT()
  const { toast } = props
  const [hovered, setHovered] = useState(false)
  const remaining = useRef(toastTiming(toast))
  const end = (outcome: ToastOutcome): void => {
    if (!exiting) resolve(outcome)
  }

  // A replacement restarts the countdown.
  useEffect(() => {
    remaining.current = toastTiming(toast)
  }, [toast])

  useEffect(() => {
    if (hovered || exiting || remaining.current === 0) return
    const started = Date.now()
    const timer = setTimeout(() => resolve('timeout'), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(800, remaining.current - (Date.now() - started))
    }
  }, [hovered, exiting, toast, resolve])

  const twoLine = !!toast.detail || toast.text.length > 48
  return (
    <div
      className={cx('tst', `tst--${toast.kind}`, twoLine && 'tst--two-line')}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      data-state={exiting ? 'closing' : 'open'}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          end('closed')
        }
      }}
    >
      <span className="tst__icon" aria-hidden>
        {ICON[toast.kind]}
      </span>
      <div className="tst__text">
        <span className="tst__title">{toast.text}</span>
        {toast.detail && <span className="tst__detail">{toast.detail}</span>}
      </div>
      {toast.undo && (
        <button type="button" className="tst__action" onClick={() => end('undo')}>
          {t('menus.toast.undo')}
        </button>
      )}
      {toast.action && (
        <button type="button" className="tst__action" onClick={() => end('action')}>
          {toast.action.label}
        </button>
      )}
      {(toast.undo || toast.action || toast.kind === 'error' || toastTiming(toast) === 0) && (
        <button type="button" className="tst__close" aria-label={t('menus.toast.dismiss')} onClick={() => end('closed')}>
          <X aria-hidden />
        </button>
      )}
    </div>
  )
}
