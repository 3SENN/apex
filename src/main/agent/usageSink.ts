/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where model turns outside a chat session report their tokens:
// QuickModel calls and host.complete(). The agentTools feature points it at the
// usage ledger; until then, and in tests, reports go nowhere.
import type { UsageRow } from '@shared/usage'

export type UsageReport = Omit<UsageRow, 'at'> & { at?: number }

let sink: ((row: UsageReport) => void) | null = null

export function setUsageSink(next: ((row: UsageReport) => void) | null): void {
  sink = next
}

/** Records one turn; a failing ledger never breaks the call that used the model. */
export function recordUsage(row: UsageReport): void {
  try {
    sink?.(row)
  } catch {
    // The ledger logs its own failures.
  }
}
