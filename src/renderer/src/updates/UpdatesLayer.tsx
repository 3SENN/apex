/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { atelier, call } from '../api'
import { openSurface } from '../overlay/useSurface'

// The chrome-side hook for the update cards. Main opens the restart card,
// the unsupported prompt and the post-update what's-new card on the focused
// window itself (it needs their answers); this layer answers the 'whats-new'
// MenuCommand sent to this window's chrome, opening the card here through the
// overlay host. It draws nothing of its own.
export function UpdatesLayer(): null {
  useEffect(
    () =>
      atelier.onCommand((command) => {
        if (command !== 'whats-new') return
        void showWhatsNew()
      }),
    [],
  )
  return null
}

async function showWhatsNew(): Promise<void> {
  try {
    // An update's card if one is waiting, else this version's notes.
    const armed = await call('updates', 'whatsNew')
    const entry = armed ?? (await call('updates', 'notes'))
    if (!entry) return
    const result = await openSurface('whats-new', { kind: 'window', rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } }, { entry, since: false })
    if (armed && result) void call('updates', 'dismissWhatsNew')
  } catch {
    // The overlay host can't open surfaces yet; the menu item simply does nothing.
  }
}
