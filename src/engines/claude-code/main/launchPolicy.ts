/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { MCP_SERVER_NAME } from '@shared/engine'
import type { Effort } from '@shared/ipc'
import type { ChatCapabilities, EngineSession } from '../../../../src/main/chats'
import type { ResolvedConnector } from '../../../../src/main/stores'
import { launchArgs, type LaunchOptions } from './process'

// What a chat may do on the Claude subscription engine, decided in one place from
// its fixed capabilities: the same switches as the API-key engine, written
// as `claude` flags. Pure: no files, no processes; the bridge passes in the
// folders it made and spawns what this returns.

/** Claude Code's built-in web tools, both on when the chat has web tools (as on the API key). */
export const WEB_BUILT_INS = ['WebSearch', 'WebFetch'] as const

/** Built-ins a Files and documents chat gets, confined to its own workspace folder. */
export const DOCUMENT_BUILT_INS = ['Bash', 'Read', 'Write', 'Edit', 'Skill'] as const

/**
 * Permission rules for those built-ins. Paths are relative to the working
 * directory, which is the chat's workspace (an absolute path could hold a
 * space, which the CLI would split on). Bash can't be scoped by a rule, so
 * it runs in Claude Code's sandbox (DOCUMENTS_SETTINGS), which only writes
 * inside the working directory and has no network.
 */
export const DOCUMENT_RULES = ['Bash', 'Read(./**)', 'Write(./**)', 'Edit(./**)', 'Skill'] as const

/** Claude Code settings for a documents chat (passed with --settings; the person's own settings stay out). */
export const DOCUMENTS_SETTINGS = {
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
} as const

/**
 * Where a declined or overloaded request goes, mirroring the API key's
 * server-side fallback (session.ts buildRequest): every model but Haiku
 * falls back, to Anthropic's recommended model or, for that model itself,
 * the next one. Claude Code refuses a fallback equal to the chat's model.
 */
export const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'] as const

export function fallbackModelFor(model: string): string | null {
  if (!model || model.startsWith('claude-haiku')) return null
  return FALLBACK_MODELS.find((candidate) => candidate !== model) ?? null
}

/** A tool's name inside Claude Code: mcp__<server>__<tool>, with the characters it doesn't keep replaced. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** Each connector's MCP server name in a chat's --mcp-config: lower-case, unique, never Atelier's own. */
export function connectorServerList(connectors: readonly ResolvedConnector[]): Array<[string, ResolvedConnector]> {
  const taken = new Set<string>([MCP_SERVER_NAME])
  const out: Array<[string, ResolvedConnector]> = []
  for (const connector of connectors) {
    const base = connector.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connector'
    let name = base === MCP_SERVER_NAME ? `${base}-connector` : base
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
    taken.add(name)
    out.push([name, connector])
  }
  return out
}

/** The remote connector tools the chat has off (frozen at its first message), as deny rules. */
export function offConnectorTools(caps: Pick<ChatCapabilities, 'toolPolicies'>, connectors: readonly ResolvedConnector[]): string[] {
  const out: string[] = []
  for (const [server, connector] of connectorServerList(connectors)) {
    const policies = caps.toolPolicies?.[connector.id] ?? {}
    for (const [tool, policy] of Object.entries(policies)) if (policy === 'off') out.push(mcpToolName(server, tool))
  }
  return [...new Set(out)].sort()
}

export interface LaunchPolicyInput {
  caps: ChatCapabilities
  /** App settings the chat falls back on (its effort when it has none of its own). */
  settings?: { effort?: Effort }
  /** The chat's fixed system prompt; the engine note is added after it. */
  system: string
  /** The generated --mcp-config file. */
  mcpConfigPath: string
  /** Atelier's tools for the chat, unqualified names are qualified here (mcp__atelier__…). */
  atelierTools: readonly string[]
  /** The chat's remote connectors, served by Claude Code as HTTP MCP servers. */
  connectors: readonly ResolvedConnector[]
  /** A stored Claude Code session to continue. */
  session: EngineSession | null
  /** The companion's folder: the working directory of an ordinary chat. */
  companionFolder: string
  /** The chat's Files and documents workspace (documentsWorkspace(chatId)), when it has one. */
  documentsFolder?: string | null
  /** Plugin folders for a documents chat (the document skills, documentsPluginDir()). */
  pluginDirs?: readonly string[]
  /** More folders a documents chat's file tools may use (the workspace itself is always added). */
  addDirs?: readonly string[]
  /** What a documents chat's prompt adds about its folder (documentsNote(workspace)). */
  documentsNote?: string
}

