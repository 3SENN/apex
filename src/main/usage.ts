/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The usage ledger: one row per model turn in
// userData/usage.sqlite, on src/main/db.ts. It covers chats, routines, tidy,
// activity notes, subtasks, imports, help and drafts, including complete()
// calls and QuickModel calls. Apex shows tokens; on the API-key engine it
// adds a cost estimate, always labelled as one. No credits, plans or quotas.
import type { DatabaseSync } from 'node:sqlite'
import { approxCostUsd, roundEstimate } from '@shared/pricing'
import { EMPTY_USAGE, type UsageGroupBy, type UsageReport, type UsageRow, type UsageTotals } from '@shared/usage'
import { migrate, openDb } from './db'
import { log } from './log'

/** Append-only steps for this database; never edit a shipped one. */
export const USAGE_STEPS = [
  `CREATE TABLE turns (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    chat_id TEXT,
    companion_id TEXT NOT NULL,
    model TEXT NOT NULL,
    engine TEXT NOT NULL,
    kind TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL
  );
  CREATE INDEX turns_at ON turns(at);
  CREATE INDEX turns_chat ON turns(chat_id);`,
]

/** A ledger row as stored, with its estimate (null on other engines or for a model without rates). */
export interface StoredTurn extends UsageRow {
  costUsd: number | null
}

const DAY_MS = 86_400_000
const DAYS_MAX = 400
const ROWS_MAX = 100
/** The key rows without a chat (private chats, work outside a chat) group under. */
export const NO_CHAT = 'none'

/** "2026-10-29" in local time. */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function keyOf(row: StoredTurn, groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case 'day': return dayKey(row.at)
    case 'chat': return row.chatId ?? NO_CHAT
    case 'companion': return row.companionId || NO_CHAT
    case 'model': return row.model
    case 'kind': return row.kind
  }
}

interface Acc {
  totals: UsageTotals
  cost: number
  priced: boolean
}

function emptyAcc(): Acc {
  return { totals: { ...EMPTY_USAGE }, cost: 0, priced: false }
}

function add(acc: Acc, row: StoredTurn): void {
  acc.totals.inputTokens += row.inputTokens
  acc.totals.outputTokens += row.outputTokens
  acc.totals.cacheReadTokens += row.cacheReadTokens
  acc.totals.cacheWriteTokens += row.cacheWriteTokens
  acc.totals.turns += 1
  if (row.costUsd !== null) {
    acc.cost += row.costUsd
    acc.priced = true
  }
}

function finish(acc: Acc): UsageTotals {
  return { ...acc.totals, approxCostUsd: acc.priced ? roundEstimate(acc.cost) : null }
}

export function totalTokens(t: Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens
}

/**
 * Adds rows up into a report. By day, every day of the range is present
 * (oldest first) so a chart has no gaps; otherwise rows go biggest first.
 * The estimate covers only API-key turns and is null when none had rates.
 */
export function aggregateUsage(rows: readonly StoredTurn[], range: { from: number; to: number }, groupBy: UsageGroupBy, label: (key: string) => string = (key) => key): UsageReport {
  const total = emptyAcc()
  const groups = new Map<string, Acc>()
  if (groupBy === 'day' && range.to > range.from) {
    const first = new Date(range.from)
    first.setHours(0, 0, 0, 0)
    for (let at = first.getTime(), n = 0; at < range.to && n < DAYS_MAX; n++) {
      groups.set(dayKey(at), emptyAcc())
      // Step by calendar day so daylight-saving changes don't skip or repeat a day.
      const next = new Date(at)
      next.setDate(next.getDate() + 1)
      at = next.getTime()
    }
  }
  for (const row of rows) {
    if (row.at < range.from || row.at >= range.to) continue
    add(total, row)
    const key = keyOf(row, groupBy)
    let acc = groups.get(key)
    if (!acc) {
      if (groupBy === 'day') continue
      acc = emptyAcc()
      groups.set(key, acc)
    }
    add(acc, row)
  }
  let entries = [...groups].map(([key, acc]) => ({ key, label: label(key), ...finish(acc) }))
  if (groupBy === 'day') entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  else entries = entries.sort((a, b) => totalTokens(b) - totalTokens(a) || a.key.localeCompare(b.key)).slice(0, ROWS_MAX)
  return { from: range.from, to: range.to, totals: finish(total), rows: entries }
}

