/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Clock, TimerHandle } from './clock'

// When Apex looks for updates on its own (UP-01): 30 s after start-up, then
// every 4 h; on wake from sleep unless the last check was under an hour ago;
// and when the network comes back (straight away if the last check failed,
// otherwise under the same one-hour rule).

export const STARTUP_DELAY_MS = 30_000
export const CHECK_INTERVAL_MS = 4 * 60 * 60_000
export const RECHECK_AFTER_MS = 60 * 60_000

export type CheckReason = 'startup' | 'interval' | 'wake' | 'online'

/** Whether a wake or reconnect should check now, given the last check. */
export function shouldRecheck(lastCheckAt: number | null, now: number, lastFailed = false): boolean {
  if (lastFailed || lastCheckAt === null) return true
  return now - lastCheckAt >= RECHECK_AFTER_MS
}

export interface SchedulerDeps {
  clock: Clock
  /** Runs a background check. */
  check(reason: CheckReason): void
  lastCheckAt(): number | null
  /** Whether the last check failed (a reconnect then checks at once). */
  lastFailed(): boolean
}

export class CheckScheduler {
  readonly #deps: SchedulerDeps
  #timer: TimerHandle | null = null
  #running = false

  constructor(deps: SchedulerDeps) {
    this.#deps = deps
  }

  /** Arms the start-up check; the 4 h interval follows from it. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#arm(STARTUP_DELAY_MS, 'startup')
  }

  stop(): void {
    this.#running = false
    this.#deps.clock.clearTimeout(this.#timer)
    this.#timer = null
  }

  /** After any check (scheduled or not) the next interval check counts from now. */
  checked(): void {
    if (this.#running) this.#arm(CHECK_INTERVAL_MS, 'interval')
  }

  /** powerMonitor 'resume'. */
  onWake(): void {
    if (!this.#running) return
    if (shouldRecheck(this.#deps.lastCheckAt(), this.#deps.clock.now())) this.#fire('wake')
  }

  /** network.onChange(true). */
  onOnline(): void {
    if (!this.#running) return
    if (shouldRecheck(this.#deps.lastCheckAt(), this.#deps.clock.now(), this.#deps.lastFailed())) this.#fire('online')
  }

  #fire(reason: CheckReason): void {
    this.#arm(CHECK_INTERVAL_MS, 'interval')
    this.#deps.check(reason)
  }

  #arm(ms: number, reason: CheckReason): void {
    this.#deps.clock.clearTimeout(this.#timer)
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = null
      this.#fire(reason)
    }, ms)
  }
}
