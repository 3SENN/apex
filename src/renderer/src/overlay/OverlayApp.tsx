/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useSyncExternalStore, type ReactElement } from 'react'
import type { OverlayTier } from '@shared/overlay'
import { EMPTY_RECT, clipRect, unionRect } from '@shared/overlayLayout'
import { atelier } from '../api'
import { surfaceModule } from './registry'
import { SurfaceFrame } from './host/SurfaceFrame'
import { hostedSnapshot, startHostedStore, subscribeHosted } from './host/store'
import './host/overlay.css'

// The root of an overlay tier's renderer. main.tsx mounts it for
// #overlay=interactive and #overlay=passive. The interactive view is sized to
// the union of its surfaces, so the frames are translated by that union's
// origin; main computes the same union from the same reported rects. The
// passive window covers the content area, so its origin is 0.

export function OverlayApp({ tier }: { tier: OverlayTier }): ReactElement {
  // Started on first render, not on import: the chrome bundles this module too.
  startHostedStore()
  const items = useSyncExternalStore(subscribeHosted, hostedSnapshot)

  useEffect(() => {
    document.documentElement.dataset.uiRole = tier === 'interactive' ? 'overlay-interactive' : 'overlay-passive'
  }, [tier])

  // Esc dismisses the topmost interactive surface, unless the surface handled it first.
  useEffect(() => {
    if (tier !== 'interactive') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const open = hostedSnapshot().filter((i) => !i.closing && !i.message.hidden)
      const layerRank = (id: string): number => ({ modal: 3, menu: 2, hint: 1 })[surfaceModule(id)?.policy.layer ?? 'hint']
      const top = open.sort((a, b) => layerRank(b.message.surface) - layerRank(a.message.surface) || b.seq - a.seq)[0]
      if (!top) return
      e.preventDefault()
      atelier.overlay.dismiss(top.message.instanceId, 'escape')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tier])

  const origin = useMemo(() => {
    if (tier === 'passive') return { x: 0, y: 0 }
    const viewport = items[0]?.message.viewport ?? EMPTY_RECT
    const union = unionRect(items.filter((i) => !i.message.hidden).map((i) => i.rect))
    const clipped = union && clipRect(union, viewport)
    return clipped ? { x: clipped.x, y: clipped.y } : { x: 0, y: 0 }
  }, [items, tier])

  return (
    <div className="ov-root" data-tier={tier} style={{ transform: `translate(${-origin.x}px, ${-origin.y}px)` }}>
      {items.map((item) => (
        <SurfaceFrame key={item.message.instanceId} item={item} tier={tier} />
      ))}
    </div>
  )
}
