/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { app, crashReporter } from 'electron'
import { log } from '../log'
import { onSessionEnd } from '../system/sessionEnd'
import { installAppCapture, installProcessCapture } from './capture'
import { endSession, readCrashReportsSetting, startSession, type CrashSession } from './crash'
import { logger } from './logger'

// Diagnostics start-up, before app ready. early.ts
// calls it with userData as the first import of index.ts; a smoke run sets
// its own userData after the imports, so there the diagnostics feature calls
// it instead. It points the logger at userData/logs, installs the capture,
// starts the crash reporter only when crashReports is on (nothing is ever
// uploaded), and keeps the unclean-exit sentinel.

let booted: { userData: string; session: CrashSession | null } | null = null
let reporterStarted = false

export function bootDiagnostics(userData: string): void {
  if (booted) return
  booted = { userData, session: null }
  try {
    logger.configure(join(userData, 'logs'))
  } catch {
    // An unwritable folder leaves the logger in memory; Atelier still starts.
  }
  installProcessCapture()
  installAppCapture()
  if (readCrashReportsSetting(join(userData, 'settings.json'))) startCrashReporter()
  try {
    booted.session = startSession(userData)
  } catch {
    booted.session = null
  }
  if (booted.session?.lastExitUnclean) log.warn('crash', 'The last run did not quit cleanly')
  const quitCleanly = (): void => {
    if (booted) endSession(booted.userData, booted.session)
    logger.flushSync()
  }
  app.on('will-quit', quitCleanly)
  // Windows shutting down or signing out never sends will-quit; ending the session isn't a crash.
  onSessionEnd(quitCleanly, { last: true })
}

/** Starts Electron's crash reporter, keeping dumps on this computer only. Once per run: it cannot be stopped. */
export function startCrashReporter(): void {
  if (reporterStarted) return
  try {
    crashReporter.start({ uploadToServer: false, compress: true })
    reporterStarted = true
  } catch (err) {
    log.warn('crash', 'The crash reporter could not start', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function crashReporterStarted(): boolean {
  return reporterStarted
}

/** This run's sentinel reading; null before boot. */
export function crashSession(): CrashSession | null {
  return booted?.session ?? null
}

export function bootedUserData(): string | null {
  return booted?.userData ?? null
}
