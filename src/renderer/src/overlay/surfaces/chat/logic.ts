/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the agent-at-work surfaces say and offer, from their props. Pure, so
// the wording and the actions per state are unit-tested in node.
import { SOLVED_CONFIRM_MS } from '@shared/agentControl'
import { t, type MessageKey } from '@shared/i18n/core'
import type { AgentNoticeProps, AgentPillProps } from '@shared/overlay/chat'

export type NoticeAction = 'take-over' | 'hand-back' | 'resume' | 'solved' | 'skip' | 'open-chat' | 'beside' | 'stop'

export interface NoticeContent {
  tone: 'working' | 'paused' | 'yours' | 'challenge' | 'solved'
  title: string
  detail: string | null
  /** The emphasised action first, then the rest in order. */
  primary: NoticeAction | null
  actions: NoticeAction[]
  /** The shield was clicked: the take-over offer is called out. */
  nudged: boolean
}

export const ACTION_LABEL: Record<Exclude<NoticeAction, 'beside'>, MessageKey> = {
  'take-over': 'atWork.notice.takeOver',
  'hand-back': 'atWork.notice.handBack',
  resume: 'atWork.notice.resume',
  solved: 'atWork.notice.solvedIt',
  skip: 'atWork.notice.skipPage',
  'open-chat': 'atWork.notice.openChat',
  stop: 'atWork.notice.stop',
}

export function noticeContent(p: Pick<AgentNoticeProps, 'state' | 'activity' | 'companion' | 'solvedAt' | 'nudge'>, now: number, seenNudge = 0): NoticeContent {
  const name = p.companion.name
  const solved = p.solvedAt !== null && p.solvedAt > 0 && now - p.solvedAt < SOLVED_CONFIRM_MS
  switch (p.state) {
    case 'challenge':
      return { tone: 'challenge', title: t('atWork.notice.challenge'), detail: t('atWork.notice.challengeDetail', { name }), primary: 'solved', actions: ['skip', 'open-chat', 'stop'], nudged: false }
    case 'taken-over':
      return { tone: 'yours', title: t('atWork.notice.takenOver'), detail: t('atWork.notice.takenOverDetail', { name }), primary: 'hand-back', actions: ['open-chat', 'beside', 'stop'], nudged: false }
    case 'paused':
      return { tone: 'paused', title: t('atWork.notice.paused', { name }), detail: p.activity, primary: 'resume', actions: ['take-over', 'open-chat', 'beside', 'stop'], nudged: false }
    case 'resuming':
      if (solved) return { tone: 'solved', title: t('atWork.notice.solved', { name }), detail: null, primary: null, actions: ['open-chat', 'beside', 'stop'], nudged: false }
      return { tone: 'working', title: t('atWork.notice.resuming', { name }), detail: p.activity, primary: 'take-over', actions: ['open-chat', 'beside', 'stop'], nudged: p.nudge > seenNudge }
    case 'driving':
      return {
        tone: solved ? 'solved' : 'working',
        title: solved ? t('atWork.notice.solved', { name }) : t('atWork.notice.driving', { name }),
        detail: solved ? null : p.nudge > seenNudge ? t('atWork.notice.nudge') : p.activity,
        primary: 'take-over',
        actions: ['open-chat', 'beside', 'stop'],
        nudged: p.nudge > seenNudge,
      }
    default:
      return { tone: 'working', title: t('atWork.notice.label', { name }), detail: null, primary: null, actions: [], nudged: false }
  }
}

/** The service call behind each notice action. */
export function actionCall(action: NoticeAction, p: Pick<AgentNoticeProps, 'tabId' | 'chatId'>): { method: 'takeOver' | 'handBack' | 'resume' | 'challengeDone' | 'skipPage' | 'reveal' | 'stopTab'; args: unknown[] } {
  switch (action) {
    case 'take-over':
      return { method: 'takeOver', args: [p.tabId] }
    case 'hand-back':
      return { method: 'handBack', args: [p.tabId] }
    case 'resume':
      return { method: 'resume', args: [p.chatId] }
    case 'solved':
      return { method: 'challengeDone', args: [p.tabId] }
    case 'skip':
      return { method: 'skipPage', args: [p.tabId] }
    case 'open-chat':
      return { method: 'reveal', args: [p.tabId, 'page'] }
    case 'beside':
      return { method: 'reveal', args: [p.tabId, 'beside'] }
    case 'stop':
      return { method: 'stopTab', args: [p.tabId] }
  }
}

export function pillText(p: Pick<AgentPillProps, 'mode' | 'companion' | 'label' | 'others'>): { title: string; detail: string | null } {
  const name = p.companion.name
  const title = p.mode === 'approval' ? t('atWork.pill.approval', { name }) : t('atWork.pill.working', { name })
  const more = p.others > 0 ? t('atWork.pill.more', { count: p.others }) : null
  const detail = [p.label || null, more].filter(Boolean).join(' · ') || null
  return { title, detail }
}
