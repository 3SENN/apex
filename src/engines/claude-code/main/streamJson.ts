/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TurnUsage } from '@shared/chats'
import type { Effort } from '@shared/ipc'
import { looksSignedOut } from './cli'

// Claude Code's headless protocol (`-p --input-format stream-json
// --output-format stream-json --include-partial-messages --verbose`): one
// JSON object per line in each direction. This module only reads lines and
// says what they mean; the bridge turns that into Atelier chat events.
//
// Text and thinking arrive twice: as partial deltas (stream_event) while the
// model writes, then once more in the finished `assistant` message. Deltas
// win; the finished message is used only for messages that never streamed.

export type BridgeEvent =
  | { kind: 'init'; sessionId: string; model: string | null; tools: string[]; mcpServers: Array<{ name: string; status: string }> }
  | { kind: 'text'; messageId: string; text: string }
  | { kind: 'thinking'; messageId: string; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown; /* The model message that asked for it (one step) */ messageId?: string }
  | { kind: 'tool-result'; id: string; isError: boolean; text: string }
  /** Usage of one model message so far (the latest reading replaces earlier ones). */
  | { kind: 'usage'; messageId: string; model: string | null; usage: TurnUsage; stopReason: string | null }
  | { kind: 'result'; ok: boolean; subtype: string; text: string; sessionId: string | null; costUsd: number | null; usage: TurnUsage | null; numTurns: number; errors: string[] }
  | { kind: 'rate-limit'; status: 'allowed' | 'warning' | 'limited'; resetsAt: number | null; limitType: string | null }
  | { kind: 'compacting'; active: boolean; /* CH-26: set by compact_boundary, when the history was condensed */ boundary?: { trigger: 'auto' | 'manual'; preTokens: number | null } }
  | { kind: 'control-response'; requestId: string; ok: boolean; error: string | null }
  /**
   * The CLI's message that wraps an API error ("API Error: 400 {…}", "Invalid
   * API key · Please run /login"). Never reply text: the bridge keeps it for
   * the error card and shows none of it in the reply.
   */
  | { kind: 'api-error'; messageId: string; text: string; error: string | null; apiError: string | null; status: number | null }

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function usageOf(raw: unknown): TurnUsage | null {
  if (!isObject(raw)) return null
  return {
    inputTokens: num(raw.input_tokens) ?? 0,
    outputTokens: num(raw.output_tokens) ?? 0,
    cacheReadTokens: num(raw.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(raw.cache_creation_input_tokens) ?? 0,
  }
}

/** A tool_result's content as plain text (images become a marker). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (isObject(block) ? (block.type === 'text' ? (str(block.text) ?? '') : block.type === 'image' ? '[image]' : '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** Reads one stream-json line at a time. Keeps just enough state to drop repeats and pair usage with messages. */
export class StreamJsonReader {
  /** Messages whose text or thinking already streamed as deltas. */
  readonly #streamed = new Set<string>()
  #current: { id: string; model: string | null; usage: TurnUsage | null; stopReason: string | null } | null = null

  /** Parses one line; malformed lines and events Atelier doesn't use give nothing. */
  read(line: string): BridgeEvent[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      return []
    }
    return isObject(value) ? this.event(value) : []
  }

  event(object: Json): BridgeEvent[] {
    // Sub-agent traffic carries its parent's tool id; Atelier chats run no sub-agents, so it is ignored.
    if (object.parent_tool_use_id) return []
    switch (object.type) {
      case 'system':
        return this.#system(object)
      case 'stream_event':
        return isObject(object.event) ? this.#stream(object.event) : []
      case 'assistant':
        return isObject(object.message) ? this.#assistant(object.message, object) : []
      case 'user':
        return isObject(object.message) ? this.#user(object.message) : []
      case 'result':
        return [this.#result(object)]
      case 'rate_limit_event':
        return this.#rateLimit(object.rate_limit_info)
      case 'control_response': {
        const response = isObject(object.response) ? object.response : {}
        return [{ kind: 'control-response', requestId: str(response.request_id) ?? '', ok: response.subtype === 'success', error: str(response.error) }]
      }
      default:
        return []
    }
  }

  #system(object: Json): BridgeEvent[] {
    if (object.subtype === 'init') {
      const servers = Array.isArray(object.mcp_servers) ? object.mcp_servers.filter(isObject) : []
      return [{
        kind: 'init',
        sessionId: str(object.session_id) ?? '',
        model: str(object.model),
        tools: Array.isArray(object.tools) ? object.tools.filter((t): t is string => typeof t === 'string') : [],
        mcpServers: servers.map((s) => ({ name: str(s.name) ?? '', status: str(s.status) ?? '' })),
      }]
    }
    if (object.subtype === 'status') return [{ kind: 'compacting', active: object.status === 'compacting' }]
    if (object.subtype === 'compact_boundary') {
      const meta = (object.compact_metadata ?? {}) as Json
      const preTokens = typeof meta.pre_tokens === 'number' && Number.isFinite(meta.pre_tokens) ? meta.pre_tokens : null
      return [{ kind: 'compacting', active: false, boundary: { trigger: meta.trigger === 'manual' ? 'manual' : 'auto', preTokens } }]
    }
    return []
  }

  #stream(event: Json): BridgeEvent[] {
    switch (event.type) {
      case 'message_start': {
        const message = isObject(event.message) ? event.message : {}
        const id = str(message.id) ?? `message-${Date.now()}`
        this.#current = { id, model: str(message.model), usage: usageOf(message.usage), stopReason: null }
        return []
      }
      case 'content_block_delta': {
        const current = this.#current
        const delta = isObject(event.delta) ? event.delta : {}
        if (!current) return []
        if (delta.type === 'text_delta' && str(delta.text)) {
          this.#streamed.add(current.id)
          return [{ kind: 'text', messageId: current.id, text: str(delta.text) ?? '' }]
        }
        if (delta.type === 'thinking_delta' && str(delta.thinking)) {
          this.#streamed.add(current.id)
          return [{ kind: 'thinking', messageId: current.id, text: str(delta.thinking) ?? '' }]
        }
        return []
      }
      case 'message_delta': {
        const current = this.#current
        if (!current) return []
        const delta = isObject(event.delta) ? event.delta : {}
        current.stopReason = str(delta.stop_reason) ?? current.stopReason
        const usage = usageOf(event.usage)
        // message_delta reports output tokens (and sometimes input); keep what message_start knew.
        if (usage) current.usage = { ...(current.usage ?? usage), ...pickNonZero(usage) }
        return []
      }
      case 'message_stop': {
        const current = this.#current
        this.#current = null
        if (!current?.usage) return []
        return [{ kind: 'usage', messageId: current.id, model: current.model, usage: current.usage, stopReason: current.stopReason }]
      }
      default:
        return []
    }
  }

  #assistant(message: Json, wrapper: Json = {}): BridgeEvent[] {
    const id = str(message.id) ?? ''
    const out: BridgeEvent[] = []
    const content = Array.isArray(message.content) ? message.content.filter(isObject) : []
    const streamed = this.#streamed.has(id)
    const apiError = streamed ? null : apiErrorOf(message, wrapper, content)
    if (apiError) return [{ kind: 'api-error', messageId: id, ...apiError }]
    for (const block of content) {
      if (block.type === 'text' && !streamed && str(block.text)) out.push({ kind: 'text', messageId: id, text: str(block.text) ?? '' })
      else if (block.type === 'thinking' && !streamed && str(block.thinking)) out.push({ kind: 'thinking', messageId: id, text: str(block.thinking) ?? '' })
      else if (block.type === 'tool_use' && str(block.id)) out.push({ kind: 'tool-use', id: str(block.id) ?? '', name: str(block.name) ?? 'tool', input: block.input ?? {}, ...(id ? { messageId: id } : {}) })
    }
    // Without partial messages, the finished message is the only usage reading.
    const usage = usageOf(message.usage)
    if (usage && !streamed) out.push({ kind: 'usage', messageId: id, model: str(message.model), usage, stopReason: str(message.stop_reason) })
    return out
  }

  #user(message: Json): BridgeEvent[] {
    const content = Array.isArray(message.content) ? message.content.filter(isObject) : []
    return content.flatMap((block): BridgeEvent[] =>
      block.type === 'tool_result' && str(block.tool_use_id)
        ? [{ kind: 'tool-result', id: str(block.tool_use_id) ?? '', isError: block.is_error === true, text: resultText(block.content) }]
        : [],
    )
  }

  #result(object: Json): BridgeEvent {
    const subtype = str(object.subtype) ?? 'success'
    const errors = Array.isArray(object.errors) ? object.errors.filter((e): e is string => typeof e === 'string') : []
    return {
      kind: 'result',
      ok: object.is_error !== true && subtype === 'success',
      subtype,
      text: str(object.result) ?? '',
      sessionId: str(object.session_id),
      costUsd: num(object.total_cost_usd),
      usage: usageOf(object.usage),
      numTurns: num(object.num_turns) ?? 0,
      errors,
    }
  }

  #rateLimit(info: unknown): BridgeEvent[] {
    if (!isObject(info)) return []
    const raw = str(info.status) ?? 'allowed'
    const status = raw === 'rejected' ? 'limited' : raw === 'allowed_warning' ? 'warning' : 'allowed'
    const resets = num(info.resetsAt)
    // The CLI reports seconds since the epoch; accept milliseconds too.
    const resetsAt = resets === null ? null : resets < 1e12 ? resets * 1000 : resets
    return [{ kind: 'rate-limit', status, resetsAt, limitType: str(info.rateLimitType) }]
  }
}

