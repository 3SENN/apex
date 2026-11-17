/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, type ReactElement } from 'react'
import { chatUrl } from '@shared/url'
import { apex } from '../api'
import '../chat/chat.css'
import { ChatHeader } from '../chat/ChatHeader'
import { ChatView } from '../chat/ChatView'
import { collapseToPanel, holdChatInTab, releaseChatInTab } from '../chat/surfaces'
import { useCompanion, useTabs } from '../chat/hooks'
import { messageAnchor } from '../chat/logic/anchor' // CH-13
import { DetailsPanel } from '../chat/DetailsPanel' // CH-33
import { useDetailsStore } from '../chat/detailsStore'
import { useChat } from '../chat/store'
import { useShell } from '../components/shellContext'
import { MOTION, useLayerPresence } from '../ui' // DS-123: the panel's exit
import { useDetailsAutoOpen } from '../chat/DetailsSections' // CH-35: the extra sections and the panel opening once by itself

/**
 * apex://chat/<id>: the conversation in one centred column, composer at the bottom, header floating over it.
 * `held` (DS-65): the chat was expanded from the panel and shows in a website's tab, its page beside it.
 */
export function ChatPage({ chatId, tabId, held = false }: { chatId: string; tabId: string; held?: boolean }): ReactElement {
  const shell = useShell()
  // New chats and companion switches replace the chat in this tab (beside its page, while held).
  const show = useCallback((id: string) => (held ? holdChatInTab(tabId, id) : void apex.nav.go(tabId, chatUrl(id))), [tabId, held])
  // CH-13: apex://chat/<id>#<message> scrolls to the message and highlights it.
  const url = useTabs().tabs.find((t) => t.id === tabId)?.url ?? ''
  const anchor = held ? null : messageAnchor(url)
  const state = useChat(chatId)
  const details = useDetailsStore().open && state.phase === 'ready'
  // DS-123: hiding keeps the panel mounted through its exit, fading and sliding out while the column glides back.
  const presence = useLayerPresence(details, MOTION.layout)
  const companion = useCompanion(state.setup?.companionId ?? state.summary?.companionId ?? null)
  useDetailsAutoOpen(chatId, state.log.items)
  return (
    <div className="chat-page" data-details={details ? '' : undefined}>
      <ChatView
        key={chatId}
        chatId={chatId}
        surfaceId={`page:${tabId}`}
        variant="page"
        anchor={anchor}
        onChangeChat={show}
        header={({ state, companion, mood, newChat }) => (
          <ChatHeader
            chatId={chatId}
            state={state}
            companion={companion}
            mood={mood}
            hooks={{ newChat, deleted: () => (held ? releaseChatInTab(tabId) : void apex.nav.go(tabId, 'apex://chats')) }}
            onCollapse={() => void collapseToPanel(chatId, tabId, shell.openPanel)}
          />
        )}
      />
      {presence !== 'closed' && (
        <DetailsPanel chatId={chatId} state={state} companion={companion} leaving={presence === 'closing'} /* CH-33 */ />
      )}
    </div>
  )
}
