/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for the engines that power companions (ST-58 to ST-60). Every
// build runs chats on your Anthropic API key or on your Claude subscription
// (`@engines/shared`, src/engines). Atelier has no plans, credits or quotas: where other apps show those,
// Atelier shows this status.
import { EXTRA_ENGINE_IDS, EXTRA_ENGINE_LABELS, type ExtraEngineStatus } from '@engines/shared'

export const ENGINES = ['api-key', ...EXTRA_ENGINE_IDS] as const
export type EngineId = (typeof ENGINES)[number]

/** Each engine's name. An added engine's may be a getter that reads the app language, so it is copied as one. */
export const ENGINE_LABELS: Record<EngineId, string> = Object.defineProperties({ 'api-key': 'Anthropic API key' } as Record<EngineId, string>, Object.getOwnPropertyDescriptors(EXTRA_ENGINE_LABELS))

/** The name Atelier's tools go by for an MCP client; tool names become mcp__atelier__<tool>. */
export const MCP_SERVER_NAME = 'atelier'

/** Where an engine besides the API key stands, in words every surface can show. */
export interface EngineSummary {
  id: EngineId
  /** A chat on it can run now. */
  ready: boolean
  /** A look-up is running. */
  checking: boolean
  /** One plain sentence about where it stands. */
  detail: string
  /** A short status for a badge ('Ready', 'Not signed in'). */
  badge: string
  /** The badge's tone. */
  tone: 'neutral' | 'success' | 'warning' | 'info'
}

/** ST-60: which tabs an MCP client outside Atelier (Claude Code in a terminal, say) may drive. */
export type ExternalTabs = 'own' | 'any'

export interface ExternalAccessStatus {
  enabled: boolean
  /** The local address the client connects to; null until Atelier listens. */
  url: string | null
  /** The command that adds Atelier to Claude Code, with the secret masked. Copy it with engine.copyCommand. */
  command: string | null
  tabs: ExternalTabs
  /** Whether the current command was added through Atelier (and still matches the secret and port). */
  added: boolean
  /** Tabs it controls right now. */
  activeTabs: number
  lastUsedAt: number | null
  /** Why it couldn't be turned on (for example, no secure storage for its secret). */
  problem: string | null
}

export interface EngineStatus extends ExtraEngineStatus {
  /** The engine new chats use. */
  engine: EngineId
  /** The engines this build offers, the API key first. */
  engines: EngineId[]
  apiKey: { state: 'saved' | 'environment' | 'missing' }
  /** Every engine besides the API key, with where it stands. */
  others: EngineSummary[]
  external: ExternalAccessStatus
  /** Chats with a live engine process right now. */
  processes: number
}

/** Whether a chat on `engine` can run as things stand. */
export function engineReady(status: EngineStatus, engine: EngineId): boolean {
  if (engine === 'api-key') return status.apiKey.state !== 'missing'
  const id: string = engine
  return status.others.some((other) => other.id === id && other.ready)
}

/** Whether this build offers more than the API key, so there is an engine to choose. */
export function hasEngineChoice(status: Pick<EngineStatus, 'engines'>): boolean {
  return status.engines.length > 1
}

export function isEngine(value: unknown): value is EngineId {
  return ENGINES.some((e) => e === value)
}

/**
 * Whether a chat on `engine` brings its own sign-in, so it sends without an
 * API key and reports a missing install or sign-in in the chat. Pass the
 * chat's setup engine (a draft's shows what its first message would use).
 */
export function engineHasOwnAccount(engine: string | undefined): boolean {
  return engine !== undefined && engine !== 'api-key'
}
