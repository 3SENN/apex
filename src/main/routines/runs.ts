/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Routine run records (SK-09) in userData/routines.sqlite: one
// row per run, linked to the chat it produced, newest 500 kept per
// routine. Rows outlive their routine, so a deleted routine's history (and
// its chats) stays readable.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { ROUTINE_RUNS_KEPT, type RoutineRun, type RoutineRunStatus, type RoutineTrigger } from '@shared/routines'
import { migrate, openDb, type DatabaseSync } from '../db'

const STEPS = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     routine_id TEXT NOT NULL,
     chat_id TEXT,
     scheduled_for INTEGER NOT NULL,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     status TEXT NOT NULL,
     trigger TEXT NOT NULL,
     read INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX runs_by_routine ON runs (routine_id, started_at DESC);
   CREATE INDEX runs_by_start ON runs (started_at DESC);`,
]

interface Row {
  id: string
  routine_id: string
  chat_id: string | null
  scheduled_for: number
  started_at: number
  finished_at: number | null
  status: string
  trigger: string
  read: number
}

const STATUSES: readonly RoutineRunStatus[] = ['running', 'ok', 'error', 'needs-input', 'stopped']
const TRIGGERS: readonly RoutineTrigger[] = ['schedule', 'manual', 'catch-up']

function toRun(row: Row): RoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    chatId: row.chat_id,
    scheduledFor: Number(row.scheduled_for),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    status: (STATUSES as readonly string[]).includes(row.status) ? (row.status as RoutineRunStatus) : 'error',
    trigger: (TRIGGERS as readonly string[]).includes(row.trigger) ? (row.trigger as RoutineTrigger) : 'schedule',
    read: row.read !== 0,
  }
}

export interface RunQuery {
  routineId?: string
  offset?: number
  limit?: number
  unreadOnly?: boolean
}

/** Emits 'changed' with the routine id (null for several) after every write. */
export class RoutineRunStore extends EventEmitter<{ changed: [string | null] }> {
  readonly #db: DatabaseSync

  constructor(path: string) {
    super()
    this.#db = openDb(path)
    migrate(this.#db, 'routine-runs', STEPS)
    // Runs that were going when Atelier quit never finished.
    this.#db.prepare("UPDATE runs SET status = 'stopped', finished_at = started_at WHERE status = 'running'").run()
  }

  start(input: { routineId: string; scheduledFor: number; trigger: RoutineTrigger; startedAt?: number }): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: input.routineId,
      chatId: null,
      scheduledFor: input.scheduledFor,
      startedAt: input.startedAt ?? Date.now(),
      finishedAt: null,
      status: 'running',
      trigger: input.trigger,
      read: false,
    }
    this.#db
      .prepare('INSERT INTO runs (id, routine_id, chat_id, scheduled_for, started_at, finished_at, status, trigger, read) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, 0)')
      .run(run.id, run.routineId, run.scheduledFor, run.startedAt, run.status, run.trigger)
    this.#prune(run.routineId)
    this.emit('changed', run.routineId)
    return run
  }

  finish(id: string, result: { status: RoutineRunStatus; chatId: string | null; finishedAt?: number; read?: boolean }): RoutineRun | null {
    this.#db
      .prepare('UPDATE runs SET status = ?, chat_id = COALESCE(?, chat_id), finished_at = ?, read = ? WHERE id = ?')
      .run(result.status, result.chatId, result.finishedAt ?? Date.now(), result.read ? 1 : 0, id)
    const run = this.get(id)
    if (run) this.emit('changed', run.routineId)
    return run
  }

  get(id: string): RoutineRun | null {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined
    return row ? toRun(row) : null
  }

  /** Newest first. */
  list(query: RunQuery = {}): { runs: RoutineRun[]; total: number } {
    const where: string[] = []
    const args: Array<string | number> = []
    if (query.routineId) {
      where.push('routine_id = ?')
      args.push(query.routineId)
    }
    if (query.unreadOnly) where.push('read = 0')
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (this.#db.prepare(`SELECT COUNT(*) AS n FROM runs ${clause}`).get(...args) as { n: number }).n
    const limit = Math.max(1, Math.min(1000, query.limit ?? 50))
    const offset = Math.max(0, query.offset ?? 0)
    const rows = this.#db.prepare(`SELECT * FROM runs ${clause} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as Row[]
    return { runs: rows.map(toRun), total: Number(total) }
  }

  /** Marks one routine's runs read, or every run. Running ones too: you have seen they started. */
  markRead(routineId?: string): void {
    if (routineId) this.#db.prepare('UPDATE runs SET read = 1 WHERE routine_id = ? AND read = 0').run(routineId)
    else this.#db.prepare('UPDATE runs SET read = 1 WHERE read = 0').run()
    this.emit('changed', routineId ?? null)
  }

  /** A run's chat was opened: it counts as read. */
  markChatRead(chatId: string): void {
    const row = this.#db.prepare('SELECT routine_id FROM runs WHERE chat_id = ? AND read = 0 LIMIT 1').get(chatId) as { routine_id: string } | undefined
    if (!row) return
    this.#db.prepare('UPDATE runs SET read = 1 WHERE chat_id = ?').run(chatId)
    this.emit('changed', row.routine_id)
  }

  /** Finished runs whose chats you have read since. Running ones wait: their chat isn't done yet. */
  markChatsRead(chatIds: readonly string[]): void {
    if (chatIds.length === 0) return
    const changed = new Set<string>()
    const find = this.#db.prepare('SELECT routine_id FROM runs WHERE chat_id = ? AND read = 0 AND finished_at IS NOT NULL')
    const update = this.#db.prepare('UPDATE runs SET read = 1 WHERE chat_id = ? AND read = 0 AND finished_at IS NOT NULL')
    for (const id of chatIds) {
      const rows = find.all(id) as Array<{ routine_id: string }>
      if (rows.length === 0) continue
      update.run(id)
      for (const r of rows) changed.add(r.routine_id)
    }
    for (const routineId of changed) this.emit('changed', routineId)
  }

  unreadCount(routineId?: string): number {
    const row = routineId
      ? (this.#db.prepare('SELECT COUNT(*) AS n FROM runs WHERE read = 0 AND routine_id = ?').get(routineId) as { n: number })
      : (this.#db.prepare('SELECT COUNT(*) AS n FROM runs WHERE read = 0').get() as { n: number })
    return Number(row.n)
  }

  close(): void {
    this.#db.close()
  }

  #prune(routineId: string): void {
    this.#db
      .prepare('DELETE FROM runs WHERE routine_id = ? AND id NOT IN (SELECT id FROM runs WHERE routine_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)')
      .run(routineId, routineId, ROUTINE_RUNS_KEPT)
  }
}
