/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DECISIONS_SETTINGS_SCHEMA, DECISIONS_DEFAULTS, DECISION_USES, perMessageEffort, type DecisionModelStatus, type DecisionsStatus } from '../src/shared/decisions'
import { DECISION_USE_GROUPS, decisionsHealth, healthTone, isSetUp, modelHealth, moveModel, nextServerId, priceText } from '../src/renderer/src/settings/logic/decisions'
import { SETTINGS_INDEX } from '../src/shared/settingsIndex'
import { SETTINGS_PAGES } from '../src/shared/url'

// Settings › Quick decisions (docs/decisions.md): any providers, your models
// in order, each with its own state, one status for the page, and the
// switches in three groups.

const NOW = 1_000_000
const model = (patch: Partial<DecisionModelStatus> = {}): DecisionModelStatus => ({
  provider: 'experiential',
  model: 'clef-flash',
  connected: true,
  lastModel: null,
  lastMs: null,
  lastError: null,
  pausedUntil: null,
  pausedReason: null,
  ...patch,
})
const status = (patch: Partial<DecisionsStatus> = {}): DecisionsStatus => ({
  on: true,
  keys: { experiential: true },
  connected: {
    typesafe: false,
    openrouter: false,
    experiential: true,
    openai: false,
  },
  ready: true,
  models: [model()],
  answered: 0,
  differed: 0,
  ...patch,
})
const rows = (s: DecisionsStatus) =>
  s.models.map((m) => ({
    ref: { provider: m.provider, model: m.model },
    health: modelHealth(m, null, false, NOW),
  }))

describe('each model’s state', () => {
  it('says whether it can be asked, how a Test went, or how its last decision went', () => {
    expect(modelHealth(model({ connected: false }), null, false)).toEqual({
      kind: 'not-connected',
    })
    expect(modelHealth(model(), null, true)).toEqual({ kind: 'checking' })
    expect(
      modelHealth(
        model(),
        {
          provider: 'experiential',
          model: 'clef-flash',
          ok: true,
          answered: 'clef-flash',
          ms: 512,
        },
        false,
      ),
    ).toEqual({
      kind: 'working',
      answered: 'clef-flash',
      ms: 512,
      tested: true,
    })
    expect(
      modelHealth(
        model(),
        {
          provider: 'experiential',
          model: 'clef-flash',
          ok: false,
          error: 'overloaded',
          detail: 'provider service failed',
        },
        false,
      ),
    ).toEqual({
      kind: 'failing',
      error: 'overloaded',
      detail: 'provider service failed',
    })
    expect(
      modelHealth(
        model({
          pausedUntil: NOW + 90_000,
          pausedReason: 'Enable Keep going on credits',
        }),
        null,
        false,
        NOW,
      ),
    ).toEqual({
      kind: 'paused',
      minutes: 2,
      reason: 'Enable Keep going on credits',
    })
    expect(modelHealth(model({ lastError: 'timeout', lastModel: 'clef-flash' }), null, false)).toEqual({ kind: 'slow' })
    expect(modelHealth(model({ lastError: 'overloaded', lastModel: 'clef-flash' }), null, false)).toEqual({ kind: 'failing', error: 'overloaded', detail: '' })
    expect(modelHealth(model({ lastModel: 'clef-flash', lastMs: 480 }), null, false)).toEqual({
      kind: 'working',
      answered: 'clef-flash',
      ms: 480,
      tested: false,
    })
    expect(modelHealth(model(), null, false)).toEqual({ kind: 'unchecked' })
  })
})

