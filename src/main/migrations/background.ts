/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatFileStatus } from './runner'

// The background migration pass (SS-09): after an upgrade, every saved chat is
// brought up to date in small batches with a pause between them, so the
// results exist without opening each chat and start-up stays quick. The pass
// is resumable: a chat it already migrated is current next time, so a pass
// cut short by quitting picks up where it stopped. Opening a chat still
// migrates it on the spot (the lazy path), whichever comes first.

export const PASS_BATCH = 20
/** The pause between batches, so open chats and typing keep the main thread. */
export const PASS_GAP_MS = 250

export type PassTally = Record<ChatFileStatus, number> & { total: number }

export interface PassDeps {
  /** The chats to visit, read once when the pass starts. */
  ids(): readonly string[]
  /** Upgrades one chat's file; never throws. */
  upgrade(id: string): ChatFileStatus
  /** Runs the next batch later (setTimeout in the app, a manual clock in tests). */
  schedule(fn: () => void, ms: number): void
  /** After each batch, to save the report. */
  onBatch?(tally: PassTally): void
  batch?: number
  gapMs?: number
}

export interface Pass {
  done: Promise<PassTally>
  cancel(): void
}

export function startPass(deps: PassDeps): Pass {
  const ids = [...deps.ids()]
  const size = Math.max(1, deps.batch ?? PASS_BATCH)
  const tally: PassTally = { total: ids.length, missing: 0, current: 0, migrated: 0, failed: 0, newer: 0 }
  let next = 0
  let cancelled = false
  let finish: (t: PassTally) => void = () => undefined
  const done = new Promise<PassTally>((resolve) => {
    finish = resolve
  })
  const step = (): void => {
    if (cancelled) return
    for (const id of ids.slice(next, next + size)) {
      try {
        tally[deps.upgrade(id)] += 1
      } catch {
        tally.failed += 1
      }
    }
    next += size
    deps.onBatch?.({ ...tally })
    if (next < ids.length) deps.schedule(step, deps.gapMs ?? PASS_GAP_MS)
    else finish({ ...tally })
  }
  deps.schedule(step, 0)
  return {
    done,
    cancel: () => {
      cancelled = true
    },
  }
}
