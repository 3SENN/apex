/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chat file format's newer fields: the summary fields for private
// chats, delegation, projects, imports and routine runs, the capabilities
// frozen at the first message (client tools, private), and remembered
// approvals. chats.ts calls these from its load path; the data migrations
// turn them into versioned steps.
import { ACTION_KINDS, type ActionKind, type ChatGrant, type DelegationStatus } from '@shared/agentTools'
import { CHAT_SUMMARY_LINK_DEFAULTS, type ChatSummary } from '@shared/chats'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const DELEGATION: readonly DelegationStatus[] = ['working', 'done', 'needs-attention', 'needs-input', 'stopped', 'interrupted']
const IMPORT_SOURCES = ['chatgpt', 'claude', 'atelier'] as const
const TRIGGERS = ['schedule', 'manual', 'catch-up'] as const

type SummaryLinks = Pick<ChatSummary, keyof typeof CHAT_SUMMARY_LINK_DEFAULTS>

/** The newer summary fields from a saved record; older records get false and nulls. */
export function normalizeSummaryLinks(raw: Record<string, unknown>): SummaryLinks {
  const imported = isObject(raw.imported) && IMPORT_SOURCES.includes(raw.imported.source as never) && str(raw.imported.originalTitle) && num(raw.imported.importedAt)
    ? {
        source: raw.imported.source as (typeof IMPORT_SOURCES)[number],
        originalTitle: raw.imported.originalTitle,
        originalCreatedAt: num(raw.imported.originalCreatedAt) ? raw.imported.originalCreatedAt : null,
        importedAt: raw.imported.importedAt,
      }
    : null
  const run = raw.routineRun
  const routineRun = isObject(run) && str(run.runId) && num(run.scheduledFor) && TRIGGERS.includes(run.trigger as never)
    ? { runId: run.runId, scheduledFor: run.scheduledFor, trigger: run.trigger as (typeof TRIGGERS)[number] }
    : null
  return {
    ...CHAT_SUMMARY_LINK_DEFAULTS,
    private: raw.private === true,
    parentChatId: str(raw.parentChatId) ? raw.parentChatId : null,
    // Nothing runs after a restart: a sub-task that was working is interrupted, and chats.continue resumes it.
    delegationStatus: raw.delegationStatus === 'working' ? 'interrupted' : (DELEGATION.find((s) => s === raw.delegationStatus) ?? null),
    projectId: str(raw.projectId) ? raw.projectId : null,
    imported,
    routineRun,
  }
}

/** The newer ChatCapabilities fields, frozen at the first message. */
export interface AgentToolsCapabilities {
  clientTools: string[]
  private: boolean
}

export const AGENT_TOOLS_CAPABILITY_DEFAULTS: Readonly<AgentToolsCapabilities> = { clientTools: [], private: false }

/** The newer capability fields; older chats have no client tools and are not private. */
export function normalizeAgentToolsCapabilities(raw: Record<string, unknown>): AgentToolsCapabilities {
  return {
    clientTools: Array.isArray(raw.clientTools) ? raw.clientTools.filter(str).slice(0, 200) : [],
    private: raw.private === true,
  }
}

/** Remembered approvals (scope 'chat'); malformed entries are dropped. */
export function normalizeGrants(raw: unknown): ChatGrant[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((g) =>
    isObject(g) && str(g.origin) && ACTION_KINDS.includes(g.action as ActionKind) && num(g.at)
      ? [{ origin: g.origin, action: g.action as ActionKind, at: g.at }]
      : [],
  )
}
