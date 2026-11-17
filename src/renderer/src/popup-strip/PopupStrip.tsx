/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import type { PopupStripState } from '@shared/api'
import { atelier } from '../api'
import { useT } from '../i18n/useT'
import './popupStrip.css'

// A popup window's read-only origin strip (SH-62): the host, whether
// the connection is secure, and a loading mark, updated as the popup
// navigates. It can't be edited or clicked through to anything; it only
// tells you where a sign-in or payment window really is.

export function PopupStrip(): ReactElement {
  const t = useT()
  const [state, setState] = useState<PopupStripState | null>(null)
  useEffect(() => atelier.overlay.onStrip(setState), [])

  const host = state?.host ?? ''
  const secure = state?.secure ?? false
  const status = secure ? t('core.popup.secure') : t('core.popup.notSecure')
  return (
    <div className="popup-strip" role="status" aria-live="polite" aria-busy={state?.loading ?? true}>
      <span className={`popup-strip-mark${secure ? ' is-secure' : ' is-insecure'}`} aria-hidden="true">
        {secure ? <LockGlyph /> : <AlertGlyph />}
      </span>
      <span className="popup-strip-host" title={host}>
        {host}
      </span>
      {/* The marker is spelled out for screen readers; sighted users read the glyph and colour. */}
      <span className={secure ? 'popup-strip-sr' : 'popup-strip-warning'}>{status}</span>
      {state?.loading !== false ? (
        <span className="popup-strip-loading" aria-label={t('core.popup.loading')}>
          <span className="popup-strip-spinner" />
        </span>
      ) : null}
    </div>
  )
}

function LockGlyph(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="2.5" y="5.25" width="7" height="5" rx="1.25" fill="currentColor" />
      <path d="M4 5.25V4a2 2 0 1 1 4 0v1.25" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function AlertGlyph(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 1.5 11 10.5H1L6 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 5v2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6" cy="8.9" r="0.7" fill="currentColor" />
    </svg>
  )
}
