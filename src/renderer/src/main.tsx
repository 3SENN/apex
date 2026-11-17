/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StrictMode, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import { App } from './App'
import { I18nProvider } from './i18n/I18nProvider'
import { applyTheme } from './theme'
import './styles.css'
// Request and log cards
import './connectors/register'
// Overlay tiers and popup strips load this same page with a hash
import { OverlayApp } from './overlay/OverlayApp'
import { PopupStrip } from './popup-strip/PopupStrip'
import { GhostApp } from './ghost/GhostApp'

// Theme and accent go on <html> before React renders, so neither the default
// mode nor the default accent flashes; main sends every later change.
applyTheme(window.atelier.initial.theme)
window.atelier.onAppEvent((event) => {
  if (event.type === 'theme') applyTheme(event.theme)
  // The chrome's ground follows the window material (opaque under Reduce Transparency).
  if (event.type === 'window-material') document.documentElement.dataset.material = event.material
})

// The role goes on <html> before the first paint too, so an overlay tier is
// transparent from its first frame (OV-01).
const role = window.atelier.role
document.documentElement.dataset.uiRole = role

function Root(): ReactElement | null {
  if (role === 'overlay-interactive') return <OverlayApp tier="interactive" />
  if (role === 'overlay-passive') return <OverlayApp tier="passive" />
  if (role === 'popup-strip') return <PopupStrip />
  // Drag ghosts draw their own content; nothing of the chrome belongs there.
  if (role === 'ghost') return <GhostApp />
  return <App />
}

const root = document.getElementById('root')
if (root) {
  // The placeholder shell (SS-01) stays until React's first commit replaces it.
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <Root />
      </I18nProvider>
    </StrictMode>,
  )
}
