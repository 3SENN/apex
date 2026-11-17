/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents } from 'electron'
import { cdp } from './cdp'
import { log } from './log'

// Dark mode for one site: Chromium's automatic dark rendering,
// switched per tab through the shared CDP session while it shows a site with
// force dark on. Chromium keeps the switch in WebPreferences, which Electron
// doesn't expose, so DevTools' Emulation domain is the only way in (no
// Runtime or Page domain). Leaving the site clears the override and releases
// the attachment, so tabs without it carry no debugger; on sign-in pages the
// hold steps aside (cdp.ts).

const applied = new WeakMap<WebContents, () => void>()

/** Turns the tab's automatic dark rendering on or off; a no-op when it is already so. */
export async function setForceDark(wc: WebContents, on: boolean): Promise<void> {
  if (wc.isDestroyed()) return
  const release = applied.get(wc)
  if (on === !!release) return
  try {
    if (on) {
      applied.set(
        wc,
        cdp.hold(wc, {
          apply: () => cdp.send(wc, 'Emulation.setAutoDarkModeOverride', { enabled: true }),
          // No parameters clears the override.
          clear: () => cdp.send(wc, 'Emulation.setAutoDarkModeOverride', {}),
        }),
      )
      return
    }
    applied.delete(wc)
    // Detaching drops the override; with other holders the release clears it first.
    release?.()
  } catch (err) {
    log.debug('sites', 'Could not change dark mode for a page', { error: err instanceof Error ? err.message : String(err) })
    applied.get(wc)?.()
    applied.delete(wc)
  }
}

export function isForcedDark(wc: WebContents): boolean {
  return applied.has(wc)
}
