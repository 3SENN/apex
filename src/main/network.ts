/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'

// The online state (SS-06): error pages retry when it returns,
// chats hold and retry, the Connectors page counts down to its next check,
// and the updater rechecks. The watcher feeds it from the system's own
// answer (net.isOnline), confirmed by a probe when it says we are back, and
// from failed loads that look like a lost connection. It starts online.

const emitter = new EventEmitter<{ change: [online: boolean] }>()
let online = true

export const network = {
  isOnline(): boolean {
    return online
  },
  onChange(fn: (online: boolean) => void): () => void {
    emitter.on('change', fn)
    return () => {
      emitter.off('change', fn)
    }
  },
  /** The watcher reports here; listeners hear only real changes. */
  set(next: boolean): void {
    if (next === online) return
    online = next
    emitter.emit('change', next)
  },
}

export interface NetworkWatchOptions {
  /** The system's answer (Electron's net.isOnline). */
  isOnline(): boolean
  /** A cheap check that the connection really works; true when there is none to make (smoke, tests). */
  probe?(): Promise<boolean>
  /** How often to ask while online; offline it asks twice as often. */
  intervalMs?: number
  /** Where the state goes (the shared `network` by default; tests pass their own). */
  target?: Pick<typeof network, 'isOnline' | 'set'>
}

export interface NetworkWatch {
  /** Asks now (the Connectors page's Retry now, a failed load); resolves to the new state. */
  check(): Promise<boolean>
  stop(): void
}

/**
 * Polls the system state. Going offline is believed at once; coming back is
 * believed after the probe agrees, so a flapping interface doesn't send every
 * error page into a reload storm.
 */
export function startNetworkWatch(opts: NetworkWatchOptions): NetworkWatch {
  const target = opts.target ?? network
  const interval = opts.intervalMs ?? 5000
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<boolean> | null = null
  let stopped = false

  const evaluate = async (): Promise<boolean> => {
    const system = opts.isOnline()
    if (!system) {
      target.set(false)
      return false
    }
    // Only a return is probed: while we believe we're online the system's answer is enough.
    if (target.isOnline() || !opts.probe) {
      target.set(true)
      return true
    }
    const confirmed = await opts.probe().catch(() => false)
    if (confirmed) target.set(true)
    return confirmed
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => void check().finally(schedule), target.isOnline() ? interval : Math.max(500, interval / 2))
    timer.unref?.()
  }

  const check = (): Promise<boolean> => {
    running ??= evaluate().finally(() => {
      running = null
    })
    return running
  }

  schedule()
  return {
    check,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
