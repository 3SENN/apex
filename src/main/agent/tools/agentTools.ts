/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The agent's client tools: ask_user_questions, update_plan and
// delegate_task, plus companion_files (CO-08: the chat's own companion
// folder, read-only). The same definitions serve every engine: the API-key
// loop lists them in `tools`, and an engine that runs the model elsewhere
// reaches them through Apex's local MCP server.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { z } from 'zod'
import { QUESTION_LIMITS, type AgentRequestResponse, type QuestionSpec } from '@shared/agentTools'
import { randomUUID } from 'node:crypto'
import { jsonSchemaOf } from '../../mcp/tools'
import { clientTool, registerClientTool, type ClientTool, type ClientToolContext, type ClientToolResult } from './registry'

const ID = /^[A-Za-z0-9_-]{1,40}$/

const httpUrl = z.string().max(2048).refine((url) => {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}, 'Use an http or https address.')

const questionSchema = z.object({
  id: z.string().regex(ID).describe('A short id for this question, unique in the call, such as "budget".'),
  prompt: z.string().trim().min(1).max(500).describe('The question, in one sentence.'),
  detail: z.string().trim().max(1000).optional().describe('Optional context shown under the question.'),
  options: z.array(z.string().trim().min(1).max(200)).max(QUESTION_LIMITS.options).optional().describe('Up to 6 suggested answers.'),
  multi: z.boolean().optional().describe('The user may pick several options.'),
  allowOther: z.boolean().optional().describe('The user may type their own answer as well.'),
  link: z.object({ url: httpUrl, title: z.string().trim().min(1).max(200) }).strict().optional().describe('A page the user may want to look at before answering.'),
}).strict()

export const askUserQuestionsInput = z.object({
  questions: z.array(questionSchema).min(1).max(QUESTION_LIMITS.questions),
}).strict().refine((input) => new Set(input.questions.map((q) => q.id)).size === input.questions.length, { message: 'Each question needs its own id.', path: ['questions'] })

const planItemSchema = z.object({
  id: z.string().regex(ID),
  title: z.string().trim().min(1).max(200),
  status: z.enum(['pending', 'active', 'done', 'skipped']),
}).strict()

export const updatePlanInput = z.object({
  items: z.array(planItemSchema).min(1).max(30),
}).strict()

export const delegateTaskInput = z.object({
  title: z.string().trim().min(1).max(120).describe('A short name for the sub-task, shown to the user.'),
  instructions: z.string().trim().min(1).max(20_000).describe('Everything the helper needs: it sees nothing of this chat.'),
}).strict()

export const companionFilesInput = z.object({
  action: z.enum(['list', 'read']),
  path: z.string().max(1024).optional().describe('A folder to list or a file to read, relative to the folder; leave out for the top.'),
}).strict()

/** The answers as the model gets them: one entry per question, in order, null for skipped. */
export function questionResult(questions: readonly QuestionSpec[], response: Extract<AgentRequestResponse, { kind: 'question' }>): string {
  const given = new Map((response.answers ?? []).map((a) => [a.id, a.answer]))
  return JSON.stringify(questions.map((q) => {
    const answer = given.get(q.id) ?? null
    const empty = answer === null || (Array.isArray(answer) ? answer.length === 0 : answer.trim() === '')
    return { id: q.id, answer: empty ? null : answer }
  }))
}

export interface AgentToolDeps {
  /** Runs a sub-task in a child chat and resolves with its result (delegation.ts). */
  delegate(input: z.infer<typeof delegateTaskInput>, ctx: ClientToolContext): Promise<ClientToolResult>
  /** The chat's companion folder (CompanionFiles), read-only. */
  companionFiles: {
    list(companionId: string, folder?: string): Array<{ path: string; kind: 'file' | 'folder'; size: number }>
    resolve(companionId: string, path: string): string
  }
}

const TEXT_TYPES = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log'])
const READ_MAX_BYTES = 2 * 1024 * 1024

function define<I>(tool: ClientTool<I>): ClientTool<I> {
  return tool
}

