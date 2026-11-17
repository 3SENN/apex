/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { UpdatesFile } from '@shared/updates'

// The pending-install record (UP-02). Before quitting to install, Apex
// writes `{pending: {version, startedAt, attempts}}` to updates.json. On the
// next start the app version tells what happened: unchanged means the
// install failed (an error with Retry, up to three attempts); the new
// version means it worked, so the record is cleared and what's new is armed.

/** How long quitAndInstall may take before a still-running Apex calls it stuck. */
export const INSTALL_WATCHDOG_MS = 20_000

export const MAX_INSTALL_ATTEMPTS = 3

export type StartupOutcome =
  | { kind: 'none' }
  | { kind: 'installed'; version: string }
  | { kind: 'failed'; version: string; attempts: number; canRetry: boolean }

/** What a pending record means for this start. `currentVersion` is the running app's. */
export function startupOutcome(pending: UpdatesFile['pending'], currentVersion: string): StartupOutcome {
  if (!pending) return { kind: 'none' }
  if (pending.version === currentVersion) return { kind: 'installed', version: currentVersion }
  return { kind: 'failed', version: pending.version, attempts: pending.attempts, canRetry: pending.attempts < MAX_INSTALL_ATTEMPTS }
}

/** The record for one more install attempt of `version`: attempts count up per version. */
export function beginPending(file: UpdatesFile, version: string, now: number): NonNullable<UpdatesFile['pending']> {
  const previous = file.pending?.version === version ? file.pending.attempts : 0
  return { version, startedAt: now, attempts: previous + 1 }
}

/** Whether another install attempt of `version` is allowed. */
export function canAttemptInstall(file: UpdatesFile, version: string): boolean {
  return file.pending?.version !== version || file.pending.attempts < MAX_INSTALL_ATTEMPTS
}
