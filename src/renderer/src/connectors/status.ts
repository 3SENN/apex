/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import type { Connector } from '@shared/services'
import { atelier, call } from '../api'
import { needsAttention } from './logic/directory'

// Every connector as the chrome last heard them, kept live from the
// 'connectors' event. The sidebar's needs-reconnect dot, the chat
// cards and the logos read it, so they never each load the list.

let items: Connector[] | null = null
const listeners = new Set<() => void>()
let started = false

function fill(next: readonly Connector[]): void {
  items = [...next]
  for (const fn of [...listeners]) fn()
}

function start(): void {
  if (started) return
  started = true
  atelier.onAppEvent((e) => {
    if (e.type === 'connectors') fill(e.items)
  })
  void call('connectors', 'list').then(fill, () => undefined)
}

function subscribe(fn: () => void): () => void {
  start()
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** The connectors, or null until the first list arrives. */
export function useConnectorList(): Connector[] | null {
  return useSyncExternalStore(subscribe, () => items)
}

/** One connector by id, or null. */
export function useConnector(id: string | null | undefined): Connector | null {
  const list = useConnectorList()
  return (id && list?.find((c) => c.id === id)) || null
}

/** Whether any connector needs you to reconnect it (a sign-in expired or a refresh failed). */
export function useNeedsReconnect(): boolean {
  const list = useConnectorList()
  return list?.some((c) => c.enabled && c.health === 'needs-reconnect') ?? false
}

/** Whether any connector needs attention of any kind. */
export function useConnectorsAttention(): number {
  const list = useConnectorList()
  return list?.filter(needsAttention).length ?? 0
}