/** Text the CLI writes for an API error it got, as opposed to the model's own words. */
const API_ERROR_TEXT = /^API Error(?:\s*\([^)]*\))?:\s*(?:\d{3}\b|request timed out|connection error|terminated)/i

/**
 * Whether an assistant message is the CLI reporting an API error: its typed
 * `error` (or newer CLIs' is_api_error_message) says so, or a synthetic
 * message (no model ran) or an unstreamed text-only one says "API Error: 400 …".
 */
export function apiErrorOf(message: Json, wrapper: Json, content: Json[]): { text: string; error: string | null; apiError: string | null; status: number | null } | null {
  if (content.some((b) => b.type === 'tool_use' || b.type === 'thinking')) return null
  const text = content.map((b) => (b.type === 'text' ? (str(b.text) ?? '') : '')).join('\n').trim()
  const error = str(wrapper.error)
  const flagged = wrapper.is_api_error_message === true || (error !== null && error !== 'max_output_tokens')
  const synthetic = message.model === '<synthetic>'
  const errorText = API_ERROR_TEXT.test(text) || (synthetic && looksSignedOut(text))
  if (!flagged && !(errorText && (synthetic || content.length <= 1))) return null
  return { text, error, apiError: str(wrapper.api_error), status: num(wrapper.api_error_status) }
}

