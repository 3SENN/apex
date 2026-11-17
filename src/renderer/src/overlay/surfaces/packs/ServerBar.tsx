/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { Monitor, Wifi } from 'lucide-react'
import type { ServerBarProps } from '@shared/overlay/packs'
import { useT } from '../../../i18n/useT'
import { Button } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'

// The server bar (docs/packs.md › A web server of its own): while an app's
// web server runs, Atelier says so over the app, where the app can't draw over
// it: shared on the Wi-Fi or on this computer only, how many are connected,
// and Stop. The first time on the Wi-Fi on a Mac it adds that macOS will ask
// about incoming connections. Main updates it as sockets come and go.

export function ServerBar({ props, resolve }: SurfaceComponentProps<ServerBarProps>): ReactElement {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const Icon = props.lan ? Wifi : Monitor
  const stop = (): void => {
    setBusy(true)
    resolve('stop')
  }
  // The outer frame leaves room for the bar's shadow: the overlay view is cut to the frame, and a shadow cut at its edge shows as grey corners.
  return (
    <div className="sv-room">
      <div className="sv-bar" role="region" aria-label={t('packs.server.label', { app: props.app })} data-lan={props.lan ? 'true' : 'false'}>
        <div className="sv-bar__row">
          <span className="sv-bar__dot" aria-hidden />
          <Icon className="sv-bar__icon" size={14} aria-hidden />
          <p className="sv-bar__text" role="status">
            {t(props.lan ? 'packs.server.lan' : 'packs.server.local', { app: props.app })}
            {props.connections > 0 && <span className="sv-bar__count"> · {t('packs.server.connected', { count: props.connections })}</span>}
          </p>
          <Button variant="secondary" size="sm" disabled={busy} onClick={stop}>
            {t('packs.server.stop')}
          </Button>
        </div>
        {props.hint && <p className="sv-bar__hint">{t('packs.server.firewall')}</p>}
      </div>
    </div>
  )
}
