/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Network failures retry with backoff (UP-01): 1, 2, 4, 8 and 16 minutes,
// at most five times; after that the status stays in error until the next
// scheduled check. Other kinds of failure never retry on their own.

const MINUTE = 60_000

export const RETRY_DELAYS_MS: readonly number[] = [1, 2, 4, 8, 16].map((m) => m * MINUTE)

export const MAX_NETWORK_RETRIES = RETRY_DELAYS_MS.length

/**
 * The wait before retrying after the `failures`-th network failure in a row
 * (1-based), or null once the retries are used up.
 */
export function retryDelay(failures: number): number | null {
  if (!Number.isInteger(failures) || failures < 1) return null
  return RETRY_DELAYS_MS[failures - 1] ?? null
}