function pickNonZero(usage: TurnUsage): Partial<TurnUsage> {
  return Object.fromEntries(Object.entries(usage).filter(([, v]) => v > 0)) as Partial<TurnUsage>
}

// ---- what Atelier writes ----

/** A PDF as the model reads it on the API key (pages and all), in Claude Code's stream-json input. */
export type DocumentBlock = import('../../../../src/main/engines/backend').DocumentBlock
/** One block of a user line: text, an image or a PDF. */
export type LineBlock = import('../../../../src/main/engines/backend').TurnBlock

/** PDFs larger than this go as their extracted text (the base64 copy rides in every later request of the session). */
export const PDF_DOCUMENT_MAX_BYTES = 10_000_000
/** And PDFs with more pages than every model reads as pages. */
export const PDF_DOCUMENT_MAX_PAGES = 100

const escapeAttr = (value: string): string => value.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c] ?? c)

/**
 * A PDF attachment for Claude Code: the document itself as a base64
 * document block, as on the API key, or its extracted text in a titled
 * <document> wrapper when it is very large or can't be read.
 */
export function pdfBlock(pdf: { title: string; pages: number; text: string; read(): Buffer }): LineBlock {
  const title = pdf.title || 'Document.pdf'
  const fallback: LineBlock = { type: 'text', text: `<document title="${escapeAttr(title)}" pages="${pdf.pages}">\n${pdf.text}\n</document>` }
  if (pdf.pages > PDF_DOCUMENT_MAX_PAGES) return fallback
  let bytes: Buffer
  try {
    bytes = pdf.read()
  } catch {
    return fallback
  }
  if (bytes.length === 0 || bytes.length > PDF_DOCUMENT_MAX_BYTES) return fallback
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') }, title }
}

/** One user message for the CLI's stdin. */
export function userLine(blocks: ReadonlyArray<LineBlock> /* Text and image blocks: PDFs */): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } })}\n`
}

/** A slash command (e.g. /compact) as a user line; Claude Code runs it as it would in its own prompt. */
export function commandLine(command: string): string {
  return userLine([{ type: 'text', text: command }])
}

/**
 * DC-15: sets the session's effort from the next message on, as /effort would
 * (Claude Code 2.1's apply_flag_settings; it answers with a control_response).
 * The effort holds until changed again.
 */
export function effortLine(requestId: string, effort: Effort): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'apply_flag_settings', settings: { effortLevel: effort } } })}\n`
}

/** Asks the CLI to stop the turn it is working on; it answers with a control_response and ends the turn. */
export function interruptLine(requestId: string): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })}\n`
}
