/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session } from 'electron'
import type { Services } from '@shared/services'
import { log } from '../log'
import type { Tab } from '../tabs'
import { addressFeature } from './address'
import { chatFeature } from './chat'
import { coreFeature } from './core'
import { menusFeature } from './menus'
import { settingsFeature } from './settings'
import { sitesFeature } from './sites'
import { tabsFeature } from './tabs'
import type { AppContext, Feature, ServiceParts, SessionInfo, WindowContext } from './types'
import { autofillFeature } from './autofill'
import { meetingCaptureFeature } from './meetingCapture'
import { meetingsLibraryFeature } from './meetingsLibrary'
import { passwordsFeature } from './passwords'
import { speechFeature } from './speech'
import { voiceFeature } from './voice'
import { createRichChatFeature } from './richChat'
import { createConnectorsFeature } from './connectors'
import { createExtensionsFeature } from './extensions'
import { createFilesFeature } from './files'
import { createIntakeFeature } from './intake'
import { createProfilesFeature } from './profiles'
import { createWebAppsFeature } from './webApps'
// The later feature factories; the modules are named agentTools … firstRun
import { createMemoryFeatures } from '../activity/feature'
import { createAgentFeatures } from '../agent/feature'
import { createPlatformFeatures } from '../apps/feature'
import { createChatFeatures } from '../chatFeatures'
import { createFirstRunFeatures } from '../guides/feature'
import { createSkillRoutineFeatures } from '../routines/feature'
import { createWorkspaceFeatures } from '../workspace/feature'
import { diagnosticsFeature } from './diagnostics'
import { i18nFeature } from './i18n'
import { migrationsFeature } from './migrations'
import { nativeFeature } from './native'
import { systemFeature } from './system'
import { updatesFeature } from './updates'
import { createSignInCompatFeature } from './signInCompat'
// HTTPS-First, cookie banners, the site info summary
import { createPrivacyPackFeature } from '../privacy/feature'
// MD-01
import { mediaFeature } from '../media/feature'
// TWK-01
import { createTweaksFeature } from '../tweaks/feature'
// RD-01
import { createReaderFeature } from '../reader/feature'
// TR-01
import { createTranslateFeature } from '../translate/feature'
import { createDecisionsFeature } from '../decisions/feature' // quick decisions (docs/decisions.md)
// Docs/packs.md
import { createPacksFeature } from '../packs/feature'
// Settings › Privacy › Permissions
import { createSystemPermissionsFeature } from '../systemPermissions'

// Main-process wiring as a list of feature modules. The seven core features
// come first, in this order; the rest follow in dependency order.
export const FEATURES: Feature[] = [
  coreFeature,
  addressFeature,
  tabsFeature,
  sitesFeature,
  menusFeature,
  chatFeature,
  settingsFeature,
  // In order: each fills its ctx.personal slots for the ones after it
  speechFeature,
  passwordsFeature,
  autofillFeature,
  meetingsLibraryFeature,
  meetingCaptureFeature,
  voiceFeature,
  // In order: profiles fills ctx.content.profiles before the rest ask for sessions
  createProfilesFeature(),
  createIntakeFeature(),
  createFilesFeature(),
  createConnectorsFeature(),
  createRichChatFeature(),
  createExtensionsFeature(),
  // In order: agentTools, workspace, skillsRoutines, memory, chatTools, platform, firstRun
  createAgentFeatures(),
  createWorkspaceFeatures(),
  createSkillRoutineFeatures(),
  createMemoryFeatures(),
  createChatFeatures(),
  createPlatformFeatures(),
  createFirstRunFeatures(),
  diagnosticsFeature,
  migrationsFeature,
  updatesFeature,
  systemFeature,
  nativeFeature,
  i18nFeature,
  // ── sign-in compatibility feature ── (Touch ID passkeys when entitled, the passkey account chooser, the Storage Access API)
  createSignInCompatFeature(),
  // ── privacy pack feature ── (HTTPS-First, hidden cookie banners and their lists, the per-site privacy summary)
  createPrivacyPackFeature(),
  // ── media hub feature ── (MD-01 to MD-04: now playing, speed, the page menu on media)
  mediaFeature,
  // ── tweaks feature ── (TWK-01 to TWK-06: hidden elements, style, custom CSS and scripts per site)
  createTweaksFeature(),
  // ── reader feature ── (RD-01 to RD-04: the reader view, its command and its text size keys)
  createReaderFeature(),
  // ── translate feature ── (TR-01 to TR-12: page translation, on this Mac first, the companion when allowed)
  createTranslateFeature(),
  // ── system permissions feature ── (this Mac's permissions in one report; asks only after a click on Allow)
  createSystemPermissionsFeature(),
  // ── quick decisions feature ── (DC-01 to DC-12: an optional decision model next to Apex's own rules)
  createDecisionsFeature(),
  // ── packs feature ── (docs/packs.md: installed packs, their sandbox and bridge, the builder tools; after tweaks and skills, whose stores it feeds)
  createPacksFeature(),
  // ── web apps feature ── (WA-01: websites saved as apps, listed in Workspace › Apps and the command bar)
  createWebAppsFeature(),
]

