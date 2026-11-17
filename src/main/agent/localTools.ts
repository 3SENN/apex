/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from 'node:crypto'
import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { LOCAL_TOOL_API_NAME, type LocalToolSnapshot, type ToolPolicy } from '@shared/connectors'
import type { AgentEvent } from '@shared/ipc'
import type { ConnectorRuntime } from '../connectors/runtime'

// CH-40: local (stdio) connector tools as client tools. A chat
// snapshots them at its first message, in a deterministic order and under
// stable API names, so its tool list never changes. Each call checks the
// live policy: 'off' refuses, 'ask' shows an editable approval in the chat
// and waits, 'allow' runs. A confirmed form is validated again in main.

export type ApprovalResponse = { allowed: true; input: unknown } | { allowed: false; message?: string }

const slug = (text: string, max: number): string => text.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'tool'
const hash6 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 6)

/**
 * `<connectorSlug>__<toolSlug>`, at most 64 of [a-zA-Z0-9_-]. A name that
 * repeats (two connectors with the same slug) gets a 6-character hash
 * suffix of its connector and tool, so it stays the same on every start.
 */
export function localToolApiNames(tools: ReadonlyArray<{ connectorId: string; connectorName: string; toolName: string }>): string[] {
  const base = tools.map((t) => `${slug(t.connectorName, 28)}__${slug(t.toolName, 32)}`.slice(0, 64))
  const counts = new Map<string, number>()
  for (const name of base) counts.set(name, (counts.get(name) ?? 0) + 1)
  const used = new Set<string>()
  return base.map((name, i) => {
    const tool = tools[i]
    let out = (counts.get(name) ?? 0) > 1 && tool ? `${name.slice(0, 57)}_${hash6(`${tool.connectorId}/${tool.toolName}`)}` : name
    for (let n = 2; used.has(out); n++) out = `${out.slice(0, 60)}_${n}`
    used.add(out)
    return out
  })
}

/**
 * The chat's frozen local tools: ordered by connector name, then tool name,
 * with API names that are valid and unique (the runtime's own when they are,
 * else ours).
 */
export function snapshotLocalTools(tools: readonly LocalToolSnapshot[], connectorName: (connectorId: string) => string): LocalToolSnapshot[] {
  const sorted = tools
    .map((tool) => ({ tool, connectorName: connectorName(tool.connectorId) }))
    .sort((a, b) => a.connectorName.localeCompare(b.connectorName) || a.tool.toolName.localeCompare(b.tool.toolName) || a.tool.connectorId.localeCompare(b.tool.connectorId))
  const valid = sorted.every(({ tool }) => LOCAL_TOOL_API_NAME.test(tool.apiName)) && new Set(sorted.map(({ tool }) => tool.apiName)).size === sorted.length
  const names = valid ? sorted.map(({ tool }) => tool.apiName) : localToolApiNames(sorted.map(({ tool, connectorName }) => ({ connectorId: tool.connectorId, connectorName, toolName: tool.toolName })))
  return sorted.map(({ tool }, i) => ({ ...tool, apiName: names[i] ?? tool.apiName }))
}

/** The tool params for the API-key request. */
export function localToolParams(tools: readonly LocalToolSnapshot[]): Array<{ name: string; description: string; input_schema: { type: 'object'; [key: string]: unknown } }> {
  return tools.map((tool) => {
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? (tool.inputSchema as Record<string, unknown>) : {}
    return { name: tool.apiName, description: tool.description.slice(0, 1024) || tool.toolName, input_schema: { ...schema, type: 'object' as const } }
  })
}

/** Approvals waiting in one chat, answered through agent.approveConnector. */
export class ConnectorApprovals {
  readonly #waiting = new Map<string, { input: unknown; resolve(response: ApprovalResponse): void; validate(input: unknown): void }>()

  get pending(): number {
    return this.#waiting.size
  }

  /** Waits for the person's answer; a stop resolves it declined. */
  wait(approvalId: string, input: unknown, validate: (input: unknown) => void, signal: AbortSignal): Promise<ApprovalResponse> {
    if (signal.aborted) return Promise.resolve({ allowed: false })
    return new Promise((resolve) => {
      const done = (response: ApprovalResponse): void => {
        if (!this.#waiting.delete(approvalId)) return
        signal.removeEventListener('abort', onAbort)
        resolve(response)
      }
      const onAbort = (): void => done({ allowed: false })
      this.#waiting.set(approvalId, { input, resolve: done, validate })
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Answers one. An edited input that fails the tool's schema throws, and the approval keeps waiting. */
  respond(approvalId: string, response: ApprovalResponse): void {
    const waiting = this.#waiting.get(approvalId)
    if (!waiting) throw new Error('That approval was already answered.')
    if (response.allowed) waiting.validate(response.input)
    waiting.resolve(response)
  }

  /** Declines every waiting approval (stop, discard). */
  declineAll(): void {
    for (const waiting of [...this.#waiting.values()]) waiting.resolve({ allowed: false })
  }
}

export interface LocalCallContext {
  runtime: ConnectorRuntime
  approvals: ConnectorApprovals
  connectorName(connectorId: string): string
  emit(event: AgentEvent): void
  /** The chat waits for you while an approval is open. */
  awaiting(on: boolean): void
  /** Background runs can't ask. */
  routine: boolean
  signal: AbortSignal
}

export type LocalCallResult = { content: BetaToolResultBlockParam['content']; isError: boolean }

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Runs one local connector tool under its live policy. */
export async function callLocalTool(tool: LocalToolSnapshot, input: unknown, ctx: LocalCallContext): Promise<LocalCallResult> {
  const policy: ToolPolicy = ctx.runtime.livePolicy(tool.connectorId, tool.toolName)
  if (policy === 'off') return { content: `The user turned off ${tool.toolName} for ${ctx.connectorName(tool.connectorId)}, so it can’t be used. Do the task another way, or tell the user.`, isError: true }
  let finalInput = input
  if (policy === 'ask') {
    if (ctx.routine) return { content: `${tool.toolName} needs the user’s approval, which a background run can’t ask for. It was not run.`, isError: true }
    const approvalId = randomUUID()
    ctx.awaiting(true)
    ctx.emit({
      type: 'connector-approval',
      approvalId,
      connectorId: tool.connectorId,
      connectorName: ctx.connectorName(tool.connectorId),
      tool: tool.toolName,
      actionLabel: tool.actionLabel,
      inputSchema: tool.inputSchema,
      input,
    })
    const validate = (edited: unknown): void => {
      const check = ctx.runtime.validateInput(tool.connectorId, tool.toolName, edited)
      if (!check.ok) throw new Error(`Check the form: ${check.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`)
    }
    const response = await ctx.approvals.wait(approvalId, input, validate, ctx.signal)
    ctx.awaiting(false)
    const edited = response.allowed && !sameJson(response.input, input)
    ctx.emit({ type: 'connector-approval-resolved', approvalId, outcome: response.allowed ? 'confirmed' : 'declined', edited })
    if (!response.allowed) {
      const note = response.message?.trim()
      return { content: ctx.signal.aborted ? 'Not run: the user stopped the chat.' : `Declined${note ? `: ${note}` : '.'}`, isError: true }
    }
    finalInput = response.input
  }
  return ctx.runtime.callLocal(tool.connectorId, tool.toolName, finalInput, ctx.signal)
}

/** A local tool's result content as plain text (an engine's MCP route takes text and images). */
export function resultText(content: BetaToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
}
