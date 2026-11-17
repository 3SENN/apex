/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The system layer in the chrome: opens the login-item approval dialog when
// Settings asks (as the overlay surface, or in the chrome until the overlay
// host is ready), keeps the Windows taskbar overlay in sync, and marks the root
// so the toolbar leaves room for the Windows and Linux window controls.
import { useEffect, useLayoutEffect, useState, type ReactElement } from 'react'
import { atelier } from '../api'
import { openSurface } from '../overlay/useSurface'
import { LoginItemApprovalDialog } from './LoginItemApproval'
import { TaskbarOverlaySync } from './TaskbarOverlaySync'
import { onLoginItemApprovalRequest } from './platform'
import './system.css'

/** Windows and Linux draw their window controls over the chrome (titleBarOverlay). */
const CONTROLS_OVERLAY = atelier.platform === 'win32' || atelier.platform === 'linux'

export function SystemLayer(): ReactElement {
  const [fallback, setFallback] = useState(false)

  useLayoutEffect(() => {
    if (!CONTROLS_OVERLAY) return
    document.documentElement.dataset.windowControls = 'overlay'
    return () => {
      delete document.documentElement.dataset.windowControls
    }
  }, [])

  useEffect(
    () =>
      onLoginItemApprovalRequest(() => {
        const rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
        // The overlay host draws it above page views; without the host, the chrome does.
        openSurface('login-item-approval', { kind: 'window', rect }, {}).catch(() => setFallback(true))
      }),
    [],
  )

  return (
    <>
      <LoginItemApprovalDialog open={fallback} onClose={() => setFallback(false)} />
      {atelier.platform === 'win32' && <TaskbarOverlaySync />}
    </>
  )
}