/** Opens the ledger's database through db.ts; tests pass an in-memory one. */
export type UsageOpener = (path: string) => DatabaseSync

const openUsageDb: UsageOpener = (path) => {
  const db = openDb(path)
  migrate(db, 'usage', USAGE_STEPS)
  return db
}

interface TurnRowSql {
  at: number
  chat_id: string | null
  companion_id: string
  model: string
  engine: string
  kind: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number | null
}

function fromSql(r: TurnRowSql): StoredTurn {
  return {
    at: r.at,
    chatId: r.chat_id,
    companionId: r.companion_id,
    model: r.model,
    engine: r.engine || 'api-key',
    kind: r.kind as UsageRow['kind'],
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    costUsd: r.cost_usd,
  }
}

const clean = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

export class UsageLedger {
  readonly #open: UsageOpener
  #db: DatabaseSync | null = null
  #listeners: Array<(at: number) => void> = []

  constructor(readonly path: string, open: UsageOpener = openUsageDb) {
    this.#open = open
  }

  /** Called after each recorded turn (the feature throttles the `usage` event). */
  onRecorded(listener: (at: number) => void): void {
    this.#listeners.push(listener)
  }

  record(row: UsageRow): void {
    try {
      const usage = {
        inputTokens: clean(row.inputTokens),
        outputTokens: clean(row.outputTokens),
        cacheReadTokens: clean(row.cacheReadTokens),
        cacheWriteTokens: clean(row.cacheWriteTokens),
      }
      // Other engines show tokens only; the estimate is for your own API key.
      const cost = row.engine === 'api-key' ? approxCostUsd(row.model, usage) : null
      this.#database()
        .prepare('INSERT INTO turns (at, chat_id, companion_id, model, engine, kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.at, row.chatId, row.companionId, row.model.slice(0, 120), row.engine, row.kind, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, cost)
      for (const listener of this.#listeners) listener(row.at)
    } catch (err) {
      log.warn('usage', 'Could not record a model turn', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  rows(range: { from: number; to: number }, chatId?: string): StoredTurn[] {
    const db = this.#database()
    const sql = chatId === undefined
      ? db.prepare('SELECT * FROM turns WHERE at >= ? AND at < ? ORDER BY at')
      : db.prepare('SELECT * FROM turns WHERE chat_id = ? AND at >= ? AND at < ? ORDER BY at')
    const result = chatId === undefined ? sql.all(range.from, range.to) : sql.all(chatId, range.from, range.to)
    return (result as unknown as TurnRowSql[]).map(fromSql)
  }

  report(range: { from: number; to: number }, groupBy: UsageGroupBy, label?: (key: string) => string): UsageReport {
    if (range.to < range.from) throw new Error('The range ends before it starts.')
    const from = groupBy === 'day' ? Math.max(range.from, range.to - DAYS_MAX * DAY_MS) : range.from
    return aggregateUsage(this.rows({ from, to: range.to }), { from, to: range.to }, groupBy, label)
  }

  chat(chatId: string): UsageTotals {
    return aggregateUsage(this.rows({ from: 0, to: Number.MAX_SAFE_INTEGER }, chatId), { from: 0, to: Number.MAX_SAFE_INTEGER }, 'kind').totals
  }

  close(): void {
    try {
      this.#db?.close()
    } catch {
      // Already closed.
    }
    this.#db = null
  }

  #database(): DatabaseSync {
    if (this.#db) return this.#db
    try {
      this.#db = this.#open(this.path)
      return this.#db
    } catch (err) {
      // db.ts may not be ready yet; try again on the next call rather than for good.
      const error = err instanceof Error ? err : new Error(String(err))
      log.warn('usage', 'Could not open the usage ledger', { error: error.message })
      throw new Error('Usage could not be read right now.')
    }
  }
}
