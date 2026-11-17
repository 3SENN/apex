/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentEvent } from '@shared/ipc'
import type { ApprovalMode, PermissionsOverview } from '@shared/agentTools'
import type { UsageReport } from '@shared/usage'
import { UI } from '@shared/ipc'
import { core } from '../app'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { registerScenario } from '../smokeClient'

// Client tools and requests (questions), delegation, private chats, approval modes and site rules, the countdown, usage and the prompt viewer.
// Offline only: the offline client replays registerScenario scripts, so
// nothing reaches the network. Shots cover Settings › Agent permissions
// and Model and key's Usage section and prompt viewer, in light and dark.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitFor(condition: () => boolean, label: string, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const logOf = (ctx: SmokeContext, id: string): AgentEvent[] => ctx.host.view(id).log

registerScenario(/^smoke-d1: questions/, [
  { kind: 'thinking', text: 'The person should choose the date.' },
  { kind: 'tool', name: 'update_plan', input: { items: [{ id: 'ask', title: 'Ask about the trip', status: 'active' }, { id: 'book', title: 'Suggest a train', status: 'pending' }] } },
  { kind: 'tool', name: 'ask_user_questions', input: { questions: [{ id: 'day', prompt: 'Which day suits you?', options: ['Friday', 'Saturday'] }, { id: 'seat', prompt: 'Window or aisle?', options: ['Window', 'Aisle'], allowOther: true }] } },
  { kind: 'tool', name: 'update_plan', input: { items: [{ id: 'ask', title: 'Ask about the trip', status: 'done' }, { id: 'book', title: 'Suggest a train', status: 'done' }] } },
  { kind: 'text', text: 'The 9:12 on Friday has window seats left.' },
])

registerScenario(/^smoke-d1: private/, [{ kind: 'usage', inputTokens: 300, outputTokens: 20 }, { kind: 'text', text: 'Nothing of this chat is kept.' }])

async function run(ctx: SmokeContext, text: string, options: { private?: boolean } = {}): Promise<string> {
  const id = ctx.host.start(text, options)
  await waitFor(() => !ctx.host.isRunning(id), `the chat to answer “${text}”`)
  return id
}

export const checks: SmokeCheck[] = [
  {
    name: 'ask_user_questions waits for answers through agent.respond; the latest plan replaces earlier ones',
    async run(ctx) {
      const id = ctx.host.start('smoke-d1: questions for my trip')
      await waitFor(() => logOf(ctx, id).some((e) => e.type === 'question'), 'the question card')
      const question = logOf(ctx, id).find((e): e is Extract<AgentEvent, { type: 'question' }> => e.type === 'question')
      assert(question && question.questions.length === 2, 'the question card lacks its questions')
      assert(ctx.host.view(id).summary.needsInput || ctx.host.isRunning(id), 'the chat does not wait for input')
      ctx.host.respond(id, question.requestId, { kind: 'question', answers: [{ id: 'day', answer: 'Friday' }, { id: 'seat', answer: null }] })
      await waitFor(() => !ctx.host.isRunning(id), 'the chat to finish')
      const log = logOf(ctx, id)
      assert(log.some((e) => e.type === 'request-resolved' && e.requestId === question.requestId && e.outcome === 'answered'), 'no answered outcome')
      const plans = log.filter((e): e is Extract<AgentEvent, { type: 'plan' }> => e.type === 'plan')
      assert(plans.length === 1 && plans[0]?.items.every((i) => i.status === 'done'), `expected one finished plan, got ${plans.length}`)
      // An answer to a request that is already resolved is ignored.
      ctx.host.respond(id, question.requestId, { kind: 'question', answers: null })
      assert(logOf(ctx, id).filter((e) => e.type === 'request-resolved').length === 1, 'a second answer was logged')
    },
  },
  {
    name: 'a private chat is never saved, has no memory tool, and is discarded',
    async run(ctx) {
      const id = await run(ctx, 'smoke-d1: private note', { private: true })
      assert(ctx.chats.summary(id) === undefined, 'the private chat reached ChatStore')
      assert(!ctx.chats.list().some((c) => c.id === id), 'the private chat is listed')
      const view = ctx.host.systemPromptView({ chatId: id })
      assert(!view.tools.includes('memory'), 'the private chat has the memory tool')
      ctx.host.discardPrivate(id)
      let gone = false
      try {
        ctx.host.view(id)
      } catch {
        gone = true
      }
      assert(gone, 'discard left the private chat')
    },
  },
  {
    name: 'Don’t ask is never stored, and the prompt viewer shows a companion’s next prompt',
    async run(ctx) {
      const before = await ctx.chrome.invoke<ApprovalMode>('agent', 'approvalMode')
      try {
        assert((await ctx.chrome.invoke<ApprovalMode>('agent', 'setApprovalMode', 'dont-ask')) === 'dont-ask', 'Don’t ask did not take')
        assert(ctx.settings.get().approvalMode !== ('dont-ask' as never), 'Don’t ask reached Settings')
      } finally {
        await ctx.chrome.invoke('agent', 'setApprovalMode', before === 'dont-ask' ? 'standard' : before)
      }
      const companion = await ctx.chrome.invoke<{ id: string }>('companion', 'get')
      const view = await ctx.chrome.invoke<{ system: string; frozen: boolean }>('agent', 'systemPrompt', { companionId: companion.id })
      assert(view.system.length > 100 && !view.frozen, 'the prompt viewer returned no preview')
    },
  },
  {
    name: 'site rules list in Saved permissions and remove cleanly; usage reports by day',
    async run(ctx) {
      await ctx.chrome.invoke('agentSites', 'setSite', 'https://smoke-d1.example', 'ask')
      const overview = await ctx.chrome.invoke<PermissionsOverview>('agentSites', 'overview')
      assert(overview.sites.some((s) => s.origin === 'https://smoke-d1.example' && s.access === 'ask'), 'the site rule is missing')
      await ctx.chrome.invoke('agentSites', 'removeSite', 'https://smoke-d1.example')
      const after = await ctx.chrome.invoke<PermissionsOverview>('agentSites', 'overview')
      assert(!after.sites.some((s) => s.origin === 'https://smoke-d1.example'), 'the site rule was not removed')
      const now = Date.now()
      const report = await ctx.chrome.invoke<UsageReport>('usage', 'report', { from: now - 29 * 86_400_000, to: now + 86_400_000 }, 'day')
      assert(report.rows.length >= 30 && report.totals.turns > 0, `usage has ${report.totals.turns} turns`)
    },
  },
]

