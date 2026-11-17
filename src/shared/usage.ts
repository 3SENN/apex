/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The token usage ledger.
// One row per model turn in userData/usage.sqlite. Atelier shows tokens, plus a
// cost estimate labelled as an estimate on the API-key engine only. There
// are no credits, plans, quotas or upgrade prompts anywhere.

/** What a model turn was for. `complete()` calls and QuickModel calls are recorded too. */
export type UsageKind = 'chat' | 'routine' | 'tidy' | 'activity' | 'subtask' | 'import' | 'help' | 'draft' | 'onboarding' | /* atelier.ask from a pack (docs/packs.md) */ 'pack' | /* a decision model's answer (docs/decisions.md) */ 'decide'
export const USAGE_KINDS = [
  'chat', 'routine', 'tidy', 'activity', 'subtask', 'import', 'help', 'draft', 'onboarding', 'pack', 'decide',
] as const satisfies readonly UsageKind[]

export type UsageGroupBy = 'day' | 'chat' | 'companion' | 'model' | 'kind'
export const USAGE_GROUPS = ['day', 'chat', 'companion', 'model', 'kind'] as const satisfies readonly UsageGroupBy[]

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
  /** An estimate on the API-key engine; null on other engines, which show tokens only. */
  approxCostUsd: number | null
}

export interface UsageReport {
  from: number
  to: number
  totals: UsageTotals
  rows: Array<{ key: string; label: string } & UsageTotals>
}

/** One ledger row. `chatId` is null for private chats and for work outside a chat. */
export interface UsageRow {
  at: number
  chatId: string | null
  companionId: string
  model: string
  /** 'api-key', or the id of the engine that answered (no per-token estimate). */
  engine: string
  kind: UsageKind
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export const EMPTY_USAGE: Readonly<UsageTotals> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 0,
  approxCostUsd: null,
}

export interface UsageService {
  report(range: { from: number; to: number }, groupBy: UsageGroupBy): UsageReport
  chat(chatId: string): UsageTotals
}

export interface UsageServices {
  usage: UsageService
}

// Settings › Model and key › Usage; pure, so it is unit-tested

/** The ranges the Usage section shows: this calendar month, and the last 30 days ending today (local time). */
export function usageRanges(now: number): { month: { from: number; to: number }; last30: { from: number; to: number } } {
  const today = new Date(now)
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime()
  const thirtyAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29).getTime()
  return { month: { from: monthStart, to: tomorrow }, last30: { from: thirtyAgo, to: tomorrow } }
}

/** Every token a turn reported, cache included. */
export function usageTokens(t: Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens
}

/** "940", "12.4K", "3.1M": short token counts for bars and rows. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v < 1000) return String(v)
  const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, unit] of units) {
    if (v >= size) {
      const scaled = v / size
      const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '')
      // 999,950 rounds to "1000K"; show it as the next unit instead.
      if (text === '1000' && unit !== 'B') return `1${unit === 'K' ? 'M' : 'B'}`
      return `${text}${unit}`
    }
  }
  return String(v)
}

/** "$0.42", "< $0.01", or null when there is no estimate (another engine, or no rates). Always shown as an estimate. */
export function formatEstimate(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return '< $0.01'
  return `$${usd.toFixed(2)}`
}

/** Bar heights as fractions of the busiest day (0 to 1); a day with any use stays visible. */
export function usageBars(rows: ReadonlyArray<Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>>, minVisible = 0.04): number[] {
  const totals = rows.map(usageTokens)
  const max = Math.max(0, ...totals)
  if (max === 0) return totals.map(() => 0)
  return totals.map((v) => (v === 0 ? 0 : Math.max(minVisible, v / max)))
}
