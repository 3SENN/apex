/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatAgentEvent, QueuedMessage } from '@shared/chats'

// A main-side copy of the chat events the chrome gets, so the voice HUD can
// preview the reply to a command and count its queue (MV-04, MV-05). The
// bootstrap calls `event` and `queue` next to its own sends; nothing here
// changes what the chrome sees.

type EventListener = (envelope: ChatAgentEvent) => void
type QueueListener = (chatId: string, queued: QueuedMessage[]) => void

const eventListeners = new Set<EventListener>()
const queueListeners = new Set<QueueListener>()

function each<A extends unknown[]>(listeners: Set<(...a: A) => void>, ...args: A): void {
  for (const fn of [...listeners]) {
    try {
      fn(...args)
    } catch {
      // A listener's failure never reaches the agent.
    }
  }
}

export const voiceChatTap = {
  event(envelope: ChatAgentEvent): void {
    if (eventListeners.size) each(eventListeners, envelope)
  },
  queue(chatId: string, queued: QueuedMessage[]): void {
    if (queueListeners.size) each(queueListeners, chatId, queued)
  },
  onEvent(fn: EventListener): () => void {
    eventListeners.add(fn)
    return () => {
      eventListeners.delete(fn)
    }
  },
  onQueue(fn: QueueListener): () => void {
    queueListeners.add(fn)
    return () => {
      queueListeners.delete(fn)
    }
  },
}
