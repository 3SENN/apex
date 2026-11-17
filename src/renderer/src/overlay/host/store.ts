/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OverlayOpenMessage, Rect } from '@shared/overlay'
import { atelier } from '../../api'

// What one overlay renderer shows: every instance main asked it to mount,
// whether it is exiting, and the rect each frame drew. Subscribed when the
// module loads (before the page's load event), so no open from main is ever
// missed; React reads it through useSyncExternalStore.

export interface HostedInstance {
  message: OverlayOpenMessage
  /** Bumped on every update, so frames re-render. */
  version: number
  /** Arrival order, for stacking within a layer. */
  seq: number
  closing: boolean
  /** The frame's rect in window CSS px, once placed. */
  rect: Rect | null
}

type Listener = () => void

const instances = new Map<string, HostedInstance>()
const listeners = new Set<Listener>()
let snapshot: HostedInstance[] = []
let seq = 0

function publish(): void {
  snapshot = [...instances.values()]
  for (const l of [...listeners]) l()
}

export function subscribeHosted(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function hostedSnapshot(): HostedInstance[] {
  return snapshot
}

export function setHostedRect(instanceId: string, rect: Rect | null): void {
  const i = instances.get(instanceId)
  if (!i || sameRect(i.rect, rect)) return
  instances.set(instanceId, { ...i, rect })
  publish()
}

/** The frame finished its exit: forget it and tell main. */
export function removeHosted(instanceId: string): void {
  if (!instances.delete(instanceId)) return
  publish()
  atelier.overlay.removed(instanceId)
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

let started = false

/** Starts listening; called once by OverlayApp's module. */
export function startHostedStore(): void {
  if (started) return
  started = true
  atelier.overlay.onOpen((message) => {
    const existing = instances.get(message.instanceId)
    instances.set(message.instanceId, {
      message,
      version: (existing?.version ?? 0) + 1,
      seq: existing?.seq ?? ++seq,
      closing: existing?.closing ?? false,
      rect: existing?.rect ?? null,
    })
    publish()
  })
  atelier.overlay.onClose(({ instanceId }) => {
    const i = instances.get(instanceId)
    if (!i || i.closing) return
    instances.set(instanceId, { ...i, closing: true })
    publish()
  })
}
