/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { NotificationHandle, NotifySpec } from '@shared/notifications'
import { attention } from '../attention'
import type { ChatStore } from '../chats'
import { mainT } from '../i18n/mainT'
import { notifications } from '../notifications'
import type { AgentHost } from './host'
import { lastQuestion, plainSnippet } from './preview'

// The chat producers: approvals and questions ask for you, finished
// and failed runs report back, routine runs report their result, and the
// Dock badge follows unread chats. The notification presenter drops what the switches,
// a muted chat or a chat on screen say to drop.

export interface RunEnd {
  summary: ChatSummary
  companionName: string
  reply: string
}

/** What a finished or failed run notifies, or null (still running, stopped by you). */
export function runEndNotice(end: RunEnd): Omit<NotifySpec, 'onAction'> | null {
  const { summary, companionName: name } = end
  const target = { chatId: summary.id }
  if (summary.status === 'error') {
    return { category: summary.routineId ? 'routine-results' : 'chat-updates', title: mainT('chat.notify.failed', { name }), body: summary.title, target }
  }
  if (summary.status !== 'finished') return null
  if (summary.routineId) return { category: 'routine-results', title: mainT('chat.notify.routineDone', { title: summary.title }), body: plainSnippet(end.reply) || summary.title, target }
  if (summary.needsInput) return { category: 'needs-you', title: mainT('chat.notify.question', { name }), body: lastQuestion(end.reply) || summary.title, target }
  return { category: 'chat-updates', title: mainT('chat.notify.finished', { name }), body: plainSnippet(end.reply) || summary.title, target }
}

/** Unread chats for the Dock badge, and chats waiting on you. */
export function attentionCounts(chats: readonly ChatSummary[]): { unread: number; needsYou: number } {
  let unread = 0
  let needsYou = 0
  for (const chat of chats) {
    if (chat.archived || chat.draft) continue
    if (chat.unread) unread++
    if (chat.needsInput || chat.status === 'needs-approval') needsYou++
  }
  return { unread, needsYou }
}

export function installChatAttention(deps: { host: AgentHost; chats: ChatStore | null }): { dispose(): void } {
  const { host, chats } = deps
  const approvals = new Map<string, NotificationHandle>()
  const running = new Set<string>()
  const replies = new Map<string, string>()

  const nameOf = (chatId: string): string => host.companionLook(host.companionOf(chatId)).name

  const onEvent = (chatId: string, event: AgentEvent): void => {
    switch (event.type) {
      case 'approval': {
        const handle = notifications.notify({
          category: 'needs-you',
          title: mainT('chat.notify.approval', { name: nameOf(chatId) }),
          body: event.description,
          target: { chatId },
          actions: ['allow', 'deny'],
          sticky: true,
          onAction: (action) => {
            if (action === 'allow' || action === 'deny') host.approve(chatId, event.approvalId, action === 'allow')
          },
        })
        approvals.set(event.approvalId, handle)
        attention.request()
        break
      }
      case 'approval-resolved':
        approvals.get(event.approvalId)?.clear()
        approvals.delete(event.approvalId)
        break
      case 'text-delta':
        replies.set(chatId, (replies.get(chatId) ?? '') + event.text)
        break
      case 'user-message':
      case 'reset':
        replies.delete(chatId)
        break
      case 'status':
        if (event.status !== 'idle') {
          if (!running.has(chatId)) replies.delete(chatId)
          running.add(chatId)
          break
        }
        if (!running.delete(chatId)) break
        // The summary is saved before the idle status goes out.
        queueMicrotask(() => {
          const summary = chats?.summary(chatId)
          if (!summary || host.isRunning(chatId)) return
          const notice = runEndNotice({ summary, companionName: nameOf(chatId), reply: replies.get(chatId) ?? '' })
          replies.delete(chatId)
          if (notice && !summary.muted && !host.isViewed(chatId)) {
            notifications.notify(notice)
            if (notice.category === 'needs-you') attention.request()
          }
        })
        break
      default:
        break
    }
  }

  const offControl = host.onControl((signal) => {
    if (signal.kind === 'event') onEvent(signal.chatId, signal.event)
  })
  const syncCounts = (items: ChatSummary[]): void => {
    const counts = attentionCounts(items)
    attention.setUnread(counts.unread)
    attention.setNeedsYou(counts.needsYou)
  }
  chats?.on('changed', syncCounts)
  if (chats) syncCounts(chats.list())

  return {
    dispose() {
      offControl()
      chats?.off('changed', syncCounts)
      for (const handle of approvals.values()) handle.clear()
      approvals.clear()
    },
  }
}
