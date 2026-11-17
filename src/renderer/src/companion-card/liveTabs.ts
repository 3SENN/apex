/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TabsSnapshot } from '@shared/ipc'
import { atelier } from '../api'

// The latest tabs snapshot, for code that needs it once (the card's
// backdrop) rather than as React state. Seeded from the initial state, so
// it is right even before the first change event.

let latest: TabsSnapshot = atelier.initial.tabs
let started = false
const listeners = new Set<(snapshot: TabsSnapshot) => void>()

function start(): void {
  if (started) return
  started = true
  atelier.tabs.onChanged((snapshot) => {
    latest = snapshot
    listeners.forEach((l) => l(snapshot))
  })
}

start()

export function tabsSnapshot(): TabsSnapshot {
  return latest
}

/** Calls `listener` on every tabs change until the returned function runs. */
export function onTabsChanged(listener: (snapshot: TabsSnapshot) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
