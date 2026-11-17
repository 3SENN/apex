/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatUsd, gaugeFraction, MODEL_RATES, spendMonth, turnCostUsd } from '../src/shared/pricing'
import { MODELS } from '../src/main/settings'
import { SpendStore } from '../src/main/spend'

describe('turn cost (DS-18)', () => {
  it('prices input, output and cache tokens per million', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 }
    expect(turnCostUsd('claude-opus-5-5', usage)).toBeCloseTo(4 + 2 + 0.4)
    expect(turnCostUsd('claude-haiku-5-5', { ...usage, cacheReadTokens: 0 })).toBeCloseTo(0.1 + 0.05)
  })

  it('prices a dated id as its family and an unknown model as nothing', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(turnCostUsd('claude-sonnet-5-5-20261001', usage)).toBeCloseTo(2)
    expect(turnCostUsd('someone-elses-model', usage)).toBe(0)
  })

  it('has rates for every model Atelier offers', () => {
    for (const model of MODELS) expect(MODEL_RATES[model], model).toBeDefined()
  })

  it('fills the ring against a budget, or fully without one', () => {
    expect(gaugeFraction({ usd: 5, budgetUsd: 20 })).toBe(0.25)
    expect(gaugeFraction({ usd: 50, budgetUsd: 20 })).toBe(1)
    expect(gaugeFraction({ usd: 5, budgetUsd: null })).toBe(1)
    expect(formatUsd(0.004)).toBe('< $0.01')
    expect(formatUsd(12.3)).toBe('$12.30')
  })
})

describe('spend store', () => {
  it('adds turns, saves the month and starts again in a new one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-spend-'))
    let now = new Date(2026, 9, 28).getTime()
    const store = new SpendStore(dir, () => now)
    const seen: number[] = []
    store.on('changed', (v) => seen.push(v.usd))
    store.add(0.5)
    store.add(0.25)
    store.add(-3)
    store.add(Number.NaN)
    expect(store.view()).toEqual({ month: spendMonth(now), usd: 0.75 })
    expect(seen).toEqual([0.5, 0.75])
    expect(JSON.parse(readFileSync(join(dir, 'spend.json'), 'utf8'))).toMatchObject({ month: '2026-10', usd: 0.75 })
    expect(new SpendStore(dir, () => now).view().usd).toBe(0.75)
    now = new Date(2026, 10, 2).getTime()
    expect(store.view()).toEqual({ month: '2026-11', usd: 0 })
  })
})
