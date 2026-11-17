/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pageLogEntries, type LogEntry, type LogPage, type LogQuery } from '@shared/diagnostics'

// The file logger behind the logging facade in
// src/main/log.ts. Entries are JSON lines in <dir>/apex.log, rotated at
// 2 MB into apex.1.log … apex.5.log. Writes are buffered and flushed on a
// short timer, and synchronously on quit, on a crash and on uncaught errors.
// Each source is held to 100 entries a second; the excess becomes one
// "N messages dropped" entry. Pure Node: nothing here needs Electron.

export const LOG_FILE = 'apex.log'
export const LOG_ROTATE_BYTES = 2 * 1024 * 1024
export const LOG_KEEP = 5
export const LOG_RATE_PER_SECOND = 100
const FLUSH_MS = 400
// Lines kept in memory before the folder is known (early start-up, smoke).
const PENDING_MAX = 5000

export interface LoggerOptions {
  /** Rotate when apex.log would pass this size. */
  maxBytes?: number
  /** Rotated files kept (apex.1.log … apex.<keep>.log). */
  keep?: number
  ratePerSecond?: number
  /** Debug entries are written only with APEX_DEBUG=1. */
  debug?: boolean
  now?: () => number
  /** Tests flush by hand. */
  timers?: boolean
}

interface RateWindow {
  start: number
  count: number
  dropped: number
}

export class FileLogger {
  #dir: string | null = null
  #pending: string[] = []
  #size = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  readonly #rates = new Map<string, RateWindow>()
  readonly #listeners = new Set<(entry: LogEntry) => void>()
  #maxBytes: number
  #keep: number
  #rate: number
  #debug: boolean
  #now: () => number
  #timers: boolean

  constructor(options: LoggerOptions = {}) {
    this.#maxBytes = options.maxBytes ?? LOG_ROTATE_BYTES
    this.#keep = options.keep ?? LOG_KEEP
    this.#rate = options.ratePerSecond ?? LOG_RATE_PER_SECOND
    this.#debug = options.debug ?? false
    this.#now = options.now ?? Date.now
    this.#timers = options.timers ?? true
  }

