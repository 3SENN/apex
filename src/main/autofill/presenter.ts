/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AutofillSurfaceId, AutofillSurfaceProps } from '@shared/overlay/autofill'
import type { Bounds } from '@shared/ipc'
import type { OverlayResult, SurfaceProps } from '@shared/overlay'
import type { WindowContext } from '../features/types'
import type { OverlayOpenOptions } from '../overlayHost'
import { log } from '../log'

// How the controller shows its surfaces: the overlay host, behind an
// interface so tests and smoke can record opens instead. The instance id is
// the popup or offer id, so main can update and close its own surface.

export interface SurfaceHandle {
  readonly id: string
  update(props: unknown): void
  close(): void
  /** Settles when the surface resolves or is dismissed; null when it never showed. */
  readonly done: Promise<OverlayResult | null>
}

export interface Presenter {
  /** `rect` is where the surface draws, in the tab pane's coordinates. */
  open<S extends AutofillSurfaceId>(surface: S, rect: Bounds, props: AutofillSurfaceProps[S], id: string): SurfaceHandle
}

export function overlayPresenter(win: WindowContext, tabId: string): Presenter {
  return {
    open(surface, rect, props, id) {
      // The host picks its own instance ids, so the one it gave this surface is
      // read back right after the (synchronous) open, for updates and closes.
      const before = new Set(win.overlay.openSurfaces().map((s) => s.instanceId))
      const opts: OverlayOpenOptions & { instanceId: string } = { tabId, instanceId: id }
      const done = win.overlay.open(surface, { kind: 'tab', tabId, rect }, props as SurfaceProps<typeof surface>, opts).catch((err: unknown) => {
        log.debug('autofill', 'surface did not open', { surface, error: err instanceof Error ? err.message : String(err) })
        return null
      })
      const hostId = win.overlay.openSurfaces().find((s) => s.surface === surface && !before.has(s.instanceId))?.instanceId ?? id
      return {
        id,
        update: (next) => win.overlay.update(hostId, next),
        close: () => {
          win.overlay.close(hostId)
          if (hostId === id) win.overlay.closeAll((s) => s === surface)
        },
        done,
      }
    },
  }
}
