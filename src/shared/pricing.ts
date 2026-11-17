/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a turn costs on your own Anthropic key, for the footer gauge and the
// main menu's meter (DS-18, DS-93). Atelier sells nothing: this only adds up
// what your key spent, from the token counts each reply reports. Rates are
// US dollars per million tokens, first-party API list prices (October 2026);
// cache writes are the 5-minute rate.

export interface ModelRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export const MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  // Checked against the claude-api skill's table (2026-10).
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The cost of one turn in US dollars; 0 for a model Atelier has no rates for. */
export function turnCostUsd(model: string, usage: TokenUsage): number {
  // A reply served by a dated or fallback id still prices as its family.
  const rates = MODEL_RATES[model] ?? Object.entries(MODEL_RATES).find(([id]) => model.startsWith(`${id}-`))?.[1]
  if (!rates) return 0
  const per = (tokens: number, rate: number): number => (Math.max(0, tokens) * rate) / 1_000_000
  return per(usage.inputTokens, rates.input) + per(usage.outputTokens, rates.output) + per(usage.cacheReadTokens, rates.cacheRead) + per(usage.cacheWriteTokens, rates.cacheWrite)
}

/** "2026-10": the calendar month spend is counted in, in local time. */
export function spendMonth(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export interface SpendView {
  month: string
  /** This month's spend in US dollars. */
  usd: number
  /** The monthly budget you set, or null for none. */
  budgetUsd: number | null
}

/** How full the footer ring is: spend over budget, capped at 1; a full ring without a budget. */
export function gaugeFraction(view: Pick<SpendView, 'usd' | 'budgetUsd'>): number {
  if (view.budgetUsd === null || !(view.budgetUsd > 0)) return 1
  return Math.min(1, Math.max(0, view.usd / view.budgetUsd))
}

/** "$0.42", "$12.30", "< $0.01". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '< $0.01'
  return `$${usd.toFixed(2)}`
}

/**
 * The usage meter's estimate for one turn on the API-key engine,
 * in US dollars, or null for a model Atelier has no rates for. Always shown as
 * an estimate; other engines show tokens only.
 */
export function approxCostUsd(model: string, usage: TokenUsage): number | null {
  const known = Object.hasOwn(MODEL_RATES, model) || Object.keys(MODEL_RATES).some((id) => model.startsWith(`${id}-`))
  return known ? turnCostUsd(model, usage) : null
}

/** An estimate kept to a hundredth of a cent, so sums of many small turns don't show float noise. Sum first, then round. */
export function roundEstimate(usd: number): number {
  return Math.round(usd * 10_000) / 10_000
}
