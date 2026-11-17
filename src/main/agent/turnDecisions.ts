/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BetaMessageParam, MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Effort } from '@shared/ipc'
import type { EffortMark } from '../chats'
import { DECISION_TIMEOUTS } from '../decisions/service'
import { messageEffort, rankSkills } from '../decisions/uses'
import { historyStart } from './compaction'

export type { EffortMark }

// Quick decisions in a chat's setup (DC-15 and DC-16, docs/decisions.md): the
// effort each message a person sends runs at, and the order the companion's
// own skills are listed in at the first message. With the decision model off,
// unsure or slow, both are exactly what they were: the chat's effort, and the
// skills by name.

// ── effort per message (DC-15) ──

// Which models take a per-message effort lives in @shared/decisions, so Settings can say so too.
export { perMessageEffort } from '@shared/decisions'
export const PER_MESSAGE_EFFORT_BETA = 'mid-conversation-output-config-2026-07-01'

/** The promise's value, or `fallback` when it fails or `ms` pass first. */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([promise.catch(() => fallback), late]).finally(() => clearTimeout(timer))
}

/** The effort for one message, never later than the use's time limit (counted from now). */
export function decideEffort(message: string, previousReply: string, rule: Effort, isPrivate: boolean): Promise<Effort> {
  return within(messageEffort(message, previousReply, rule, isPrivate), DECISION_TIMEOUTS.effort, rule)
}

/** The text of the newest reply in a history, so "yes, go ahead" after a plan reads as the work it starts. */
export function lastReplyText(messages: readonly BetaMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim()
    if (text) return text
  }
  return ''
}

/** The effort in effect at the end of a history: the newest mark its requests still send, else the chat's. */
export function effortInEffect(history: readonly BetaMessageParam[], marks: readonly EffortMark[] | undefined, base: Effort): Effort {
  const from = historyStart(history)
  return marks?.filter((m) => m.at >= from && m.at < history.length).at(-1)?.effort ?? base
}

/**
 * The marks after a typed message at `at` that runs at `effort`. A message
 * away from the chat's effort always gets its own mark, so it runs at that
 * effort whether a mark holds only for the reply it follows or until the next
 * one, and after automatic compaction dropped older marks. A message at the
 * chat's effort gets one only to switch back from an earlier mark, so a chat
 * that never changes effort never gets one. Null when nothing changes.
 */
export function markEffort(history: readonly BetaMessageParam[], marks: readonly EffortMark[] | undefined, at: number, effort: Effort, base: Effort): EffortMark[] | null {
  const earlier = (marks ?? []).filter((m) => m.at < at)
  if (effort === base && effortInEffect(history.slice(0, at), earlier, base) === effort) return earlier.length === (marks?.length ?? 0) ? null : earlier
  return [...earlier, { at, effort }]
}

/** The marks that stay when a chat is cut at message `index` (edit, retry); undefined when none do. */
export function marksBefore(marks: readonly EffortMark[] | undefined, index: number): EffortMark[] | undefined {
  const kept = marks?.filter((m) => m.at < index) ?? []
  return kept.length > 0 ? kept : undefined
}

type Request = Omit<MessageCreateParamsStreaming, 'stream'>

/**
 * A request with each mark's effort-only system message right after its typed
 * message (placed there, it sets the effort of the reply to that message), and
 * the beta that reads them. Without marks the request is returned as it was.
 */
export function withEffortMarks(request: Request, history: readonly BetaMessageParam[], marks: readonly EffortMark[] | undefined): Request {
  if (!marks?.length) return request
  const after = new Map<BetaMessageParam, Effort>()
  for (const mark of marks) {
    const message = history[mark.at]
    if (message) after.set(message, mark.effort)
  }
  const messages: BetaMessageParam[] = []
  for (const message of request.messages) {
    messages.push(message)
    const effort = after.get(message)
    if (effort) messages.push({ role: 'system', output_config: { effort } })
  }
  if (messages.length === request.messages.length) return request
  return { ...request, messages, betas: [...new Set([...(request.betas ?? []), PER_MESSAGE_EFFORT_BETA])] }
}

// ── the companion's own skills (DC-16) ──

/** A skill as the system prompt lists it; `fits` is the decision model's verdict for the first message. */
export interface PromptSkill {
  name: string
  description: string
  fits?: boolean | null
}

/**
 * The skills for the first message's prompt: by name, then re-ranked by the
 * decision model when it answers in time (sure fits first, sure misfits last,
 * the rest by name). Off, private, slow or unsure: by name, unmarked.
 */
export async function rankedOwnSkills(message: string, skills: ReadonlyArray<{ name: string; description: string }>, isPrivate: boolean): Promise<PromptSkill[]> {
  const byName = [...skills].map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name))
  const ranked = await within(rankSkills(message, byName, isPrivate), DECISION_TIMEOUTS.skills, null)
  if (!ranked || ranked.every((s) => s.fits === null)) return byName
  const pool = new Map<string, PromptSkill[]>()
  for (const skill of byName) pool.set(skill.name, [...(pool.get(skill.name) ?? []), skill])
  const out = ranked.flatMap((r) => {
    const skill = pool.get(r.name)?.shift()
    return skill ? [{ ...skill, fits: r.fits }] : []
  })
  // Anything the ranking lost keeps its place at the end, so no skill is ever dropped.
  return [...out, ...[...pool.values()].flat()]
}
