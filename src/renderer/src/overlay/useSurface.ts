/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { OverlayResult, SurfaceAnchor, SurfaceId, SurfaceProps } from '@shared/overlay'
import { apex } from '../api'

// The chrome's way to open overlay surfaces. While the overlay host isn't
// available it rejects every open, so callers keep their fallbacks (inline dropdown,
// PermissionBar, chrome toasts and Confirm).

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

/** An element's rect in chrome CSS px, as a window anchor. */
export function anchorFromElement(el: HTMLElement): SurfaceAnchor {
  const r = el.getBoundingClientRect()
  return { kind: 'window', rect: { x: r.left, y: r.top, width: r.width, height: r.height } }
}

function resolveAnchor(anchor: RefObject<HTMLElement | null> | SurfaceAnchor): SurfaceAnchor | null {
  if ('kind' in anchor) return anchor
  return anchor.current ? anchorFromElement(anchor.current) : null
}

/** Opens a surface and resolves with its result (a value or a dismissal). */
export async function openSurface<S extends SurfaceId>(surface: S, anchor: SurfaceAnchor, props: SurfaceProps<S>): Promise<OverlayResult> {
  listen()
  const { instanceId } = await apex.overlay.open(surface, anchor, props)
  return new Promise((resolve) => waiting.set(instanceId, resolve))
}

export interface UseSurfaceOptions<S extends SurfaceId> {
  open: boolean
  anchor: RefObject<HTMLElement | null> | SurfaceAnchor
  props: SurfaceProps<S>
  onResult?(r: OverlayResult): void
  /** Warm the surface's renderer when the pointer enters the anchor. */
  prewarmOnHover?: boolean
}

/** Keeps a surface open while `open` is true, updating its props as they change. */
export function useSurface<S extends SurfaceId>(surface: S, options: UseSurfaceOptions<S>): { instanceId: string | null } {
  const [instanceId, setInstanceId] = useState<string | null>(null)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    if (!options.open) return
    const anchor = resolveAnchor(options.anchor)
    if (!anchor) return
    let id: string | null = null
    let cancelled = false
    listen()
    apex.overlay
      .open(surface, anchor, options.props)
      .then((opened) => {
        id = opened.instanceId
        if (cancelled) {
          apex.overlay.close(id)
          return
        }
        setInstanceId(id)
        waiting.set(id, (r) => {
          setInstanceId(null)
          latest.current.onResult?.(r)
        })
      })
      .catch(() => {
        // The host is not available yet: the caller's fallback shows instead.
      })
    return () => {
      cancelled = true
      if (id) {
        waiting.delete(id)
        apex.overlay.close(id)
      }
      setInstanceId(null)
    }
    // Opening and closing follow `open`; props flow through update below.
  }, [surface, options.open])

  useEffect(() => {
    if (instanceId) apex.overlay.update(instanceId, options.props)
  }, [instanceId, options.props])

  useEffect(() => {
    const anchor = options.anchor
    if (!options.prewarmOnHover || 'kind' in anchor) return
    const el = anchor.current
    if (!el) return
    const warm = (): void => apex.overlay.prewarm(surface)
    el.addEventListener('pointerenter', warm, { once: true })
    return () => el.removeEventListener('pointerenter', warm)
  }, [surface, options.prewarmOnHover, options.anchor])

  return { instanceId }
}
