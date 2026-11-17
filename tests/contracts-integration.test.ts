/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { FLOAT } from '@shared/float'
import { PAGE, UI, type AgentEvent } from '@shared/ipc'
import type { AppEvent } from '@shared/services'
import type { LogItem } from '../src/renderer/src/agentLog'
import { SURFACE_IDS } from '@shared/overlay'
import { MENU_ONLY_COMMANDS, SHORTCUTS } from '@shared/shortcuts'
import { DESTINATIONS, SETTINGS_PAGES } from '@shared/url'
import { PRIVILEGED_SCHEMES } from '../src/main/appProtocol'
import { FEATURES } from '../src/main/features'
import { SERVICE_SCHEMAS } from '../src/main/services'
import { normalizeAccelerator } from '../src/main/shortcuts'
// Every whole-namespace schema map spread into SERVICE_SCHEMAS.
import { ADDRESS_SCHEMAS } from '../src/main/schemas/address'
import { CHAT_SCHEMAS } from '../src/main/schemas/chat'
import { CORE_SCHEMAS } from '../src/main/schemas/core'
import { MENU_SCHEMAS } from '../src/main/schemas/menus'
import { SETTINGS_SCHEMAS } from '../src/main/schemas/settings'
import { SITE_SCHEMAS } from '../src/main/schemas/sites'
import { TAB_SCHEMAS } from '../src/main/schemas/tabs'
import { AUTOFILL_SCHEMAS } from '../src/main/autofill/schemas'
import { MEETING_CAPTURE_SCHEMAS } from '../src/main/meetings/capture/schemas'
import { MEETINGS_SCHEMAS } from '../src/main/meetings/schemas'
import { PASSWORDS_SCHEMAS } from '../src/main/passwords/schemas'
import { SPEECH_SCHEMAS } from '../src/main/speech/schemas'
import { VOICE_SCHEMAS } from '../src/main/voice/schemas'
import { EXTENSIONS_SCHEMAS } from '../src/main/extensions/schemas'
import { FILES_SCHEMAS } from '../src/main/files/schemas'
import { INTAKE_SCHEMAS } from '../src/main/intake/schemas'
import { PROFILES_SCHEMAS } from '../src/main/profiles/schemas'
import { MEMORY_UPKEEP_SCHEMAS } from '../src/main/activity/schemas'
import { AGENT_TOOLS_SCHEMAS } from '../src/main/agent/agentToolsSchemas'
import { PLATFORM_SCHEMAS } from '../src/main/apps/schemas'
import { CHAT_TOOLS_SCHEMAS } from '../src/main/chatFeatures'
import { FIRST_RUN_SCHEMAS } from '../src/main/guides/schemas'
import { WORKSPACE_SCHEMAS } from '../src/main/workspace/schemas'
import { DIAGNOSTICS_SCHEMAS } from '../src/main/diagnostics/schemas'
import { MIGRATIONS_SCHEMAS } from '../src/main/migrations/schemas'
import { NATIVE_SCHEMAS } from '../src/main/native/schemas'
import { SYSTEM_SCHEMAS } from '../src/main/system/schemas'
import { UPDATES_SCHEMAS } from '../src/main/updates/schemas'

// A guard over the contract sets: a spread map or list that names
// something twice silently drops one part, so every id that two feature
// sets could both claim must be unique.

const dupes = (values: readonly string[]): string[] => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))]

const SPREAD_MAPS: Record<string, Record<string, unknown>> = {
  CORE_SCHEMAS, ADDRESS_SCHEMAS, TAB_SCHEMAS, SITE_SCHEMAS, MENU_SCHEMAS, CHAT_SCHEMAS, SETTINGS_SCHEMAS,
  SPEECH_SCHEMAS, PASSWORDS_SCHEMAS, AUTOFILL_SCHEMAS, VOICE_SCHEMAS, MEETINGS_SCHEMAS, MEETING_CAPTURE_SCHEMAS,
  INTAKE_SCHEMAS, FILES_SCHEMAS, EXTENSIONS_SCHEMAS, PROFILES_SCHEMAS,
  AGENT_TOOLS_SCHEMAS, CHAT_TOOLS_SCHEMAS, MEMORY_UPKEEP_SCHEMAS, WORKSPACE_SCHEMAS, PLATFORM_SCHEMAS, FIRST_RUN_SCHEMAS,
  UPDATES_SCHEMAS, DIAGNOSTICS_SCHEMAS, MIGRATIONS_SCHEMAS, SYSTEM_SCHEMAS, NATIVE_SCHEMAS,
}

