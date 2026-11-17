/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Tip } from '@shared/tips'
import type { LogItem } from '../../agentLog'
import { hasPendingRequest } from './requests'

// Tips while the companion works (CH-29): after about 4 s of a run, one tip
// appears under the live status and rotates about every 10 s. Never while a
// request card or an error shows, never when tips are off, never a dismissed
// one. Pure, so the schedule is tested.

export const TIP_DELAY_MS = 4000
export const TIP_ROTATE_MS = 10_000

export interface TipInput {
  runStartedAt: number | null
  now: number
  enabled: boolean
  blocked: boolean
  tips: readonly Tip[]
  dismissed: readonly string[]
}

export interface TipPick {
  tip: Tip | null
  /** When to look again (ms from now), or null when nothing will change by itself. */
  changesIn: number | null
}

export function pickTip({ runStartedAt, now, enabled, blocked, tips, dismissed }: TipInput): TipPick {
  if (!enabled || blocked || runStartedAt === null) return { tip: null, changesIn: null }
  const pool = tips.filter((t) => !dismissed.includes(t.id))
  if (pool.length === 0) return { tip: null, changesIn: null }
  const elapsed = now - runStartedAt
  if (elapsed < TIP_DELAY_MS) return { tip: null, changesIn: TIP_DELAY_MS - elapsed }
  const since = elapsed - TIP_DELAY_MS
  const slot = Math.floor(since / TIP_ROTATE_MS)
  // Each run starts at a different tip, so a short run doesn't always show the first one.
  const offset = Math.abs(Math.floor(runStartedAt / 1000)) % pool.length
  const tip = pool[(offset + slot) % pool.length] ?? null
  return { tip, changesIn: pool.length > 1 ? TIP_ROTATE_MS - (since % TIP_ROTATE_MS) : null }
}

/** An error from the current run is on screen: one after your latest message (older errors don't count). */
export function errorShowing(items: readonly LogItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || item.kind === 'user') return false
    if (item.kind === 'notice' && item.tone === 'error') return true
  }
  return false
}

/** Tips stay out of the way of a request card or an error. */
export function tipBlocked(items: readonly LogItem[], status: string): boolean {
  return status === 'awaiting-approval' || hasPendingRequest(items) || errorShowing(items)
}
