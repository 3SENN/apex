/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EngineId, EngineStatus } from '@shared/engine'
import { setupFirstWeek, type FirstWeekWiring } from '../src/main/firstWeekSetup'
import { curatedStarters, type StarterQuick } from '../src/main/firstWeekStarters'

// The getting-started page writes personal starters through QuickModel on
// any engine, and tries again when an engine becomes ready. Fakes only.

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** An engine a build adds besides the API key (its id doesn't matter here). */
const OTHER = 'another-engine' as EngineId

function status(ready: boolean, key: 'saved' | 'missing' = 'missing'): EngineStatus {
  return {
    engine: 'api-key',
    engines: ['api-key', OTHER],
    apiKey: { state: key },
    others: [{ id: OTHER, ready, checking: false, detail: '', badge: ready ? 'Ready' : 'Not signed in', tone: ready ? 'success' : 'warning' }],
    external: { enabled: false, url: null, command: null, tabs: 'own', added: false, activeTabs: 0, lastUsedAt: null, problem: null },
    processes: 0,
  } as EngineStatus
}

const okStarters = { starters: curatedStarters().slice(0, 5).map(({ title, description, prompt, glyph }) => ({ title: `Mine: ${title}`, description, prompt, glyph })) }

function wiring(quick: StarterQuick | undefined) {
  const settings = Object.assign(new EventEmitter(), { get: () => ({ userName: 'Sam', onboarded: true }), apiKey: () => null })
  const companions = Object.assign(new EventEmitter(), {
    get: () => ({ id: 'pip', name: 'Pip', instructions: '' }),
    list: () => [{ id: 'pip', name: 'Pip', persona: '', look: null, instructions: '' }],
  })
  const connectors = Object.assign(new EventEmitter(), { views: () => [] })
  const routines = Object.assign(new EventEmitter(), { list: () => [] })
  const engines = new EventEmitter<{ changed: [EngineStatus] }>()
  const w = {
    dataDir: mkdtempSync(join(tmpdir(), 'atelier-first-week-setup-')),
    settings,
    companions,
    connectors,
    routines,
    memory: { list: () => [], read: () => '' },
    history: { search: () => [] },
    sendEvent: () => undefined,
    isDefaultBrowser: () => false,
    makeDefaultBrowser: () => undefined,
    ...(quick ? { quick, engines } : {}),
  } as unknown as FirstWeekWiring
  return { w, settings, engines }
}

describe('first-week starters on any engine', () => {
  it('keeps the curated starters and tries again once another engine becomes ready', async () => {
    let ready = false
    const json = vi.fn(async () => okStarters)
    const quick: StarterQuick = { ready: async () => (ready ? { ok: true, engine: OTHER } : { ok: false, engine: null, reason: 'The other engine is signed out.' }), json: json as unknown as StarterQuick['json'] }
    const { w, engines } = wiring(quick)
    const { store } = setupFirstWeek(w)
    expect(store.view().startersSource).toBe('curated')
    await flush()
    expect(json).not.toHaveBeenCalled()

    // A status change that leaves the engine not ready does nothing.
    engines.emit('changed', status(false))
    await flush()
    expect(json).not.toHaveBeenCalled()

    ready = true
    engines.emit('changed', status(true))
    await flush()
    await flush()
    expect(json).toHaveBeenCalledTimes(1)
    expect(json.mock.calls[0]).toMatchObject([{ kind: 'onboarding', effort: 'low' }])
    expect(store.view().startersSource).toBe('personal')
    store.dispose()
  })

  it('tries again on a settings change too (a key saved, or the engine switched)', async () => {
    let ready = false
    const json = vi.fn(async () => okStarters)
    const quick: StarterQuick = { ready: async () => (ready ? { ok: true, engine: 'api-key' } : { ok: false, engine: null, reason: 'none' }), json: json as unknown as StarterQuick['json'] }
    const { w, settings } = wiring(quick)
    const { store } = setupFirstWeek(w)
    store.view()
    await flush()
    ready = true
    settings.emit('changed')
    await flush()
    await flush()
    expect(store.view().startersSource).toBe('personal')
    store.dispose()
  })

  it('does not retry after a real failure, and smoke (no quick) stays curated', async () => {
    const json = vi.fn(async () => Promise.reject(new Error('offline')))
    const quick: StarterQuick = { ready: async () => ({ ok: true, engine: 'api-key' }), json: json as unknown as StarterQuick['json'] }
    const { w, engines } = wiring(quick)
    const { store } = setupFirstWeek(w)
    store.view()
    await flush()
    await flush()
    engines.emit('changed', status(true))
    await flush()
    expect(json).toHaveBeenCalledTimes(1)
    expect(store.view().startersSource).toBe('curated')
    store.dispose()

    const smoke = setupFirstWeek(wiring(undefined).w)
    expect(smoke.store.view().startersSource).toBe('curated')
    smoke.store.dispose()
  })
})
