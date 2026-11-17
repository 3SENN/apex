/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import type { SharingBarProps } from '@shared/overlay/sites'
import type { SitePermission } from '@shared/sites'
import { atelier, call } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { capturingKinds, revokePatch, sharingMessage } from './logic'
import { PermIcon } from './parts'

// The sharing bar: a small bar at the top of a tab's pane while its
// page uses the camera, microphone or screen. It names the site and what is
// live. Stop ends the capture now; Revoke access also forgets the site's
// camera and microphone answers, so it has to ask next time. It follows the
// tab's capture and goes away when nothing is live.

export function SharingBar({ props, close }: SurfaceComponentProps<SharingBarProps>): ReactElement | null {
  const t = useT()
  const [capture, setCapture] = useState(props.capture)
  const [sharedTab, setSharedTab] = useState(props.sharedTab)
  const [busy, setBusy] = useState(false)

  useEffect(
    () =>
      atelier.onAppEvent((event) => {
        if (event.type !== 'capture' || event.tabId !== props.tabId) return
        setCapture(event.capture)
        setSharedTab(event.sharedTab)
      }),
    [props.tabId],
  )

  const kinds = capturingKinds(capture)
  useEffect(() => {
    if (kinds.length === 0) close()
  }, [kinds.length, close])

  const message = sharingMessage(props.host, capture, sharedTab)
  if (!message) return null

  const stop = (): void => {
    setBusy(true)
    call('sites', 'stopCapture', props.tabId).catch(() => setBusy(false))
  }
  const revoke = async (): Promise<void> => {
    setBusy(true)
    try {
      const patch = revokePatch(capture)
      if (patch) await call('sites', 'set', props.origin, patch)
      await call('sites', 'stopCapture', props.tabId)
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="st-sharing" role="region" aria-label={t('sites.sharing.label', { host: props.host })}>
      <span className="st-live__dot" aria-hidden />
      <span className="st-sharing__icons" aria-hidden>
        {kinds.map((k: SitePermission) => (
          <PermIcon key={k} perm={k} size={14} />
        ))}
      </span>
      <p className="st-sharing__text" role="status">
        {t(message.key, { host: message.host, tab: message.tab ?? '', what: message.what ? t(message.what) : '' })}
      </p>
      <Button variant="primary" size="sm" disabled={busy} onClick={stop}>
        {t('sites.sharing.stop')}
      </Button>
      {(capture.camera || capture.microphone) && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revoke()}>
          {t('sites.sharing.revoke')}
        </Button>
      )}
    </div>
  )
}
