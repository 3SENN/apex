/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OverlayResult, SurfaceAnchor, SurfaceId, SurfaceProps } from '@shared/overlay'
import { apex } from '../../../api'

// The chrome's handle on one open tabs surface: its id for updates and
// close, and its result. Null when the overlay host isn't available (before
// it starts, or in a renderer without one), so callers can fall back.

export interface OpenSurface {
  instanceId: string
  result: Promise<OverlayResult>
  update(props: unknown): void
  close(): void
}

const waiting = new Map<string, (r: OverlayResult) => void>()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  apex.overlay.onResult((r) => {
    waiting.get(r.instanceId)?.(r)
    waiting.delete(r.instanceId)
  })
}

export async function openTabsSurface<S extends SurfaceId>(surface: S, anchor: SurfaceAnchor, props: SurfaceProps<S>): Promise<OpenSurface | null> {
  listen()
  try {
    const { instanceId } = await apex.overlay.open(surface, anchor, props)
    const result = new Promise<OverlayResult>((resolve) => waiting.set(instanceId, resolve))
    return {
      instanceId,
      result,
      update: (next) => apex.overlay.update(instanceId, next),
      close: () => {
        apex.overlay.close(instanceId)
        waiting.get(instanceId)?.({ instanceId, dismissed: 'closed' })
        waiting.delete(instanceId)
      },
    }
  } catch {
    return null
  }
}

/** The value a surface resolved with, or undefined when it was dismissed. */
export function resultValue(r: OverlayResult): unknown {
  return 'value' in r ? r.value : undefined
}
