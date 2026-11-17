/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approxCostUsd, roundEstimate } from '@shared/pricing'
import { formatEstimate, formatTokens, usageBars, usageRanges, type UsageRow } from '@shared/usage'
import { recordUsage, setUsageSink, type UsageReport as SinkRow } from '../src/main/agent/usageSink'
import { aggregateUsage, dayKey, NO_CHAT, UsageLedger, type StoredTurn } from '../src/main/usage'

// The usage ledger: one row per model turn, reports by day,
// chat, companion, model and kind, and a cost estimate only for the API-key
// engine. No credits, plans or quotas anywhere.

const DAY = 86_400_000

function row(over: Partial<UsageRow> = {}): UsageRow {
  return { at: new Date(2026, 9, 10, 12).getTime(), chatId: 'chat-a', companionId: 'nova', model: 'claude-opus-5-5', engine: 'api-key', kind: 'chat', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, ...over }
}

const ledgers: UsageLedger[] = []
function ledger(): UsageLedger {
  const l = new UsageLedger(join(mkdtempSync(join(tmpdir(), 'apex-usage-')), 'usage.sqlite'))
  ledgers.push(l)
  return l
}

afterEach(() => {
  for (const l of ledgers.splice(0)) l.close()
  setUsageSink(null)
})

describe('the cost estimate', () => {
  it('prices API-key turns from the rate table and knows no other models', () => {
    // Opus 5.5: $4 in, $20 out per million.
    expect(approxCostUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(6, 10)
    expect(approxCostUsd('claude-opus-5-5-20261001', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(4, 10)
    expect(approxCostUsd('some-other-model', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
  })

  it('rounds sums to a hundredth of a cent, after adding up', () => {
    expect(roundEstimate(0.1 + 0.2)).toBe(0.3)
    expect(roundEstimate(0.000_049)).toBe(0)
    expect(roundEstimate(0.000_051)).toBe(0.0001)
  })

  it('shows the estimate as an estimate, and nothing on another engine', () => {
    expect(formatEstimate(null)).toBeNull()
    expect(formatEstimate(0)).toBe('$0.00')
    expect(formatEstimate(0.004)).toBe('< $0.01')
    expect(formatEstimate(12.345)).toBe('$12.35')
  })
})

describe('aggregateUsage', () => {
  const rows: StoredTurn[] = [
    { ...row(), costUsd: 0.006 },
    { ...row({ chatId: 'chat-b', model: 'claude-sonnet-5-5', inputTokens: 500, kind: 'routine' }), costUsd: 0.0012 },
    { ...row({ chatId: null, engine: 'another-engine', companionId: 'kai', inputTokens: 9000, kind: 'tidy' }), costUsd: null },
    { ...row({ at: new Date(2026, 9, 12, 9).getTime(), inputTokens: 10 }), costUsd: 0.0001 },
  ]
  const range = { from: new Date(2026, 9, 10).getTime(), to: new Date(2026, 9, 13).getTime() }

  it('fills every day of the range, oldest first', () => {
    const report = aggregateUsage(rows, range, 'day')
    expect(report.rows.map((r) => r.key)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12'])
    expect(report.rows.map((r) => r.turns)).toEqual([3, 0, 1])
    expect(report.rows[1]?.approxCostUsd).toBeNull()
    expect(report.totals.turns).toBe(4)
    expect(report.totals.inputTokens).toBe(10_510)
  })

  it('groups by chat, companion, model and kind, biggest first, with private rows under no chat', () => {
    const byChat = aggregateUsage(rows, range, 'chat', (k) => (k === NO_CHAT ? 'Outside a chat' : k))
    expect(byChat.rows.map((r) => [r.key, r.label])).toEqual([[NO_CHAT, 'Outside a chat'], ['chat-a', 'chat-a'], ['chat-b', 'chat-b']])
    expect(aggregateUsage(rows, range, 'companion').rows.map((r) => r.key)).toEqual(['kai', 'nova'])
    expect(aggregateUsage(rows, range, 'model').rows.map((r) => r.key)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(aggregateUsage(rows, range, 'kind').rows.map((r) => r.key)).toEqual(['tidy', 'chat', 'routine'])
  })

  it('estimates only API-key turns, and is null when none had rates', () => {
    const totals = aggregateUsage(rows, range, 'kind').totals
    expect(totals.approxCostUsd).toBe(0.0073)
    const codeOnly = aggregateUsage(rows.filter((r) => r.engine === 'another-engine'), range, 'kind')
    expect(codeOnly.totals.approxCostUsd).toBeNull()
    expect(codeOnly.totals.inputTokens).toBe(9000)
  })

  it('leaves out rows outside the range', () => {
    expect(aggregateUsage(rows, { from: range.from, to: range.from + DAY }, 'kind').totals.turns).toBe(3)
  })
})

describe('UsageLedger', () => {
  it('records one row per turn and reports it, with the estimate on the API key only', () => {
    const l = ledger()
    const seen: number[] = []
    l.onRecorded((at) => seen.push(at))
    l.record(row())
    l.record(row({ engine: 'another-engine', inputTokens: 2000, outputTokens: -5 }))
    l.record(row({ chatId: null, kind: 'subtask' }))
    expect(seen).toHaveLength(3)
    const all = { from: 0, to: Date.now() + DAY }
    const report = l.report(all, 'kind')
    expect(report.totals.turns).toBe(3)
    expect(report.totals.outputTokens).toBe(200)
    // Two API-key turns of 1000 in and 100 out on Opus 5.5.
    expect(report.totals.approxCostUsd).toBe(roundEstimate(2 * ((1000 * 4 + 100 * 20) / 1_000_000)))
    expect(l.chat('chat-a').turns).toBe(2)
    expect(l.chat('chat-a').inputTokens).toBe(3000)
    expect(() => l.report({ from: 10, to: 5 }, 'day')).toThrow(/ends before it starts/)
  })

  it('takes QuickModel and complete() rows through the sink', () => {
    const l = ledger()
    setUsageSink((r: SinkRow) => l.record({ ...r, at: r.at ?? Date.now() }))
    recordUsage({ chatId: null, companionId: 'nova', model: 'claude-haiku-5-5', engine: 'api-key', kind: 'help', inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 })
    const kinds = l.report({ from: 0, to: Date.now() + DAY }, 'kind').rows
    expect(kinds.map((r) => r.key)).toEqual(['help'])
    setUsageSink(null)
    // Without a sink (tests, or before the feature starts) nothing breaks.
    expect(() => recordUsage({ chatId: null, companionId: 'nova', model: 'x', engine: 'api-key', kind: 'help', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).not.toThrow()
  })
})

describe('the Usage section helpers', () => {
  it('ranges are this calendar month and the last 30 days, ending tomorrow at midnight', () => {
    const now = new Date(2026, 9, 29, 15, 30).getTime()
    const { month, last30 } = usageRanges(now)
    expect(month).toEqual({ from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 9, 30).getTime() })
    expect(dayKey(last30.from)).toBe('2026-09-30')
    expect(aggregateUsage([], last30, 'day').rows).toHaveLength(30)
  })

  it('formats token counts compactly', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(940)).toBe('940')
    expect(formatTokens(12_400)).toBe('12.4K')
    expect(formatTokens(3_000_000)).toBe('3M')
    expect(formatTokens(999_960)).toBe('1M')
    expect(formatTokens(250_000)).toBe('250K')
  })

  it('scales bars to the busiest day and keeps any used day visible', () => {
    const t = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(usageBars([t(0), t(0)])).toEqual([0, 0])
    expect(usageBars([t(100), t(50), t(0), t(1)])).toEqual([1, 0.5, 0, 0.04])
  })
})
