/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Logs, crash reports, the problem report and feedback (OV-30). Nothing
// here is ever sent anywhere by Atelier: reports are files you choose to email yourself.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** Widened with `string & {}` so the free-form sources other code already logs with stay valid. */
export type LogSource =
  | 'main'
  | 'chrome'
  | 'page'
  | 'agent'
  | 'updates'
  | 'routines'
  | 'speech'
  | 'migrations'
  | 'system'
  | 'crash'
  | 'i18n'
  | (string & {})

export type LogData = Record<string, string | number | boolean | null>

export interface LogEntry {
  /** ms since epoch. */
  t: number
  level: LogLevel
  source: LogSource
  /** Already redacted. */
  message: string
  data?: LogData
}

export interface LogQuery {
  levels?: LogLevel[]
  sources?: LogSource[]
  text?: string
  /** Entries strictly older than this time, for paging back. */
  before?: number
  limit?: number
}

export interface LogPage {
  entries: LogEntry[]
  hasMore: boolean
  totalBytes: number
  files: number
}

export interface ReportDraft {
  /** Required before saving. */
  description: string
  images: Array<{ name: string; dataUrl: string }>
  /** Tokens from diagnostics.pickFiles; the renderer never sees the paths. */
  fileTokens: string[]
  includeChatId: string | null
  includeScreenshotTabId: string | null
  includeCrashDumps: boolean
}

export type ReportPartKind = 'system' | 'logs' | 'chat' | 'screenshot' | 'files' | 'images' | 'crash'

export interface ReportEstimate {
  bytes: number
  overLimit: boolean
  parts: Array<{ kind: ReportPartKind; bytes: number }>
}

export interface ReportResult {
  /** Where the zip was saved (Downloads). */
  path: string
  bytes: number
  mailto: string
}

export interface CrashState {
  /** The unclean-exit sentinel was still there at start-up. */
  lastExitUnclean: boolean
  /** Stored crash dumps (only kept while crashReports is on). */
  dumps: number
  at: number | null
}

/** A picked file, by token: main keeps the path. */
export interface PickedReportFile {
  token: string
  name: string
  bytes: number
}

// Limits the dialog and main both enforce.
export const REPORT_MAX_BYTES = 25 * 1024 * 1024
export const REPORT_MAX_IMAGES = 5
export const REPORT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const REPORT_MAX_FILES = 10
export const REPORT_FILES_MAX_BYTES = 25 * 1024 * 1024
export const REPORT_DESCRIPTION_MAX = 20_000
export const MAILTO_BODY_MAX = 1500
export const LOG_MESSAGE_MAX = 4000

export interface DiagnosticsServices {
  diagnostics: {
    logs(q: LogQuery): LogPage
    /** Live tail: 'log' events flow only while on. */
    tail(on: boolean): void
    clearLogs(): void
    revealLogs(): void
    systemInfo(): Record<string, string>
    pickFiles(): Promise<PickedReportFile[]>
    estimate(d: ReportDraft): Promise<ReportEstimate>
    saveReport(d: ReportDraft, options: { email: boolean }): Promise<ReportResult>
    /** Opens a mailto draft with the system line and no logs. */
    sendFeedback(): void
    crashState(): CrashState
    dismissCrash(): void
    /** The renderer's log(): rate-limited, always tagged 'chrome'. */
    log(level: LogLevel, message: string): void
    /** Shows the last saved report in Finder (the success state's Reveal). */
    revealReport(): void
    /** Opens the last saved report's email draft again. */
    emailReport(): void
  }
}

export type DiagnosticsEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'crash'; state: CrashState }
  /** The outcome of Send Feedback, to the window that asked, for its toast. `address` may be ''. */
  | { type: 'feedback-draft'; ok: boolean; address: string; system: string }

/** The newest entries are kept when a page is cut; this many by default. */
export const LOG_PAGE_DEFAULT = 500

/** One entry against a query's level, source, text and time filters. Text matches message, source and data values, ignoring case. */
export function matchesLogQuery(entry: LogEntry, q: LogQuery): boolean {
  if (q.levels && q.levels.length > 0 && !q.levels.includes(entry.level)) return false
  if (q.sources && q.sources.length > 0 && !q.sources.includes(entry.source)) return false
  if (q.before !== undefined && !(entry.t < q.before)) return false
  const text = q.text?.trim().toLowerCase()
  if (!text) return true
  if (entry.message.toLowerCase().includes(text) || entry.source.toLowerCase().includes(text)) return true
  return Object.values(entry.data ?? {}).some((v) => v !== null && String(v).toLowerCase().includes(text))
}

/** The newest `limit` matching entries, oldest first, from a chronological list. */
export function pageLogEntries(entries: readonly LogEntry[], q: LogQuery): { entries: LogEntry[]; hasMore: boolean } {
  const limit = q.limit ?? LOG_PAGE_DEFAULT
  const matching = entries.filter((e) => matchesLogQuery(e, q))
  return { entries: matching.slice(Math.max(0, matching.length - limit)), hasMore: matching.length > limit }
}