export const shots: ShotSpec[] = [
  {
    // DS-67: in the side panel, the face beside a question has its mark beside the head, never on it.
    name: 'chat-question-panel',
    async run(ctx) {
      const id = ctx.host.start('smoke-d1: questions for my trip')
      try {
        await waitFor(() => logOf(ctx, id).some((e) => e.type === 'question'), 'the question card')
        const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
        assert(win, 'the first window')
        win.send({ type: 'voice-open-chat', chatId: id })
        await ctx.chrome.until(`return document.querySelector('.panel-frame .chat-panel .cd-question')`, 8000, 'the question in the side panel')
        await new Promise((r) => setTimeout(r, 400))
        await ctx.shot('chat-question-panel')
      } finally {
        const question = logOf(ctx, id).find((e): e is Extract<AgentEvent, { type: 'question' }> => e.type === 'question')
        if (question) ctx.host.respond(id, question.requestId, { kind: 'question', answers: null })
        await waitFor(() => !ctx.host.isRunning(id), 'the chat to finish').catch(() => undefined)
        if (await ctx.chrome.js<boolean>(`return Boolean(document.querySelector('.panel-frame .chat-panel'))`)) ctx.chrome.ui.send(UI.command, 'toggle-agent')
      }
    },
  },
  {
    name: 'agent-permissions-settings',
    async run(ctx) {
      await ctx.chrome.invoke('agentSites', 'setSite', 'https://shop.example', 'ask')
      ctx.tabs.openInternal('apex://settings/permissions')
      await ctx.chrome.until(`return document.querySelector('.ag-modes') && document.querySelector('.ag-saved')`, 8000, 'Settings › Agent permissions')
      await ctx.shot('agent-permissions-settings')
      await ctx.chrome.invoke('agentSites', 'removeSite', 'https://shop.example')
    },
  },
  {
    name: 'usage-settings',
    async run(ctx) {
      ctx.tabs.openInternal('apex://settings/model')
      await ctx.chrome.until(`return document.querySelector('.ag-usage .ag-bars, .ag-usage .ui-empty, .ag-usage [class*="empty"]')`, 8000, 'the Usage section')
      await ctx.chrome.js(`document.querySelector('.ag-usage')?.scrollIntoView({ block: 'center' }); return true`)
      await ctx.shot('usage-settings')
    },
  },
  {
    name: 'prompt-viewer',
    async run(ctx) {
      ctx.tabs.openInternal('apex://settings/model')
      await ctx.chrome.click(/^View system prompt$/, `document.querySelector('.sp-page')`)
      await ctx.chrome.until(`return document.querySelector('.ag-prompt__text')`, 8000, 'the system prompt dialog')
      await ctx.shot('prompt-viewer')
      await ctx.chrome.click(/^Close$/, `document.querySelector('[role="dialog"]')`)
    },
  },
]
