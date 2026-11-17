/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import type { ChatsServiceAdditions } from '@shared/services/chat'
import { DraftStore } from '../drafts'
import type { AppContext } from '../features/types'
import { installChatAttention } from './chatAttention'

// The chat feature's methods on the chats namespace: previews, continue,
// interrupt and the queue, the chat's mode, tabs used, paging, drafts and
// save retry. The at-work feature supplies quote and askAbout.

export type ChatFeatureMethods = Omit<ChatsServiceAdditions, 'quote' | 'askAbout'>

export interface ChatFeatureServices {
  chats: ChatFeatureMethods
  dispose(): void
}

export function createChatServices(app: AppContext): ChatFeatureServices {
  const host = app.agent
  const drafts = new DraftStore(app.dataDir)
  const store = app.maintenance?.chats
  // Deleted chats lose their drafts.
  const onRemoved = (ids: string[]): void => drafts.remove(ids)
  store?.on('removed', onRemoved)
  // SS-05: every window hears when a chat can't be saved, and when it can again.
  const offSave = host.onSaveState((chatId, error) => app.broadcast({ type: 'chat-save-state', chatId, error }))
  const attention = installChatAttention({ host, chats: store ?? null })

  const chats: ChatFeatureMethods = {
    preview: (id) => host.preview(id),
    continue: (id) => host.continue(id),
    interrupt: (id, text) => host.interrupt(id, text),
    sendNow: (id, queuedId) => host.sendNow(id, queuedId),
    retryQueued: (id, queuedId) => host.retryQueued(id, queuedId),
    setActWithoutAsking: (id, on) => void host.setActWithoutAsking(id, on),
    setMuted: (id, muted) => void host.setMuted(id, muted),
    tabsUsed: (id) => host.tabsUsed(id),
    closeTabsUsed: (id, tabIds) => void host.closeTabsUsed(id, tabIds),
    older: (id, before, limit) => host.older(id, before, limit),
    draft: (id) => drafts.get(id),
    setDraft: (id, text) => drafts.set(id, text),
    retrySave: (id) => {
      if (!host.retrySave(id)) throw new Error(`${BRAND_NAME} still couldn’t save this chat.`)
    },
  }

  return {
    chats,
    dispose() {
      drafts.flush()
      store?.off('removed', onRemoved)
      offSave()
      attention.dispose()
    },
  }
}
