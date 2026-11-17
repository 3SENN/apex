/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { CHAT_FORMAT_VERSION, emptyMigrationReport, type MigrationOutcome, type MigrationReport } from '@shared/migrations'
import { log } from '../log'
import { writeAtomic } from '../settings'

// userData/migrations.json (SS-09): what the last data update did, for
// About › Data updates and the problem report. A run is one background pass
// after an upgrade; chats migrated lazily on open add to the current run.

/** Lists are capped so a store of thousands of broken files can't grow the report without end. */
const LIST_MAX = 500

const outcomeSchema = z.object({
  id: z.string().max(300),
  title: z.string().max(300),
  from: z.number().int(),
  to: z.number().int(),
  ok: z.boolean(),
  error: z.string().max(1000).optional(),
  at: z.number(),
})

const reportSchema = z.object({
  lastRunAt: z.number().nullable(),
  appVersion: z.string().max(64),
  from: z.number().int().nullable(),
  to: z.number().int(),
  migrated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  failed: z.array(outcomeSchema).max(LIST_MAX),
  newer: z.array(outcomeSchema).max(LIST_MAX),
})

const upsert = (list: MigrationOutcome[], outcome: MigrationOutcome): MigrationOutcome[] => [outcome, ...list.filter((o) => o.id !== outcome.id)].slice(0, LIST_MAX)

export class MigrationReportStore {
  readonly #path: string
  #report: MigrationReport
  #dirty = false

  constructor(path: string, appVersion: string, readonly onChange: (report: MigrationReport) => void = () => undefined) {
    this.#path = path
    this.#report = { ...readReport(path, appVersion), appVersion }
  }

  get(): MigrationReport {
    return structuredClone(this.#report)
  }

  /**
   * Starts a run after an upgrade from `from`. A run that was cut short (the
   * same from and to) carries on, so its count survives a restart.
   */
  startRun(from: number, now: number): void {
    const r = this.#report
    if (r.from === from && r.to === CHAT_FORMAT_VERSION && r.lastRunAt !== null) return
    this.#report = { ...emptyMigrationReport(r.appVersion), lastRunAt: now, from, newer: r.newer }
    this.#dirty = true
  }

  /** One chat's outcome; returns whether the report changed. */
  record(outcome: MigrationOutcome): boolean {
    const r = this.#report
    if (outcome.ok) {
      this.#report = { ...r, lastRunAt: outcome.at, from: r.from ?? outcome.from, migrated: r.migrated + 1, failed: r.failed.filter((o) => o.id !== outcome.id), newer: r.newer.filter((o) => o.id !== outcome.id) }
    } else if (outcome.from > outcome.to) {
      // A newer chat or file: listed once, never counted as a run.
      if (r.newer.some((o) => o.id === outcome.id && o.from === outcome.from)) return false
      this.#report = { ...r, newer: upsert(r.newer, outcome), failed: r.failed.filter((o) => o.id !== outcome.id) }
    } else {
      const same = r.failed.find((o) => o.id === outcome.id)
      if (same && same.error === outcome.error && same.title === outcome.title) return false
      this.#report = { ...r, lastRunAt: r.lastRunAt ?? outcome.at, from: r.from ?? outcome.from, failed: upsert(r.failed, outcome) }
    }
    this.#dirty = true
    return true
  }

  /** A chat that opens fine now (repaired, restored or removed) leaves the failure lists. */
  resolve(id: string): boolean {
    const r = this.#report
    if (!r.failed.some((o) => o.id === id) && !r.newer.some((o) => o.id === id)) return false
    this.#report = { ...r, failed: r.failed.filter((o) => o.id !== id), newer: r.newer.filter((o) => o.id !== id) }
    this.#dirty = true
    return true
  }

  setSkipped(skipped: number): void {
    if (this.#report.skipped === skipped) return
    this.#report = { ...this.#report, skipped: Math.max(0, skipped) }
    this.#dirty = true
  }

  /** Writes migrations.json and tells listeners, when anything changed since the last flush. */
  flush(): void {
    if (!this.#dirty) return
    this.#dirty = false
    try {
      writeAtomic(this.#path, JSON.stringify(this.#report, null, 2))
    } catch (err) {
      log.error('migrations', "Couldn't save the migration report.", { code: (err as NodeJS.ErrnoException).code ?? null })
    }
    this.onChange(this.get())
  }
}

/** The saved report, or an empty one when the file is missing or unreadable. */
export function readReport(path: string, appVersion: string): MigrationReport {
  try {
    const parsed = reportSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data
    log.warn('migrations', 'The migration report was unreadable; starting a new one.')
  } catch {
    // No report yet.
  }
  return emptyMigrationReport(appVersion)
}