/**
 * Merges service parts method by method into one Services object: the core
 * namespaces from index.ts first, then every feature's. A later part wins for
 * the same method, so a feature's real method replaces its stub.
 */
export function mergeServices(...parts: (ServiceParts | void)[]): Services {
  const merged: Record<string, Record<string, unknown>> = {}
  for (const part of parts) {
    if (!part) continue
    for (const [ns, methods] of Object.entries(part)) {
      if (methods) merged[ns] = { ...merged[ns], ...(methods as Record<string, unknown>) }
    }
  }
  return merged as unknown as Services
}

/** Service methods with a schema that nothing implements; start-up logs them so a missing feature is loud. */
export function missingMethods(services: Services, schemas: Record<string, Record<string, unknown>>): string[] {
  const impl = services as unknown as Record<string, Record<string, unknown> | undefined>
  const missing: string[] = []
  for (const [ns, methods] of Object.entries(schemas)) {
    for (const method of Object.keys(methods)) if (typeof impl[ns]?.[method] !== 'function') missing.push(`${ns}.${method}`)
  }
  return missing
}

export interface StartedFeatures {
  /** Every feature's app-wide parts, merged. */
  services: ServiceParts
  /** Runs every feature's session installer on a new session (private windows, profiles). */
  installSession(session: Session, info: SessionInfo): void
  /** Wires a new window: its services and the per-tab hooks. */
  addWindow(win: WindowContext): ServiceParts
  dispose(): Promise<void>
}

// Namespaces merge method by method, so one feature can add to another's namespace.
function merge(into: Record<string, Record<string, unknown>>, part: ServiceParts | void, feature: string): void {
  if (!part) return
  for (const [ns, methods] of Object.entries(part)) {
    if (!methods) continue
    into[ns] = { ...into[ns], ...(methods as Record<string, unknown>) }
    log.debug('features', `${feature} provides ${ns}`)
  }
}

function runTabHooks(features: readonly Feature[], tab: Tab, win: WindowContext, cleanups: Map<string, (() => void)[]>): void {
  const done: (() => void)[] = []
  for (const f of features) {
    try {
      const cleanup = f.tab?.(tab, win)
      if (cleanup) done.push(cleanup)
    } catch (err) {
      log.error('features', `${f.name} tab hook failed`, { error: err instanceof Error ? err.message : String(err) })
    }
  }
  cleanups.set(tab.id, done)
}

export function startFeatures(app: AppContext, features: readonly Feature[] = FEATURES): StartedFeatures {
  const merged: Record<string, Record<string, unknown>> = {}
  for (const f of features) merge(merged, f.app?.(app), f.name)
  const sessions = new WeakSet<Session>()

  const installSession = (session: Session, info: SessionInfo): void => {
    if (sessions.has(session)) return
    sessions.add(session)
    for (const f of features) {
      try {
        f.session?.(session, info)
      } catch (err) {
        log.error('features', `${f.name} session installer failed`, { error: err instanceof Error ? err.message : String(err), partition: info.partition })
      }
    }
  }

  const addWindow = (win: WindowContext): ServiceParts => {
    const scoped: Record<string, Record<string, unknown>> = {}
    for (const f of features) merge(scoped, f.window?.(win), f.name)
    const cleanups = new Map<string, (() => void)[]>()
    for (const tab of win.tabs.all()) runTabHooks(features, tab, win, cleanups)
    win.tabs.on('created', (tab) => runTabHooks(features, tab, win, cleanups))
    win.tabs.on('closed', (tab) => {
      for (const fn of cleanups.get(tab.id) ?? []) fn()
      cleanups.delete(tab.id)
    })
    return scoped as ServiceParts
  }

  return {
    services: merged as ServiceParts,
    installSession,
    addWindow,
    async dispose() {
      for (const f of features) {
        try {
          await f.dispose?.()
        } catch (err) {
          log.error('features', `${f.name} dispose failed`, { error: err instanceof Error ? err.message : String(err) })
        }
      }
    },
  }
}
