/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

// Features wire Electron (ipcMain listeners, sessions) as they start; here every Electron API is a no-op.
vi.mock('electron', () => {
  const noop: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === 'then' ? undefined : noop),
    apply: () => noop,
    construct: () => noop as object,
  })
  return new Proxy({}, { get: (_t, key) => (key === 'then' || key === '__esModule' ? undefined : noop), has: () => true })
})
import { z } from 'zod'
import { SERVICE_SCHEMAS } from '../src/main/services'
import { ADDRESS_SCHEMAS } from '../src/main/schemas/address'
import { CHAT_SCHEMAS, CHATS_SCHEMA_ADDITIONS } from '../src/main/schemas/chat'
import { CORE_SCHEMAS } from '../src/main/schemas/core'
import { DOWNLOADS_SCHEMA_ADDITIONS, MENU_SCHEMAS } from '../src/main/schemas/menus'
import { SETTINGS_SCHEMAS } from '../src/main/schemas/settings'
import { SITE_SCHEMAS } from '../src/main/schemas/sites'
import { SPLIT_SCHEMA_ADDITIONS, TAB_SCHEMAS, TABS_SCHEMA_ADDITIONS } from '../src/main/schemas/tabs'
import { FEATURES, mergeServices } from '../src/main/features'
import type { AppContext, WindowContext } from '../src/main/features/types'
import { CommandRegistry } from '../src/main/commands'

// Every service method has an argument schema: the type of
// SERVICE_SCHEMAS already demands one per method, and this checks each is a
// zod tuple and that the core features provide a function for each core method.

// The core features' own schema maps: their new namespaces, and their additions to the base ones.
const CORE_FEATURE_SCHEMAS: Record<string, Record<string, unknown>> = {
  ...CORE_SCHEMAS,
  ...ADDRESS_SCHEMAS,
  ...TAB_SCHEMAS,
  ...SITE_SCHEMAS,
  ...MENU_SCHEMAS,
  ...CHAT_SCHEMAS,
  ...SETTINGS_SCHEMAS,
  tabs: TABS_SCHEMA_ADDITIONS,
  split: SPLIT_SCHEMA_ADDITIONS,
  chats: CHATS_SCHEMA_ADDITIONS,
  downloads: DOWNLOADS_SCHEMA_ADDITIONS,
}

/** Anything a feature calls on a store it doesn't need here answers with another no-op. */
const inert = (): unknown => {
  const p: unknown = new Proxy(function () {}, { get: (_t, key) => (key === 'then' || key === Symbol.iterator ? undefined : p), apply: () => p })
  return p
}

// Other features extend AppContext; the core features read only these fields.
function fakeApp(): AppContext {
  return ({
    dataDir: '/tmp/apex-test',
    settings: { get: () => ({}), view: () => ({}), on: () => undefined, off: () => undefined } as unknown as AppContext['settings'],
    agent: inert() as AppContext['agent'],
    windows: { list: () => [], focused: () => null, get: () => undefined, open: () => 1, openChat: () => 1, recentlyClosed: () => [], reopen: () => false } as unknown as AppContext['windows'],
    tabsRegistry: inert() as AppContext['tabsRegistry'],
    commands: new CommandRegistry(),
    broadcast: () => undefined,
  } satisfies Partial<AppContext>) as unknown as AppContext
}

describe('service schemas', () => {
  it('are zod tuples for every method', () => {
    for (const [ns, methods] of Object.entries(SERVICE_SCHEMAS)) {
      for (const [method, schema] of Object.entries(methods as Record<string, unknown>)) {
        expect(schema instanceof z.ZodTuple, `${ns}.${method}`).toBe(true)
      }
    }
  })

  it('has a core feature implementation for every core method', () => {
    const app = fakeApp()
    // Window-scoped methods (windows.current, setFocusMode) come from the features' window parts.
    const win = { id: 1, kind: 'normal', window: { close: () => undefined }, chromeWindow: { state: () => ({}), setFocusMode: () => undefined }, send: () => undefined } as unknown as WindowContext
    const windowParts = (f: (typeof FEATURES)[number]) => {
      try {
        return f.window?.(win)
      } catch {
        return undefined
      }
    }
    const browserSmoke = FEATURES.slice(0, 7)
    const merged = mergeServices(...browserSmoke.map((f) => f.app?.(app)), ...browserSmoke.map(windowParts)) as unknown as Record<string, Record<string, unknown>>
    for (const [ns, schemas] of Object.entries(CORE_FEATURE_SCHEMAS)) {
      for (const method of Object.keys(schemas)) {
        expect(typeof merged[ns]?.[method], `${ns}.${method}`).toBe('function')
        expect((SERVICE_SCHEMAS as unknown as Record<string, Record<string, unknown>>)[ns]?.[method], `${ns}.${method} is spread into SERVICE_SCHEMAS`).toBe(schemas[method])
      }
    }
  })

  it('rejects malformed arguments for core methods', () => {
    expect(SERVICE_SCHEMAS.tabGroups.update.safeParse(['g1', { color: 'neon' }]).success).toBe(false)
    expect(SERVICE_SCHEMAS.tabGroups.update.safeParse(['g1', { color: 'fern' }]).success).toBe(true)
    expect(SERVICE_SCHEMAS.split.setRatio.safeParse([0.95]).success).toBe(false)
    expect(SERVICE_SCHEMAS.sites.get.safeParse(['https://example.com']).success).toBe(true)
    expect(SERVICE_SCHEMAS.sites.get.safeParse(['https://example.com/path']).success).toBe(false)
    expect(SERVICE_SCHEMAS.chats.interrupt.safeParse(['00000000-0000-0000-0000-000000000000', '']).success).toBe(false)
    expect(SERVICE_SCHEMAS.windows.open.safeParse(['popup']).success).toBe(false)
  })
})