export interface LaunchPlan {
  args: string[]
  cwd: string
  /** The chat works in its documents workspace with the file and shell tools. */
  documents: boolean
  /** Claude Code keeps its own copy of the conversation (false for a private chat). */
  persist: boolean
  /** The model a declined request falls back to, or null. */
  fallbackModel: string | null
  /** Deny rules for the chat's connector tools that are off. */
  offTools: string[]
  options: LaunchOptions
}

/** The per-chat `claude` launch: arguments and working directory. */
export function launchPolicy(input: LaunchPolicyInput): LaunchPlan {
  const { caps } = input
  const documents = caps.documents === true && typeof input.documentsFolder === 'string' && input.documentsFolder.length > 0
  const persist = caps.private !== true
  const fallbackModel = fallbackModelFor(caps.model)
  const offTools = offConnectorTools(caps, input.connectors)
  const connectorRules = connectorServerList(input.connectors).map(([name]) => `mcp__${name}`)
  const atelier = input.atelierTools.map((name) => (name.startsWith('mcp__') ? name : `mcp__${MCP_SERVER_NAME}__${name}`))
  const options: LaunchOptions = {
    model: caps.model,
    effort: caps.effort ?? input.settings?.effort ?? 'high',
    mcpConfigPath: input.mcpConfigPath,
    appendSystemPrompt: `${input.system}${engineNote(caps.browser, caps.memory, caps.webTools, { documents })}${documents ? (input.documentsNote ?? '') : ''}`,
    allowedTools: [...atelier, ...connectorRules],
    webSearch: caps.webTools,
    webFetch: caps.webTools,
    builtInTools: documents ? [...DOCUMENT_BUILT_INS] : [],
    builtInRules: documents ? [...DOCUMENT_RULES] : [],
    disallowedTools: offTools,
    fallbackModel,
    persistSession: persist,
    addDirs: documents ? [...new Set([input.documentsFolder as string, ...(input.addDirs ?? [])])] : [],
    pluginDirs: documents ? [...(input.pluginDirs ?? [])] : [],
    settings: documents ? JSON.stringify(DOCUMENTS_SETTINGS) : null,
    // A private chat has no stored conversation to go back to.
    resume: persist ? (input.session?.id ?? null) : null,
    fork: persist && input.session?.fork === true,
  }
  return {
    args: launchArgs(options),
    cwd: documents ? (input.documentsFolder as string) : input.companionFolder,
    documents,
    persist,
    fallbackModel,
    offTools,
    options,
  }
}

/**
 * Claude Code's own prompt is about code. This tells the model what it has
 * here, so it never offers file edits or commands it can't run (or, in a
 * documents chat, works only in its own folder).
 */
export function engineNote(browser: boolean, memory: boolean, web: boolean, extra: { documents?: boolean } = {}): string {
  const tools = [browser ? 'the browser tools' : '', memory ? 'memory' : '', web ? 'web search and reading web pages' : '', extra.documents ? 'a private workspace folder for files and code' : ''].filter(Boolean)
  const list = tools.length > 0 ? `Your tools are ${tools.join(', ').replace(/, ([^,]*)$/, ' and $1')} (${BRAND_NAME}'s tools are named mcp__atelier__…).` : 'You have no tools in this chat.'
  const scope = extra.documents
    ? "Your working directory is this chat's private workspace folder. Read, write and run code only inside it; never touch files outside it."
    : "You have no access to files, a terminal or code here: don't offer to edit files or run commands."
  return `

This chat runs through Claude Code on the user's computer, inside ${BRAND_NAME}. ${list} ${scope}`
}
