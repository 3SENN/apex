/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, systemPreferences, type BrowserWindow } from 'electron'
import type { Services } from '@shared/services'
import { anthropicQuickClient, createQuickModel, type QuickClient, type QuickModel } from './agent/quick'
import type { CompanionStore } from './companions'
import type { EngineService } from './engines/service'
import { createPersonalContext, type PersonalAppContext, type GettingStartedSignal } from './features/personalRuntime'
import { createFloatManager } from './float'
import { currentLanguage, currentLocale, onLanguageChange, pseudoActive } from '@shared/i18n/core'
import { log } from './log'
import { notifications } from './notifications'
import type { SettingsStore } from './settings'
import type { ThemeController } from './theme'

// The speech, passwords, autofill, meetings and voice part of start-up:
// builds the `personal` fields of AppContext before the features start, and binds
// the floats to the validated services once they exist. The bootstrap
// spreads `context` into startFeatures' argument and calls
// bindServices(services) after the merge.

export interface PersonalWiringDeps {
  dataDir: string
  home: string
  settings: SettingsStore
  engines: EngineService
  theme: ThemeController
  companions: CompanionStore
  /** The focused (or first) browser window, for HUD placement. */
  apexWindow(): BrowserWindow | null
  smoke: boolean
  /** The offline Messages stand-in under APEX_SMOKE; QuickModel never reaches the network in smoke. */
  smokeClient: { client(apiKey: string | null): never } | null
  /** The getting-started automatic items; index.ts maps the signal to 'try-dictation'. */
  onSignal?(id: GettingStartedSignal): void
  /** The app's one QuickModel when the bootstrap built it earlier (createAppQuickModel); otherwise built here. */
  quick?: QuickModel
}

/** What the app's QuickModel needs: the person's engine choice, key and the other engines' quick calls. */
export type AppQuickDeps = Pick<PersonalWiringDeps, 'dataDir' | 'home' | 'settings' | 'engines' | 'smoke' | 'smokeClient'>

/**
 * The one engine-agnostic service for model calls outside chats. It runs
 * on the engine the person picked (falling back to another one they set up),
 * the offline smoke client under APEX_SMOKE, and never another engine in smoke.
 */
export function createAppQuickModel(deps: AppQuickDeps): QuickModel {
  return createQuickModel({
    engine: () => deps.settings.get().engine,
    apiKey: () => (deps.smoke ? 'smoke' : deps.settings.apiKey()),
    client: (apiKey): QuickClient => (deps.smokeClient ? (deps.smokeClient.client(apiKey) as unknown as QuickClient) : anthropicQuickClient(apiKey)),
    // Smoke never runs another engine; builds without them have none.
    others: deps.smoke ? {} : deps.engines.extras.quick,
  })
}

export interface PersonalWiring {
  context: PersonalAppContext
  /** Lets the floats call services through SERVICE_SCHEMAS; call once the services are merged. */
  bindServices(services: Services, schemas: Record<string, Record<string, { parse(v: unknown): unknown[] }>>): void
}

export function createPersonalWiring(deps: PersonalWiringDeps): PersonalWiring {
  let bound: { services: Services; schemas: Record<string, Record<string, { parse(v: unknown): unknown[] }>> } | null = null

  const float = createFloatManager({
    theme: () => deps.theme.state(),
    companion: () => deps.companions.active(),
    // Apex's own Reduce Motion, or the system's (macOS and Windows report it).
    reduceMotion: () => deps.settings.get().reduceMotion || systemReducesMotion(),
    // The floats speak the app language main applied, not Chromium's.
    language: () => ({ language: currentLanguage(), locale: currentLocale(), pseudo: pseudoActive() }),
    apexWindow: deps.apexWindow,
    smoke: deps.smoke,
    callService: async (service, method, args) => {
      if (!bound) throw new Error('Not available yet')
      const schema = Object.hasOwn(bound.schemas, service) && Object.hasOwn(bound.schemas[service] ?? {}, method) ? bound.schemas[service]?.[method] : undefined
      if (!schema) throw new Error(`Unknown service method ${service}.${method}.`)
      const impl = (bound.services as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[service]?.[method]
      if (!impl) throw new Error(`Not available yet: ${service}.${method}`)
      return impl(...schema.parse(args))
    },
  })
  float.start()
  deps.theme.on('changed', (theme) => float.setTheme(theme))
  deps.companions.on('changed', () => float.setCompanion(deps.companions.active()))
  onLanguageChange(() => float.setLanguage({ language: currentLanguage(), locale: currentLocale(), pseudo: pseudoActive() }))
  // Once, for the quit that goes ahead (CH-30 may hold one to ask first).
  const disposeFloat = (event: Electron.Event): void => {
    if (event.defaultPrevented) return
    app.off('before-quit', disposeFloat)
    float.dispose()
  }
  app.on('before-quit', disposeFloat)

  const quick = deps.quick ?? createAppQuickModel(deps)

  const context = createPersonalContext({
    float,
    quick,
    notify: (n) => {
      notifications.notify({ category: n.category, title: n.title, body: n.body ?? '', target: n.target })
    },
    onSignal: (id) => {
      log.info('getting-started', 'signal', { id })
      deps.onSignal?.(id)
    },
    smoke: deps.smoke,
  })

  return {
    context,
    bindServices: (services, schemas) => {
      bound = { services, schemas }
    },
  }
}

function systemReducesMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings?.().prefersReducedMotion === true
  } catch {
    return false
  }
}
