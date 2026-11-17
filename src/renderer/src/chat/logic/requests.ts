/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ALWAYS_ASK, type ApprovalScope, type QuestionSpec } from '@shared/agentTools'
import type { LogItem } from '../../agentLog'

// Agent requests in the chat tray (CH-39, CH-42, CH-43, CH-44): which log items are
// still waiting on you, the scopes an approval may offer, the auto-approval
// countdown, and the question card's answers. Pure, so the rules are tested.

/** The shape of PendingRequest (chat/requestCards.ts), kept here so this module stays pure. */
export interface PendingRequestShape {
  id: string
  kind: 'approval' | 'auto-approval' | 'site-access' | 'table-write' | 'question'
  chatId: string
  data: LogItem
}

/** Requests that wait for an answer, oldest first. */
export function agentToolRequests(items: readonly LogItem[], chatId: string): PendingRequestShape[] {
  const out: PendingRequestShape[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'approval':
        if (item.resolved === null) out.push({ id: item.id, kind: 'approval', chatId, data: item })
        break
      case 'auto-approval':
      case 'site-access':
      case 'table-write':
      case 'question':
        if (item.outcome === null) out.push({ id: item.id, kind: item.kind, chatId, data: item })
        break
      default:
        break
    }
  }
  return out
}

/** Whether any request is waiting: tips and other hints stay out of the way meanwhile. */
export function hasPendingRequest(items: readonly LogItem[]): boolean {
  return agentToolRequests(items, '').length > 0
}

type ApprovalItem = Extract<LogItem, { kind: 'approval' }>

/** CH-39: payments and security changes always ask once; otherwise what main offered, once at least. */
export function approvalScopes(item: Pick<ApprovalItem, 'action' | 'scopes'>): ApprovalScope[] {
  if (item.action && ALWAYS_ASK.has(item.action)) return ['once']
  const offered = (item.scopes ?? []).filter((s, i, all) => all.indexOf(s) === i)
  return offered.includes('once') ? offered : ['once', ...offered]
}

/** Broader scopes need a second confirmation. */
export const needsSecondConfirm = (scope: ApprovalScope): boolean => scope !== 'once'

/** CH-42: whole seconds left before a rule-approved action runs (never below zero). */
export function secondsLeft(runsAt: number, now: number): number {
  return Math.max(0, Math.ceil((runsAt - now) / 1000))
}

/** The countdown bar's fill, 1 at the start and 0 when it runs. */
export function countdownFraction(runsAt: number, now: number, totalMs: number): number {
  if (totalMs <= 0) return 0
  return Math.min(1, Math.max(0, (runsAt - now) / totalMs))
}

// ---- the question card (CH-44, DS-63) ----

export type Answer = string | string[] | null

export interface QuestionState {
  index: number
  answers: Record<string, Answer>
  /** Free text per question, kept apart so picking an option doesn't lose it. */
  other: Record<string, string>
  skipped: string[]
  submitted: boolean
}

export function initialQuestionState(): QuestionState {
  return { index: 0, answers: {}, other: {}, skipped: [], submitted: false }
}

export type QuestionAction =
  | { type: 'pick'; id: string; option: string; multi: boolean }
  | { type: 'other'; id: string; text: string }
  | { type: 'next'; total: number }
  | { type: 'prev' }
  | { type: 'go'; index: number; total: number }
  | { type: 'skip'; id: string; total: number }
  | { type: 'submit' }

const clampIndex = (i: number, total: number): number => Math.max(0, Math.min(Math.max(0, total - 1), i))

export function reduceQuestions(state: QuestionState, action: QuestionAction): QuestionState {
  // Locked after submit.
  if (state.submitted) return state
  switch (action.type) {
    case 'pick': {
      const current = state.answers[action.id]
      let next: Answer
      if (action.multi) {
        const list = Array.isArray(current) ? current : []
        next = list.includes(action.option) ? list.filter((o) => o !== action.option) : [...list, action.option]
        if (next.length === 0) next = null
      } else {
        next = current === action.option ? null : action.option
      }
      return { ...state, answers: { ...state.answers, [action.id]: next }, skipped: state.skipped.filter((s) => s !== action.id) }
    }
    case 'other':
      return { ...state, other: { ...state.other, [action.id]: action.text }, skipped: action.text.trim() ? state.skipped.filter((s) => s !== action.id) : state.skipped }
    case 'next':
      return { ...state, index: clampIndex(state.index + 1, action.total) }
    case 'prev':
      return { ...state, index: clampIndex(state.index - 1, 1 + state.index) }
    case 'go':
      return { ...state, index: clampIndex(action.index, action.total) }
    case 'skip': {
      const answers = { ...state.answers }
      delete answers[action.id]
      const other = { ...state.other }
      delete other[action.id]
      const skipped = state.skipped.includes(action.id) ? state.skipped : [...state.skipped, action.id]
      return { ...state, answers, other, skipped, index: clampIndex(state.index + 1, action.total) }
    }
    case 'submit':
      return { ...state, submitted: true }
  }
}

/** One question's answer: a picked option (or several), else the typed text, else null. */
export function answerFor(state: QuestionState, question: QuestionSpec): Answer {
  if (state.skipped.includes(question.id)) return null
  const picked = state.answers[question.id] ?? null
  const typed = state.other[question.id]?.trim() ?? ''
  if (question.multi) {
    const list = Array.isArray(picked) ? picked : picked ? [picked] : []
    const all = typed ? [...list, typed] : list
    return all.length > 0 ? all : null
  }
  if (typed) return typed
  return typeof picked === 'string' ? picked : null
}

export function answeredCount(state: QuestionState, questions: readonly QuestionSpec[]): number {
  return questions.reduce((n, q) => (answerFor(state, q) === null ? n : n + 1), 0)
}

/** What agent.respond carries: every question, null where skipped or left empty. */
export function questionAnswers(state: QuestionState, questions: readonly QuestionSpec[]): Array<{ id: string; answer: Answer }> {
  return questions.map((q) => ({ id: q.id, answer: answerFor(state, q) }))
}

/**
 * What a routine proposal's Save sends to routines.save: the draft as the
 * companion proposed it, switched on. A draft carries no `enabled`, and
 * pressing Save is saying yes to it, so the routine runs.
 */
export function proposalSaveInput<D extends object>(draft: D): D & { enabled: true } {
  return { ...draft, enabled: true }
}
