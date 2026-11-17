/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The log facade. Every entry is redacted, handed to the onEntry
// listeners and written by the rotating file logger
// (diagnostics/logger.ts, userData/logs/apex.log); callers only ever see
// this small API.

import type { LogData, LogEntry, LogLevel } from '@shared/diagnostics'
import { LOG_MESSAGE_MAX } from '@shared/diagnostics'
import { logger } from './diagnostics/logger'
import { redact, redactData, registerSecret } from './diagnostics/redact'

// One entry shape for the facade and diagnostics (the file logger writes these as-is).
export type { LogData, LogEntry, LogLevel }
export { redact, registerSecret }

const listeners = new Set<(entry: LogEntry) => void>()

// True while the facade echoes a line to the console, so diagnostics/capture.ts
// (which wraps console.warn and console.error) never logs it a second time.
let echoing = false

export function isEchoing(): boolean {
  return echoing
}

const echoDebug = process.env.APEX_DEBUG === '1' || process.env.APEX_LOG_DEBUG === '1'

function write(level: LogLevel, source: string, message: string, data?: LogData): void {
  const text = message.length > LOG_MESSAGE_MAX ? `${message.slice(0, LOG_MESSAGE_MAX)}…` : message
  const entry: LogEntry = { t: Date.now(), level, source, message: redact(text), ...(data ? { data: redactData(data) } : {}) }
  for (const fn of [...listeners]) {
    try {
      fn(entry)
    } catch {
      // A failing listener must never break the caller's code path.
    }
  }
  logger.write(entry)
  // The dev console still shows each line; packaged builds have no console to show it in.
  const line = `[${entry.source}] ${entry.message}`
  const args = entry.data ? [line, entry.data] : [line]
  echoing = true
  try {
    if (level === 'error') console.error(...args)
    else if (level === 'warn') console.warn(...args)
    else if (level === 'info') console.info(...args)
    else if (echoDebug) console.debug(...args)
  } finally {
    echoing = false
  }
}

export const log = {
  debug: (source: string, message: string, data?: LogData): void => write('debug', source, message, data),
  info: (source: string, message: string, data?: LogData): void => write('info', source, message, data),
  warn: (source: string, message: string, data?: LogData): void => write('warn', source, message, data),
  error: (source: string, message: string, data?: LogData): void => write('error', source, message, data),
  /** Every entry, already redacted (the file writer and diagnostics). */
  onEntry(fn: (entry: LogEntry) => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

/** An error's message for a log line, without its stack. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
