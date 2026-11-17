/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { MENU_POLICY } from '../types'
import type { SurfacePolicy } from '@shared/overlay'

// How kit menus sit in the overlay host. A plain popover is a fixed-size
// surface: the host places its frame beside the anchor. A menu with side
// cards can reach past its root card, so it takes the window as a
// transparent layer instead: the cards place themselves, and a press
// anywhere else closes it without reaching the page (like a native menu).

/** The policy for surfaces drawing a CascadeMenu. */
export const CASCADE_MENU_POLICY: SurfacePolicy = { ...MENU_POLICY, size: 'fill-window' }

/** The click-catcher behind a CASCADE_MENU_POLICY surface's cards. */
export function MenuScrim({ onDismiss }: { onDismiss(): void }): ReactElement {
  return (
    <div
      className="kit-scrim"
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onDismiss()
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  )
}
