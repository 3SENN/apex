/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'
import type { TabsSnapshot } from '@shared/ipc'
import { chatUrl } from '@shared/url'
import { apex, call, errorText } from '../../api'
import { confirm, toast } from '../../ui'
import { chatIdOfUrl } from './logic/order'
import { openExportDialog } from '../../ui/ExportDialog' // CH-36
import { PROJECT_MENU_PREFIX, handleProjectMenu, projectSubmenu } from '../../workspace/projectActions' // Move to project
import { setChatProjectMenu } from './logic/menus'
import { t } from '../../i18n/useT'

setChatProjectMenu(projectSubmenu) // The chat menu's Move to project submenu

// What the sidebar's chat rows do: open, close and the chat menu (CH-47).

/** Tabs that show this chat as a page. */
export function chatTabs(snapshot: TabsSnapshot, chatId: string): string[] {
  return snapshot.tabs.filter((t) => chatIdOfUrl(t.url) === chatId).map((t) => t.id)
}

/** Shows the chat: its tab when one is open, otherwise a new tab next to the current one. */
export function openChatPage(snapshot: TabsSnapshot, chatId: string, { newTab = false, background = false } = {}): void {
  const existing = newTab ? undefined : chatTabs(snapshot, chatId)[0]
  if (existing) void apex.tabs.activate(existing)
  else void call('pages', 'open', chatUrl(chatId), { newTab: true, background })
}

const report = (what: string) => (err: unknown): void => {
  toast.show({ message: `${what}: ${errorText(err)}`, tone: 'error' })
}

export interface ChatMenuHandlers {
  snapshot: TabsSnapshot
  /** Starts inline rename on the row. */
  rename(chatId: string): void
  /** Takes the rows out of the Chats section (their tabs close too). */
  close(chatIds: string[]): void
}

/** Runs a chat-menu choice for one or several chats. */
export async function runChatMenu(id: string, chats: readonly ChatSummary[], { snapshot, rename, close }: ChatMenuHandlers): Promise<void> {
  const ids = chats.map((c) => c.id)
  const first = chats[0]
  if (!first) return
  // The Move to project items carry their own prefix.
  if (id.startsWith(PROJECT_MENU_PREFIX)) {
    await handleProjectMenu(id, ids).catch(report(t('tabs.sidebarChatActions.couldnTMoveThe')))
    return
  }
  switch (id) {
    case 'open':
      openChatPage(snapshot, first.id)
      break
    case 'open-new-tab':
      openChatPage(snapshot, first.id, { newTab: true })
      break
    case 'pin':
      await call('chats', 'pin', ids).catch(report(t('tabs.sidebarChatActions.couldnTPin')))
      break
    case 'unpin':
      await call('chats', 'unpin', ids).catch(report(t('tabs.sidebarChatActions.couldnTUnpin')))
      break
    case 'mark-read':
      await call('chats', 'markRead', ids).catch(report(t('tabs.sidebarChatActions.couldnTMarkAs')))
      break
    case 'mark-unread':
      await call('chats', 'markUnread', ids).catch(report(t('tabs.sidebarChatActions.couldnTMarkAs2')))
      break
    case 'rename':
      rename(first.id)
      break
    case 'duplicate':
      try {
        const copy = await call('chats', 'duplicate', first.id)
        toast.show({ message: t('tabs.sidebarChatActions.madeACopy', { title: copy.title || t('tabs.sidebarChatActions.newChat') }), tone: 'success', action: { label: t('tabs.sidebarChatActions.open'), onAction: () => openChatPage(snapshot, copy.id) } })
      } catch (err) {
        report(t('tabs.sidebarChatActions.couldnTDuplicateThe'))(err)
      }
      break
    case 'archive':
      try {
        await call('chats', 'archive', ids)
        toast.show({ message: ids.length === 1 ? t('tabs.sidebarChatActions.chatArchivedFindIt') : t('tabs.sidebarChatActions.chatsArchived', { length: ids.length }), undo: () => void call('chats', 'unarchive', ids) })
      } catch (err) {
        report(t('tabs.sidebarChatActions.couldnTArchive'))(err)
      }
      break
    case 'unarchive':
      await call('chats', 'unarchive', ids).catch(report(t('tabs.sidebarChatActions.couldnTRestore')))
      break
    case 'export':
      // CH-36: the export dialog; several chats save into a folder.
      await openExportDialog({ kind: 'chat', ids, title: first.title })
      break
    case 'close':
      close(ids)
      break
    case 'delete': {
      const one = ids.length === 1
      const ok = await confirm({
        title: one ? t('tabs.sidebarChatActions.deleteOne', { title: first.title || t('tabs.sidebarChatActions.newChat') }) : t('tabs.sidebarChatActions.deleteChats', { length: ids.length }),
        message: one ? t('tabs.sidebarChatActions.theConversationIsRemoved') : t('tabs.sidebarChatActions.theseConversationsAreRemoved'),
        confirmLabel: one ? t('tabs.sidebarChatActions.deleteChat') : t('tabs.sidebarChatActions.deleteChats2', { length: ids.length }),
        destructive: true,
      })
      if (!ok) return
      for (const chatId of ids) for (const tabId of chatTabs(snapshot, chatId)) void apex.tabs.close(tabId)
      await call('chats', 'remove', ids).catch(report(t('tabs.sidebarChatActions.couldnTDelete')))
      break
    }
  }
}
