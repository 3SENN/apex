/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { Copy, Download, X } from 'lucide-react'
import type { QrSurfaceProps } from '@shared/dialogs'
import { call } from '../../../../api'
import { useT } from '../../../../i18n/useT'
import type { SurfaceComponentProps } from '../../../types'
import './qr.css'

// The `qr-code` card: this page's address as a QR code, drawn by
// shared/qr.ts, with Copy and Save (main makes the PNG and confirms with a
// toast). It sits at the top of the tab's pane and closes on Esc, an outside
// press or a tab switch.

export function QrCard({ props, close }: SurfaceComponentProps<QrSurfaceProps>): ReactElement {
  const t = useT()
  const [busy, setBusy] = useState(false)
  let host = props.url
  try {
    host = new URL(props.url).host
  } catch {
    // The full address will do.
  }
  const run = (fn: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    // The card goes first, so a save panel isn't hidden behind it; main confirms with a toast.
    close()
    void fn().catch(() => undefined)
  }
  return (
    <section className="qr" role="dialog" aria-labelledby="qr-title" aria-describedby="qr-url">
      <header className="qr__header">
        <h2 id="qr-title" className="qr__title">
          {t('menus.qr.title')}
        </h2>
        <button type="button" className="qr__close" aria-label={t('menus.dialog.close')} onClick={close}>
          <X aria-hidden />
        </button>
      </header>
      <div className="qr__plate">
        <img className="qr__code" src={props.svg} alt={t('menus.qr.alt', { url: props.url })} width={184} height={184} draggable={false} />
      </div>
      <p className="qr__page" title={props.title}>
        {props.title || host}
      </p>
      <p id="qr-url" className="qr__url" title={props.url}>
        {props.url}
      </p>
      <footer className="qr__actions">
        <button type="button" className="ui-btn ui-btn--md ui-btn--secondary qr__btn" data-autofocus disabled={busy} onClick={() => run(() => Promise.resolve(call('pageActions', 'copyQrCode', props.url)))}>
          <Copy aria-hidden />
          {t('menus.qr.copy')}
        </button>
        <button type="button" className="ui-btn ui-btn--md ui-btn--secondary qr__btn" disabled={busy} onClick={() => run(() => call('pageActions', 'saveQrCode', props.url))}>
          <Download aria-hidden />
          {t('menus.qr.save')}
        </button>
      </footer>
    </section>
  )
}