describe('the page’s one status', () => {
  it('follows the setup: off, a provider, a model, then whether one answers', () => {
    expect(decisionsHealth(status({ on: false }), [])).toEqual({ kind: 'off' })
    expect(decisionsHealth(null, [])).toEqual({ kind: 'off' })
    // Before the status has loaded, the switch as settings have it decides between off and on.
    expect(decisionsHealth(null, [], true)).toEqual({ kind: 'ready' })
    expect(decisionsHealth(status({ connected: { experiential: false }, models: [] }), [])).toEqual({ kind: 'no-provider' })
    expect(decisionsHealth(status({ models: [] }), [])).toEqual({
      kind: 'no-model',
    })
    const disconnected = status({ models: [model({ connected: false })] })
    expect(decisionsHealth(disconnected, rows(disconnected))).toEqual({
      kind: 'no-model',
    })
    expect(decisionsHealth(status(), rows(status()))).toEqual({
      kind: 'ready',
    })
  })

  it('is working while any of your models answers, and says which', () => {
    const s = status({
      models: [
        model({ lastError: 'overloaded' }),
        model({
          provider: 'openrouter',
          model: 'liquid/d1',
          lastModel: 'liquid/d1',
          lastMs: 300,
        }),
      ],
    })
    expect(decisionsHealth(s, rows(s))).toEqual({
      kind: 'working',
      model: { provider: 'openrouter', model: 'liquid/d1' },
      ms: 300,
    })
    const down = status({
      models: [model({ lastError: 'overloaded' }), model({ model: 'clef', pausedUntil: NOW + 60_000 })],
    })
    expect(decisionsHealth(down, rows(down))).toEqual({ kind: 'failing' })
    const paused = status({
      models: [model({ pausedUntil: NOW + 60_000 }), model({ model: 'clef', pausedUntil: NOW + 180_000 })],
    })
    expect(decisionsHealth(paused, rows(paused))).toEqual({
      kind: 'paused',
      minutes: 1,
    })
  })

  it('shows the rest of the page only once a model can be asked', () => {
    expect(isSetUp({ kind: 'no-provider' })).toBe(false)
    expect(isSetUp({ kind: 'no-model' })).toBe(false)
    expect(healthTone({ kind: 'failing' })).toBe('danger')
    expect(healthTone({ kind: 'paused', minutes: 1 })).toBe('warning')
    expect(healthTone({ kind: 'slow' })).toBe('success')
    expect(healthTone({ kind: 'not-connected' })).toBe('warning')
  })
})

describe('the page’s helpers', () => {
  it('reads prices, names new servers and moves models in the order', () => {
    expect([priceText(null), priceText(0), priceText(0.042), priceText(0.09), priceText(1.2)]).toEqual([null, 'free', '$0.042', '$0.09', '$1.20'])
    // Random, never one already taken, so nothing kept for a removed server carries over.
    expect(nextServerId([])).toMatch(/^server-[a-z0-9]{10}$/)
    let n = 0
    const fixed = (): number => (n++ < 10 ? 0 : 0.5)
    expect(nextServerId(['server-aaaaaaaaaa'], fixed)).toBe('server-ssssssssss')
    expect(moveModel(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveModel(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveModel(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
  })

  it('keeps settings for many providers and servers, and refuses what isn’t one', () => {
    const many = {
      ...DECISIONS_DEFAULTS,
      on: true,
      servers: [{ id: 'server-1', name: 'Kev', url: 'http://127.0.0.1:8009' }],
      models: [
        { provider: 'openrouter', model: 'parallel/decisions-fast:free' },
        { provider: 'server-1', model: 'kev-latest' },
        { provider: 'experiential', model: 'clef-flash' },
      ],
    }
    expect(DECISIONS_SETTINGS_SCHEMA.safeParse(many).success).toBe(true)
    expect(
      DECISIONS_SETTINGS_SCHEMA.safeParse({
        ...many,
        models: [{ provider: 'evil', model: 'x' }],
      }).success,
    ).toBe(false)
    expect(
      DECISIONS_SETTINGS_SCHEMA.safeParse({
        ...many,
        servers: [{ id: 'server-1', name: 'x', url: 'file:///etc/passwd' }],
      }).success,
    ).toBe(false)
    // A name or password in an address would sit in settings.json in plain text.
    expect(DECISIONS_SETTINGS_SCHEMA.safeParse({ ...many, servers: [{ id: 'server-1', name: 'x', url: 'https://me:secret@gateway.example' }] }).success).toBe(false)
    expect(
      DECISIONS_SETTINGS_SCHEMA.safeParse({
        ...many,
        models: Array.from({ length: 7 }, (_, i) => ({
          provider: 'openrouter',
          model: `m${i}`,
        })),
      }).success,
    ).toBe(false)
  })

  it('groups every switch exactly once', () => {
    const grouped = DECISION_USE_GROUPS.flatMap((g) => g.uses)
    expect([...grouped].sort()).toEqual([...DECISION_USES].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('has its own page, found by Settings search, and knows which models take effort per message', () => {
    expect(SETTINGS_PAGES.findIndex((p) => p.id === 'decisions')).toBe(SETTINGS_PAGES.findIndex((p) => p.id === 'model') + 1)
    const found = SETTINGS_INDEX.filter((e) => e.keywords.some((k) => /jev|openrouter key|group tabs|backup model/.test(k)))
    expect(new Set(found.map((e) => e.page))).toEqual(new Set(['decisions']))
    expect(perMessageEffort('claude-opus-5-5')).toBe(true)
    expect(perMessageEffort('claude-haiku-5-5')).toBe(false)
  })
})
