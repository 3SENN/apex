/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentEvent, Effort, ToolKind } from '@shared/ipc'
import { normalizeRichChatCapabilities, normalizeAttachmentLog } from '../agent/chatFormatRichChat'
import { normalizeAgentToolsCapabilities, normalizeGrants, normalizeSummaryLinks } from '../agent/chatFormatAgentTools'

// The versioned chat steps (SS-09): one pure step per chat format version,
// from v0 (no formatVersion) to CHAT_FORMAT_VERSION.
// A step takes the raw file record (summary copy plus content) and returns a
// new one; it never mutates its input. Every step so far only fills defaults
// and drops what can't be read, so it is idempotent: running it on a file
// that already has its fields changes nothing.

export type RawChat = Record<string, unknown>

export interface ChatStep {
  from: number
  to: number
  /** What the step brings in, for logs and tests. */
  name: string
  up(raw: RawChat): RawChat
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TOOL_KINDS: readonly ToolKind[] = ['read-page', 'find', 'screenshot', 'click', 'type', 'navigate', 'tabs', 'web-search', 'web-fetch', 'memory', 'connector', 'other']
const TOOL_STATES = ['running', 'done', 'error'] as const
/** Tool summaries are capped at 2 KB. */
const TOOL_SUMMARY_MAX = 2048

const capsOf = (raw: RawChat): Record<string, unknown> => (isObject(raw.capabilities) ? raw.capabilities : {})
const logOf = (raw: RawChat): unknown[] => (Array.isArray(raw.log) ? raw.log : [])
const objectsOnly = (v: unknown): Record<string, unknown> => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, entry]) => isObject(entry))) : {})

/**
 * The original events the chat surfaces fold, with the fields they read. An event
 * missing one of them would break the fold, so it is dropped; types this
 * table doesn't name (later formats, newer builds) pass through.
 */
const A0_EVENT_FIELDS: Record<string, Array<[string, 'string' | 'boolean']>> = {
  'user-message': [['id', 'string'], ['text', 'string']],
  'text-delta': [['turnId', 'string'], ['text', 'string']],
  'thinking-delta': [['turnId', 'string'], ['text', 'string']],
  tool: [['id', 'string'], ['label', 'string']],
  approval: [['approvalId', 'string'], ['description', 'string']],
  'approval-resolved': [['approvalId', 'string'], ['allowed', 'boolean']],
  error: [['message', 'string']],
}

function validEvent(event: unknown): event is Record<string, unknown> & { type: string } {
  if (!isObject(event) || !str(event.type) || !event.type) return false
  const fields = A0_EVENT_FIELDS[event.type]
  return !fields || fields.every(([key, kind]) => typeof event[key] === kind)
}

/** v0 → v1: the original shape, normalized. */
function toV1(raw: RawChat): RawChat {
  const caps = capsOf(raw)
  const capabilities: Record<string, unknown> = {
    ...caps,
    model: str(caps.model) ? caps.model : str(raw.model) ? raw.model : '',
    browser: caps.browser === true,
    webTools: caps.webTools === true,
    memory: caps.memory === true,
    connectorIds: Array.isArray(caps.connectorIds) ? caps.connectorIds.filter(str) : [],
    // Chats from before engines ran on the API key (ST-58). Any engine's id is kept, whether or not this build offers it.
    engine: typeof caps.engine === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(caps.engine) ? caps.engine : 'api-key',
  }
  // Absent effort follows the global setting; absent memoryScope is the shared folder.
  if (!EFFORTS.includes(caps.effort as Effort)) delete capabilities.effort
  if (caps.memoryScope !== 'companion') delete capabilities.memoryScope
  const log = logOf(raw).filter(validEvent).map((event) => (event.type === 'tool' && !TOOL_STATES.includes(event.state as never) ? { ...event, state: 'done' } : event))
  return {
    ...raw,
    capabilities,
    system: str(raw.system) ? raw.system : '',
    log,
    details: objectsOnly(raw.details),
    feedback: objectsOnly(raw.feedback),
    formatVersion: 1,
  }
}

/** v1 → v2: summary flags and tool event fields. */
function toV2(raw: RawChat): RawChat {
  const log = logOf(raw).map((event) => {
    if (!isObject(event) || event.type !== 'tool') return event
    const next: Record<string, unknown> = { ...event, kind: TOOL_KINDS.includes(event.kind as ToolKind) ? event.kind : 'other' }
    // Times and summaries older emitters never wrote stay absent.
    for (const key of ['startedAt', 'endedAt']) if (!num(next[key])) delete next[key]
    for (const key of ['input', 'result']) {
      if (!str(next[key])) delete next[key]
      else next[key] = (next[key] as string).slice(0, TOOL_SUMMARY_MAX)
    }
    const connector = next.connector
    if (!isObject(connector) || !str(connector.id) || !str(connector.name)) delete next.connector
    return next
  })
  return { ...raw, actWithoutAsking: raw.actWithoutAsking === true, muted: raw.muted === true, log, formatVersion: 2 }
}

/** v2 → v3: `user-message.attachments`: a list of objects, or absent. */
function toV3(raw: RawChat): RawChat {
  const log = logOf(raw).map((event) => {
    if (!isObject(event) || event.type !== 'user-message' || !('attachments' in event)) return event
    const list = event.attachments
    if (Array.isArray(list)) return list.every(isObject) ? event : { ...event, attachments: list.filter(isObject) }
    const { attachments: _dropped, ...rest } = event
    return rest
  })
  return { ...raw, log, formatVersion: 3 }
}

/** v3 → v4: AttachmentRef (the v3 attachment views converted), documents, compaction, container, local tools and tool policies. */
function toV4(raw: RawChat): RawChat {
  const caps = capsOf(raw)
  return {
    ...raw,
    capabilities: { ...caps, ...normalizeRichChatCapabilities(caps) },
    log: normalizeAttachmentLog(logOf(raw) as AgentEvent[]),
    formatVersion: 4,
  }
}

/** v4 → v5: the newer summary fields, client tools, private chats, remembered grants and the `/skill` a message expanded. */
function toV5(raw: RawChat): RawChat {
  const caps = capsOf(raw)
  const log = logOf(raw).map((event) => {
    if (!isObject(event) || event.type !== 'user-message' || !('skill' in event)) return event
    const skill = event.skill
    if (isObject(skill) && str(skill.id) && str(skill.name) && typeof skill.builtin === 'boolean') return event
    const { skill: _dropped, ...rest } = event
    return rest
  })
  return {
    ...raw,
    ...normalizeSummaryLinks(raw),
    capabilities: { ...caps, ...normalizeAgentToolsCapabilities(caps) },
    grants: normalizeGrants(raw.grants),
    log,
    formatVersion: 5,
  }
}

/** In order; `to` of one is `from` of the next, ending at CHAT_FORMAT_VERSION. */
export const CHAT_STEPS: readonly ChatStep[] = [
  { from: 0, to: 1, name: 'original shape', up: toV1 },
  { from: 1, to: 2, name: 'summary flags and tool events', up: toV2 },
  { from: 2, to: 3, name: 'message attachments', up: toV3 },
  { from: 3, to: 4, name: 'attachment refs and capabilities', up: toV4 },
  { from: 4, to: 5, name: 'summary fields, client tools and grants', up: toV5 },
]

/** Runs every step from `from` on; the result carries the last step's formatVersion. */
export function applySteps(raw: RawChat, from: number): RawChat {
  let out = raw
  for (const step of CHAT_STEPS) if (step.from >= from) out = step.up(out)
  return out
}
