/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Routines (SK-07 to SK-10, SK-12): full routines, one-off tasks, run
// history and suggested routines. Runs are kept in userData/routines.sqlite;
// the older routines.json rows (and hourly intervals) are migrated on load.
import type { Routine as A0Routine } from './services'

export type RoutineSchedule =
  | { kind: 'daily'; time: string; days: number[] }
  /** `between` is a daily window in minutes of the day, 0–1440 (end not included); the editor picks whole hours. */
  | { kind: 'interval'; minutes: number; between?: { start: number; end: number }; days?: number[] }
  | { kind: 'cron'; expr: string }
  | { kind: 'once'; at: number }

export type RoutineScheduleKind = RoutineSchedule['kind']
export const ROUTINE_SCHEDULE_KINDS = ['daily', 'interval', 'cron', 'once'] as const satisfies readonly RoutineScheduleKind[]

export type RoutineDestination = { kind: 'new-chat' } | { kind: 'append'; chatId: string }

export interface Routine extends Omit<A0Routine, 'schedule'> {
  schedule: RoutineSchedule
  /** IANA zone the schedule is read in; null follows the system zone. */
  timeZone: string | null
  skillId: string | null
  destination: RoutineDestination
  /** Bumped on every save; a save with an older revision throws 'changed-elsewhere'. */
  revision: number
  createdAt: number
  updatedAt: number
  /** Its companion was removed: it waits until you pick another. */
  needsCompanion: boolean
  /** Set once when a migration changed the schedule (an older interval over 24 hours). */
  notice?: string | null
  /** DC-07: "Only tell me if…": after a run, the notification is sent only when the reply shows this (empty: always). */
  notifyIf: string
}

/** The longest "Only tell me if…" condition. */
export const NOTIFY_IF_MAX = 300

export type RoutineRunStatus = 'running' | 'ok' | 'error' | 'needs-input' | 'stopped'
export type RoutineTrigger = 'schedule' | 'manual' | 'catch-up'

export interface RoutineRun {
  id: string
  routineId: string
  chatId: string | null
  scheduledFor: number
  startedAt: number
  finishedAt: number | null
  status: RoutineRunStatus
  trigger: RoutineTrigger
  read: boolean
}

export interface RoutineDraft {
  name: string
  prompt: string
  skillId?: string
  schedule: RoutineSchedule
  companionId?: string
  destination?: RoutineDestination
  timeZone?: string | null
  notifyIf?: string
}

export interface RoutineSuggestion {
  id: string
  title: string
  reason: string
  draft: RoutineDraft
}

export interface RoutineFilter {
  status?: 'active' | 'paused' | 'past'
  companionId?: string
  kind?: RoutineScheduleKind
  query?: string
  sort?: 'name' | 'next-run'
}

/** The older interval, in hours; read once from routines.json and migrated to minutes. */
export type LegacyRoutineSchedule = { kind: 'interval'; hours: number }

/** Interval routines run every 30 minutes up to once a day (SK-08). */
export const INTERVAL_MINUTES = { min: 30, max: 1440 } as const

/** Run records kept per routine. */
export const ROUTINE_RUNS_KEPT = 500

/**
 * What `routines.save` takes. `companionId` is the newer name for the owner;
 * older callers (companion import, first week) still pass `owner` and may
 * pass an older schedule, which is migrated on the way in.
 */
export type RoutineSaveInput = Omit<RoutineDraft, 'schedule'> & {
  schedule: RoutineSchedule | LegacyRoutineSchedule
  id?: string
  enabled: boolean
  revision?: number
  owner?: string
}

/** A one-off task that already ran: it sits in the Past group. */
export function isPastRoutine(routine: Pick<Routine, 'schedule' | 'lastRunAt' | 'nextRunAt'>): boolean {
  return routine.schedule.kind === 'once' && routine.lastRunAt !== null && routine.nextRunAt === null
}
/** The Routines page's filters and sorts (SK-05), shared by `routines.list(filter)` and the page. Without a status every routine is listed, past ones included. */
export function filterRoutines<T extends Pick<Routine, 'name' | 'prompt' | 'enabled' | 'owner' | 'schedule' | 'lastRunAt' | 'nextRunAt'>>(routines: readonly T[], filter: RoutineFilter = {}): T[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const out = routines.filter((r) => {
    const past = isPastRoutine(r)
    if (filter.status === 'past' && !past) return false
    if (filter.status === 'active' && (past || !r.enabled)) return false
    if (filter.status === 'paused' && (past || r.enabled)) return false
    if (filter.companionId && r.owner !== filter.companionId) return false
    if (filter.kind && r.schedule.kind !== filter.kind) return false
    const text = `${r.name} ${r.prompt}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  if (filter.sort === 'next-run') {
    const rank = (r: T): number => (r.enabled && r.nextRunAt !== null ? r.nextRunAt : Number.POSITIVE_INFINITY)
    return out.sort((a, b) => rank(a) - rank(b) || byName(a, b))
  }
  return filter.sort === 'name' ? out.sort(byName) : out
}

/** The error message a stale `revision` save throws. */
export const ROUTINE_CHANGED_ELSEWHERE = 'changed-elsewhere'

/**
 * Methods added to the `routines` namespace. The original methods (list,
 * save, remove, runNow) keep their names; `list(filter?)` and
 * `save(RoutineDraft & { id?; enabled; revision? })` are widened.
 */
export interface RoutinesMethods {
  get(id: string): Routine
  setEnabled(id: string, enabled: boolean): Routine
  runs(query: { routineId?: string; offset?: number; limit?: number; unreadOnly?: boolean }): { runs: RoutineRun[]; total: number }
  markRunsRead(routineId?: string): void
  previewSchedule(schedule: RoutineSchedule, timeZone: string | null, count?: number): number[]
  validateCron(expr: string): { ok: true } | { ok: false; error: string }
  suggestions(): RoutineSuggestion[]
  dismissSuggestion(id: string): void
}

/** AppEvent additions for routines. */
export type RoutinesEvent = { type: 'routine-runs'; routineId: string | null }