describe('contracts across features', () => {
  it('gives each service namespace to one schema map', () => {
    const owners = new Map<string, string[]>()
    for (const [map, namespaces] of Object.entries(SPREAD_MAPS)) {
      for (const ns of Object.keys(namespaces)) owners.set(ns, [...(owners.get(ns) ?? []), map])
    }
    // The agent namespace is shared on purpose: its later methods are merged in explicitly.
    const shared = [...owners].filter(([ns, maps]) => maps.length > 1 && ns !== 'agent').map(([ns, maps]) => `${ns}: ${maps.join(', ')}`)
    expect(shared).toEqual([])
    const all = SERVICE_SCHEMAS as unknown as Record<string, Record<string, unknown>>
    for (const [map, namespaces] of Object.entries(SPREAD_MAPS)) {
      for (const [ns, methods] of Object.entries(namespaces as Record<string, Record<string, unknown>>)) {
        for (const method of Object.keys(methods)) expect(all[ns]?.[method], `${map} ${ns}.${method} survives the spread`).toBe(methods[method])
      }
    }
  })

  it('has unique surface ids, features, schemes, settings pages and destinations', () => {
    expect(dupes(SURFACE_IDS)).toEqual([])
    expect(dupes(FEATURES.map((f) => f.name))).toEqual([])
    expect(dupes(PRIVILEGED_SCHEMES.map((s) => s.scheme))).toEqual([])
    expect(dupes(SETTINGS_PAGES.map((p) => p.id))).toEqual([])
    expect(dupes(DESTINATIONS)).toEqual([])
  })

  it('has one IPC channel per name', () => {
    const channels: string[] = [...Object.values(UI), ...Object.values(PAGE), ...Object.values(FLOAT)]
    expect(dupes(channels)).toEqual([])
  })

  it('has unique shortcut ids, commands and chords on each platform', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(dupes(ids)).toEqual([])
    expect(dupes(MENU_ONLY_COMMANDS)).toEqual([])
    expect(MENU_ONLY_COMMANDS.filter((c) => (ids as readonly string[]).includes(c))).toEqual([])
    for (const platform of ['darwin', 'win32', 'linux']) {
      const chords = SHORTCUTS.filter((s) => !s.accelerator.startsWith('Hold+')).map((s) => `${normalizeAccelerator(s.accelerator, platform)}`)
      const clashes = dupes(chords).map((c) => `${c}: ${SHORTCUTS.filter((s) => !s.accelerator.startsWith('Hold+') && normalizeAccelerator(s.accelerator, platform) === c).map((s) => s.id).join(', ')}`)
      expect(clashes, platform).toEqual([])
    }
  })
})

// Type-level: a discriminant claimed by two union members (two features adding
// the same event type or log kind) makes the narrowed type a union, which
// these assignments reject, naming the shared literal in the error.
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never
type Shared<E, K extends keyof E> = { [V in E[K] & string]: IsUnion<Extract<E, Record<K, V>>> extends false ? never : V }[E[K] & string]
const appEventTypesOnce: [Shared<AppEvent, 'type'>] extends [never] ? true : Shared<AppEvent, 'type'> = true
const agentEventTypesOnce: [Shared<AgentEvent, 'type'>] extends [never] ? true : Shared<AgentEvent, 'type'> = true
const logItemKindsOnce: [Shared<LogItem, 'kind'>] extends [never] ? true : Shared<LogItem, 'kind'> = true

describe('event unions', () => {
  it('give each event type and log kind to one member', () => {
    expect([appEventTypesOnce, agentEventTypesOnce, logItemKindsOnce]).toEqual([true, true, true])
  })
})
