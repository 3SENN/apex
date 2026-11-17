/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExtraEngineId, ExtraEngineServices, ExtraEngineSettings, ExtraEngineStatus } from '@internal/engines/shared'
import type { EngineId, EngineSummary, ExternalTabs } from '@shared/engine'
import type { Effort } from '@shared/ipc'
import type { QuickEngine } from '../agent/quick'
import type { McpRoute } from '../mcp/server'
import type { AgentBackend } from './backend'

// Engines besides the API key (ST-58). Public builds have none: the API key
// is the conversation loop in agent/session.ts. A build with the private
// internal/ folder adds engines through `@internal/engines/main`
// (createExtraEngines; src/stubs/engines/main.ts is the empty one), and
// everything engine-specific stays behind this interface: their backends,
// their status, their quick calls, their service methods and their settings.

/** The settings the engines read. */
export type EngineSettings = {
  engine: EngineId
  externalAccess: boolean
  externalTabs: ExternalTabs
  /** The app's effort setting, for chats from before per-chat effort. */
  effort?: Effort
} & ExtraEngineSettings

export interface ExtraEnginesDeps {
  /** Apex's data folder. */
  dataDir: string
  home: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** process.resourcesPath when packaged, else null. */
  resourcesPath: string | null
  /** The checkout or app folder (appRoot()), for files a development or smoke run uses. */
  appRoot: string
  settings(): EngineSettings
  /** Saves the engines' own settings. */
  updateSettings(patch: Partial<ExtraEngineSettings>): void
  /** A companion's own folder. */
  folder(companionId: string): string
  /** Opens a file with its default app. */
  openPath(path: string): Promise<string>
  /** A file the person picks, or null when they cancel. */
  pickFile(options: { title: string; message: string; defaultPath: string }): Promise<string | null>
  /** Sends a chat's last message again (after an engine fixed what stopped it). */
  retry(chatId: string): void
  /** One chat's tools on Apex's local MCP server (started on demand): its URL and bearer token. */
  endpoint(chatId: string): Promise<{ url: string; token: string }>
  /** What an engine shows changed; the status is read again. */
  changed(): void
  /** The end-to-end check: never a real program. */
  smoke: boolean
}

export interface ExtraEngines {
  /** The engines offered besides the API key, in order (empty when none is built in). */
  readonly ids: readonly ExtraEngineId[]
  /** Each engine's chat backend. */
  readonly backends: Partial<Record<ExtraEngineId, AgentBackend>>
  /** Each engine's quick calls (QuickModel), when it can answer them. */
  readonly quick: Partial<Record<ExtraEngineId, QuickEngine>>
  /** The service namespaces the engines add (merged into the app's services). */
  readonly services: ExtraEngineServices
  /** The engines' own EngineStatus fields. */
  status(): ExtraEngineStatus
  /** Where each engine stands, in words every surface can show. */
  summaries(): EngineSummary[]
  /** Chats with a live engine process right now. */
  processes(): number
  /** A chat's route on the local MCP server, for the engine whose turn is running. */
  route(chatId: string): McpRoute | null
  settingsChanged(next: EngineSettings, previous: EngineSettings): void
  /**
   * A `claude` program the external MCP server's Add for me can run, with
   * the environment to run it in; null when the engines know none (the
   * server then looks for one itself).
   */
  claudeProgram?(): Promise<{ path: string; env: Record<string, string> } | null>
  start(): Promise<void>
  dispose(): Promise<void>
}

/** No engines besides the API key (the stubs, and builds that hide them). */
export function noExtraEngines(): ExtraEngines {
  return {
    ids: [],
    backends: {},
    quick: {},
    services: {} as ExtraEngineServices,
    status: () => ({}) as ExtraEngineStatus,
    summaries: () => [],
    processes: () => 0,
    route: () => null,
    settingsChanged: () => undefined,
    start: async () => undefined,
    dispose: async () => undefined,
  }
}