export function agentTools(deps: AgentToolDeps): ClientTool<any>[] {
  return [
    define({
      name: 'ask_user_questions',
      group: 'chat',
      description: 'Ask the user one to eight short questions at once and wait for their answers. Each question can offer up to six suggested answers, allow several picks or a typed answer, and link a page to look at first. The result is JSON: [{id, answer}], where answer is a string, a list of strings, or null when the user skipped it. Use it when a choice is the user\'s to make, never for facts you can find yourself.',
      inputSchema: jsonSchemaOf(askUserQuestionsInput),
      parse: askUserQuestionsInput,
      enabled: (setup) => !setup.routine,
      async run(input, ctx) {
        const questions: QuestionSpec[] = input.questions.map((q) => ({ ...q }))
        const response = await ctx.ask<Extract<AgentRequestResponse, { kind: 'question' }>>({ type: 'question', requestId: randomUUID(), questions })
        return { content: questionResult(questions, response) }
      },
    }),
    define({
      name: 'update_plan',
      group: 'chat',
      description: 'Show the user a checklist for a longer task, and keep it current as you work. Send the whole list every time; the newest list replaces the last one. Keep one item active at a time.',
      inputSchema: jsonSchemaOf(updatePlanInput),
      parse: updatePlanInput,
      enabled: () => true,
      run(input, ctx) {
        ctx.emit({ type: 'plan', items: input.items.map((item) => ({ ...item })) })
        const done = input.items.filter((i) => i.status === 'done').length
        return Promise.resolve({ content: `Plan updated: ${done} of ${input.items.length} done.` })
      },
    }),
    define({
      name: 'delegate_task',
      group: 'chat',
      description: 'Hand a self-contained sub-task to a helper chat with the same companion and model, and wait for its final answer (at most 20,000 characters). At most three run at once. The helper sees nothing of this chat, so give complete instructions. The user can open the helper chat and follow it.',
      inputSchema: jsonSchemaOf(delegateTaskInput),
      parse: delegateTaskInput,
      enabled: (setup) => !setup.routine && setup.child !== true,
      run: (input, ctx) => deps.delegate(input, ctx),
    }),
    define({
      name: 'companion_files',
      group: 'files',
      description: 'Read the files the user keeps in your companion folder (notes, lists, reference documents). action "list" lists a folder; action "read" returns a text file\'s contents. Read-only: you can\'t change or add files here.',
      inputSchema: jsonSchemaOf(companionFilesInput),
      parse: companionFilesInput,
      enabled: () => true,
      // async, so a path outside the folder rejects (an error result) instead of throwing mid-batch.
      async run(input, ctx) {
        const path = (input.path ?? '').replace(/^\/+/, '')
        if (input.action === 'list') {
          const entries = deps.companionFiles.list(ctx.companionId, path)
          if (entries.length === 0) return Promise.resolve({ content: path ? `${path} is empty or doesn't exist.` : 'Your companion folder is empty.' })
          return Promise.resolve({ content: entries.map((e) => (e.kind === 'folder' ? `${e.path}/` : `${e.path} (${e.size} bytes)`)).join('\n') })
        }
        if (!path) return Promise.resolve({ content: 'Give the path of a file to read.', isError: true })
        const full = deps.companionFiles.resolve(ctx.companionId, path)
        if (!existsSync(full)) return Promise.resolve({ content: `There is no ${path} in your companion folder.`, isError: true })
        const stat = statSync(full)
        if (stat.isDirectory()) return Promise.resolve({ content: `${path} is a folder; use action "list".`, isError: true })
        if (!TEXT_TYPES.has(extname(full).toLowerCase())) return Promise.resolve({ content: `${path} isn't a text file, so this tool can't read it.`, isError: true })
        if (stat.size > READ_MAX_BYTES) return Promise.resolve({ content: `${path} is larger than 2 MB, too large to read here.`, isError: true })
        return Promise.resolve({ content: readFileSync(full, 'utf8') })
      },
    }),
  ]
}

/** Registers these tools once (feature start-up, and tests that call it again). */
export function registerAgentClientTools(deps: AgentToolDeps): void {
  for (const tool of agentTools(deps)) if (!clientTool(tool.name)) registerClientTool(tool)
}
