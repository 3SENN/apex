/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Quick decisions (docs/decisions.md): where your decision models
// stand. Each chosen model has its own state (from the decider's status and a
// Test), and the page's one status sums them up in the order a person sets
// it up: switched on, a provider connected, a model chosen, then whether one
// answers. One state drives the badge and the line, so the page never says
// "working" and "not set up" at once.
import type { DecisionErrorCode, DecisionModelRef, DecisionModelStatus, DecisionsStatus, DecisionTestResult, DecisionUse } from '@shared/decisions'

export type ModelHealth =
  /** Its provider has no key any more, or its server was removed. */
  | { kind: 'not-connected' }
  | { kind: 'checking' }
  /** `tested`: from a Test just now, not the last real decision. */
  | { kind: 'working'; answered: string; ms: number; tested: boolean }
  | { kind: 'failing'; error: DecisionErrorCode; detail: string }
  /** Its last answer came too late, so the next model or the rule decided: normal now and then. */
  | { kind: 'slow' }
  | { kind: 'paused'; minutes: number; reason: string | null }
  /** Not asked yet. */
  | { kind: 'unchecked' }

export function refKey(ref: DecisionModelRef): string {
  return `${ref.provider}\n${ref.model}`
}

export function modelHealth(model: DecisionModelStatus, test: DecisionTestResult | null, checking: boolean, now = Date.now()): ModelHealth {
  if (!model.connected) return { kind: 'not-connected' }
  if (checking) return { kind: 'checking' }
  if (test) return test.ok ? { kind: 'working', answered: test.answered, ms: test.ms, tested: true } : { kind: 'failing', error: test.error, detail: test.detail }
  if (model.pausedUntil && model.pausedUntil > now)
    return {
      kind: 'paused',
      minutes: Math.max(1, Math.ceil((model.pausedUntil - now) / 60_000)),
      reason: model.pausedReason,
    }
  if (model.lastError === 'timeout') return { kind: 'slow' }
  if (model.lastError) return { kind: 'failing', error: model.lastError, detail: '' }
  if (model.lastModel)
    return {
      kind: 'working',
      answered: model.lastModel,
      ms: model.lastMs ?? 0,
      tested: false,
    }
  return { kind: 'unchecked' }
}

export type DecisionsHealth =
  | { kind: 'off' }
  | { kind: 'no-provider' }
  | { kind: 'no-model' }
  /** `model`: the first of yours that answers. */
  | { kind: 'working'; model: DecisionModelRef; ms: number }
  | { kind: 'failing' }
  | { kind: 'paused'; minutes: number }
  | { kind: 'ready' }

/** The page's one status, from each model's; `on` is the switch as settings have it, which is right before the status has loaded. */
export function decisionsHealth(status: DecisionsStatus | null, models: ReadonlyArray<{ ref: DecisionModelRef; health: ModelHealth }>, on: boolean = status?.on ?? false): DecisionsHealth {
  if (!on) return { kind: 'off' }
  if (!status) return { kind: 'ready' }
  if (!Object.values(status.connected).some(Boolean)) return { kind: 'no-provider' }
  const usable = models.filter((m) => m.health.kind !== 'not-connected')
  if (usable.length === 0) return { kind: 'no-model' }
  const working = usable.find((m) => m.health.kind === 'working' || m.health.kind === 'slow')
  if (working)
    return {
      kind: 'working',
      model: working.ref,
      ms: working.health.kind === 'working' ? working.health.ms : 0,
    }
  const paused = usable.filter((m) => m.health.kind === 'paused')
  if (paused.length === usable.length)
    return {
      kind: 'paused',
      minutes: Math.min(...paused.map((m) => (m.health.kind === 'paused' ? m.health.minutes : 1))),
    }
  if (usable.every((m) => m.health.kind === 'failing' || m.health.kind === 'paused')) return { kind: 'failing' }
  return { kind: 'ready' }
}

/** Whether the rest of the page (how it's used, what it decides) applies yet. */
export function isSetUp(health: DecisionsHealth): boolean {
  return health.kind !== 'no-provider' && health.kind !== 'no-model'
}

export type HealthTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function healthTone(health: DecisionsHealth | ModelHealth): HealthTone {
  switch (health.kind) {
    case 'off':
    case 'unchecked':
      return 'neutral'
    case 'no-provider':
    case 'no-model':
    case 'not-connected':
    case 'paused':
      return 'warning'
    case 'failing':
      return 'danger'
    case 'working':
    case 'slow':
      return 'success'
    default:
      return 'info'
  }
}

/** A price as people read it: "Free", "$0.042", "$1.20" (per million tokens read). */
export function priceText(price: number | null): string | null {
  if (price === null) return null
  if (price === 0) return 'free'
  return `$${price >= 1 ? price.toFixed(2) : String(Number(price.toPrecision(2)))}`
}

/**
 * A new server's id: random, never one used before, so nothing kept for a
 * removed server (a key, a pause, a last answer) can carry over to a new one.
 */
export function nextServerId(taken: readonly string[], random: () => number = Math.random): `server-${string}` {
  for (;;) {
    const id: `server-${string}` = `server-${Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]).join('')}`
    if (!taken.includes(id)) return id
  }
}

/** Moves a chosen model up (-1) or down (1) in the order; out of range leaves it. */
export function moveModel<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta
  if (to < 0 || to >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item!)
  return next
}

/**
 * The switches in three groups, by where the decision happens, so eleven of
 * them read as three short lists. Every use is in exactly one group.
 */
export const DECISION_USE_GROUPS: ReadonlyArray<{
  id: 'typing' | 'companion' | 'background'
  uses: readonly DecisionUse[]
}> = [
  { id: 'typing', uses: ['searchOrAsk', 'dictation', 'voiceTarget'] },
  {
    id: 'companion',
    uses: ['needsYou', 'agentClicks', 'labeling', 'effort', 'skills', 'setup'],
  },
  { id: 'background', uses: ['tabs', 'memory'] },
]
