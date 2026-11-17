/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ConnectorTool, LocalToolSnapshot, ToolPolicy } from '@shared/connectors'

// Main's ConnectorRuntime, for the intake (# records) and the
// agent turn (mcp_servers and local tools). The real one is built in
// src/main/connectors.

/** A remote connector as Anthropic's MCP connector needs it, with a fresh token. */
export interface ResolvedConnector {
  connectorId: string
  /** The mcp_servers name; unique per request. */
  serverName: string
  url: string
  authorizationToken: string | null
  /** Tools that were off when the chat started: mcp_toolset configs disable them. */
  disabledTools: string[]
}

export type InputValidation = { ok: true } | { ok: false; errors: { path: string; message: string }[] }

export interface ConnectorRuntime {
  resolveServer(ids: readonly string[]): ResolvedConnector[]
  localTools(ids: readonly string[]): LocalToolSnapshot[]
  callLocal(connectorId: string, toolName: string, input: unknown, signal: AbortSignal): Promise<{ content: BetaToolResultBlockParam['content']; isError: boolean }>
  /** The policy right now; `off` refuses a local call even in a chat that started with it on. */
  livePolicy(connectorId: string, toolName: string): ToolPolicy
  /** Checks an edited approval form against the tool's input schema (ajv). */
  validateInput(connectorId: string, toolName: string, input: unknown): InputValidation
  readRecord(connectorId: string, uri: string): Promise<{ title: string; text: string }>
  /** A connector an app names (docs/apps.md › Apps for organisations): by its directory entry or its server name, the default one first. */
  forApp?(ref: string): { id: string; name: string; enabled: boolean; tools: ConnectorTool[] } | null
  /** Runs one tool of any connector for an app, remote or local, as the person set it: off refuses, a local server needs its approval. */
  callForApp?(connectorId: string, toolName: string, input: unknown, signal: AbortSignal): Promise<{ content: BetaToolResultBlockParam['content']; isError: boolean; structured: unknown }>
}
