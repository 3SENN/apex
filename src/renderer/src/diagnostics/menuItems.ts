/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chrome's ways into the diagnostics surfaces: the About rows, the crash notice and
// the report-problem command all open the problem report through the one
// DiagnosticsLayer of this window, which knows the chat and tab on show.

export interface OpenReportOptions {
  /** From the crash notice: the crash dumps start switched on. */
  preselectCrashDumps?: boolean
}

let handler: ((options: OpenReportOptions) => void) | null = null

/** DiagnosticsLayer registers itself; returns the unregister. */
export function setReportOpener(fn: (options: OpenReportOptions) => void): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

/** Opens Report a problem in this window. False when no layer is mounted. */
export function openProblemReport(options: OpenReportOptions = {}): boolean {
  if (!handler) return false
  handler(options)
  return true
}

/** The logs page, as Help › Show Logs and the About row open it. */
export const LOGS_URL = 'apex://logs'
