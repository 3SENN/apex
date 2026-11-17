/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BrowserWindow, Session, WebContents } from 'electron'
import type { AppEvent, ServiceName, Services } from '@shared/services'
import type { WindowKind } from '@shared/windows'
import type { AgentHost } from '../agent/host'
import type { CommandRegistry } from '../commands'
import type { OverlayHost } from '../overlayHost'
import type { PeekManager } from '../peek'
import type { SettingsStore } from '../settings'
import type { TabRegistry } from '../tabRegistry'
import type { Tab, TabManager } from '../tabs'
import type { ChromeWindow } from '../window'
import type { WindowManager } from '../windows'

// Feature modules. Main-process wiring is a list of features in
// features/index.ts; new features append themselves there instead of adding
// setup calls to index.ts.

export interface AppContext {
  dataDir: string
  settings: SettingsStore
  agent: AgentHost
  windows: WindowManager
  tabsRegistry: TabRegistry
  commands: CommandRegistry
  broadcast(event: AppEvent): void
  // Built by createPersonalContext in ./personalRuntime; the speech, passwords, autofill, meetings and voice features fill `personal`
  float: import('./personalRuntime').PersonalAppContext['float']
  quick: import('./personalRuntime').PersonalAppContext['quick']
  notify: import('./personalRuntime').PersonalAppContext['notify']
  signal: import('./personalRuntime').PersonalAppContext['signal']
  smoke: boolean
  personal: import('./personalRuntime').PersonalRuntime
  // Slots filled by the feature modules in ./contentRuntime
  content: import('./contentRuntime').ContentRuntime
 intakeHosts?: { bridge: import('../pageBridge').PageBridge; skills: import('../stores').SkillStore }
 memoryDeps?: import('../activity/deps').MemoryFeatureDeps
 workspaceStores?: import('../workspace/service').WorkspaceStores
 skillRoutines?: import('../routines/runtime').SkillRoutineRuntime
 firstRunDeps?: import('../guides/deps').FirstRunDeps
  // Built by createMaintenanceRuntime in ./maintenanceRuntime; its features fill the service slots
  maintenance: import('./maintenanceRuntime').MaintenanceRuntime
  /** The live engine status (the API key, and any other engine set up and signed in), for features that check readiness. */
  engineStatus?: () => import('@shared/engine').EngineStatus
}

export interface WindowContext {
  id: number
  kind: WindowKind
  window: BrowserWindow
  chrome: WebContents
  tabs: TabManager
  peek: PeekManager
  overlay: OverlayHost
  chromeWindow: ChromeWindow
  session: Session
  send(event: AppEvent): void
}

/**
 * What a feature provides: whole namespaces, or methods added to another
 * feature's namespace. startFeatures merges them method by method (a plain
 * Partial<Services> works; this one-level-deeper partial accepts that too).
 */
export type ServiceParts = { [S in ServiceName]?: Partial<Services[S]> }

export interface SessionInfo {
  private: boolean
  partition: string
}

export interface Feature {
  /** A reserves 'core' | 'address' | 'tabs' | 'sites' | 'menus' | 'chat' | 'settings'. */
  name: string
  /** Once at start-up; app-wide service objects. */
  app?(app: AppContext): ServiceParts | void
  /** Per window; window-scoped service objects. */
  window?(win: WindowContext): ServiceParts | void
  /** On every session: the default web session, each private window's, and (from C) each profile's. */
  session?(session: Session, info: SessionInfo): void
  /** Per tab; the returned function runs when the tab closes. */
  tab?(tab: Tab, win: WindowContext): (() => void) | void
  /** On before-quit. */
  dispose?(): void | Promise<void>
}