  /** Points the logger at its folder and writes what was logged before. Later calls only change options. */
  configure(dir: string, options: Omit<LoggerOptions, 'now' | 'timers'> = {}): void {
    if (options.maxBytes !== undefined) this.#maxBytes = options.maxBytes
    if (options.keep !== undefined) this.#keep = options.keep
    if (options.ratePerSecond !== undefined) this.#rate = options.ratePerSecond
    if (options.debug !== undefined) this.#debug = options.debug
    if (this.#dir === dir) return
    mkdirSync(dir, { recursive: true })
    this.#dir = dir
    this.#size = fileSize(join(dir, LOG_FILE))
    this.flushSync()
  }

  get dir(): string | null {
    return this.#dir
  }

  get debugEnabled(): boolean {
    return this.#debug
  }

  /** The path of the current file, once configured. */
  get file(): string | null {
    return this.#dir ? join(this.#dir, LOG_FILE) : null
  }

  /** Entries that were accepted for writing (the live tail listens here). */
  onWrite(fn: (entry: LogEntry) => void): () => void {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }

  /** Takes an already-redacted entry; false when it was filtered (debug) or rate-limited. */
  write(entry: LogEntry): boolean {
    if (entry.level === 'debug' && !this.#debug) return false
    const now = this.#now()
    let window = this.#rates.get(entry.source)
    if (!window || now - window.start >= 1000) {
      // A new second: report what the last one dropped, then count afresh.
      if (window && window.dropped > 0) this.#accept(droppedEntry(entry.source, window.dropped, now))
      window = { start: now, count: 0, dropped: 0 }
      this.#rates.set(entry.source, window)
    }
    if (window.count >= this.#rate) {
      window.dropped++
      return false
    }
    window.count++
    this.#accept(entry)
    return true
  }

  #accept(entry: LogEntry): void {
    this.#pending.push(`${JSON.stringify(entry)}\n`)
    if (this.#pending.length > PENDING_MAX) this.#pending.splice(0, this.#pending.length - PENDING_MAX)
    for (const fn of [...this.#listeners]) {
      try {
        fn(entry)
      } catch {
        // A failing listener never stops the write.
      }
    }
    this.#schedule()
  }

  #schedule(): void {
    if (!this.#dir || this.#timer || !this.#timers) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.flushSync()
    }, FLUSH_MS)
    this.#timer.unref?.()
  }

  /** Writes every buffered line now; safe to call from exit and crash handlers. */
  flushSync(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    // Drop notices for sources that went quiet are written too.
    const now = this.#now()
    for (const [source, window] of this.#rates) {
      if (window.dropped > 0 && now - window.start >= 1000) {
        this.#pending.push(`${JSON.stringify(droppedEntry(source, window.dropped, now))}\n`)
        window.dropped = 0
      }
    }
    const dir = this.#dir
    if (!dir || this.#pending.length === 0) return
    const lines = this.#pending
    this.#pending = []
    try {
      // Lines go in chunks so one rotation never splits an entry.
      let chunk = ''
      for (const line of lines) {
        const bytes = Buffer.byteLength(line)
        if (this.#size + Buffer.byteLength(chunk) + bytes > this.#maxBytes && this.#size + Buffer.byteLength(chunk) > 0) {
          if (chunk) this.#append(dir, chunk)
          chunk = ''
          this.#rotate(dir)
        }
        chunk += line
      }
      if (chunk) this.#append(dir, chunk)
    } catch {
      // A full disk or a removed folder must never break the app; the lines are lost.
    }
  }

  #append(dir: string, text: string): void {
    appendFileSync(join(dir, LOG_FILE), text)
    this.#size += Buffer.byteLength(text)
  }

  #rotate(dir: string): void {
    rmSync(join(dir, rotatedName(this.#keep)), { force: true })
    for (let i = this.#keep - 1; i >= 1; i--) {
      const from = join(dir, rotatedName(i))
      if (existsSync(from)) renameSync(from, join(dir, rotatedName(i + 1)))
    }
    const current = join(dir, LOG_FILE)
    if (existsSync(current)) renameSync(current, join(dir, rotatedName(1)))
    this.#size = 0
  }

  /** The log files that exist, newest first (apex.log, apex.1.log, …). */
  files(): Array<{ name: string; path: string; bytes: number }> {
    const dir = this.#dir
    if (!dir) return []
    const names = [LOG_FILE, ...Array.from({ length: this.#keep }, (_, i) => rotatedName(i + 1))]
    return names.flatMap((name) => {
      const path = join(dir, name)
      const bytes = fileSize(path)
      return existsSync(path) ? [{ name, path, bytes }] : []
    })
  }

  /** Every entry on disk, oldest first. Malformed lines are skipped. */
  readAll(): LogEntry[] {
    this.flushSync()
    const out: LogEntry[] = []
    for (const file of this.files().reverse()) {
      let text = ''
      try {
        text = readFileSync(file.path, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        const entry = parseLine(line)
        if (entry) out.push(entry)
      }
    }
    return out
  }

  query(q: LogQuery): LogPage {
    const page = pageLogEntries(this.readAll(), q)
    const files = this.files()
    return { ...page, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0), files: files.length }
  }

  /** Empties apex.log and removes the rotated files. */
  clear(): void {
    this.#pending = []
    const dir = this.#dir
    if (!dir) return
    for (let i = 1; i <= this.#keep; i++) rmSync(join(dir, rotatedName(i)), { force: true })
    writeFileSync(join(dir, LOG_FILE), '')
    this.#size = 0
  }
}

export function rotatedName(i: number): string {
  return `apex.${i}.log`
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function droppedEntry(source: string, dropped: number, t: number): LogEntry {
  return { t, level: 'warn', source, message: `${dropped} messages dropped`, data: { dropped } }
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/** One JSON line back to an entry, or null when it is not one. */
export function parseLine(line: string): LogEntry | null {
  if (!line.trim()) return null
  try {
    const raw = JSON.parse(line) as Partial<LogEntry>
    if (typeof raw.t !== 'number' || typeof raw.level !== 'string' || !LEVELS.has(raw.level) || typeof raw.source !== 'string' || typeof raw.message !== 'string') return null
    return { t: raw.t, level: raw.level, source: raw.source, message: raw.message, ...(raw.data && typeof raw.data === 'object' ? { data: raw.data } : {}) }
  } catch {
    return null
  }
}

/** The app's one logger; early.ts (or the smoke run's setup) points it at userData/logs. */
export const logger = new FileLogger({ debug: process.env.APEX_DEBUG === '1' || process.env.APEX_LOG_DEBUG === '1' })
