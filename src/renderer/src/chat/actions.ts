/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MenuItemSpec } from '@shared/menu'
import type { ChatSummary } from '@shared/services'
import { chatUrl } from '@shared/url'
import { call, errorText } from '../api'
import { confirm, menuSeparator, toast } from '../ui'
import { openExportDialog } from '../ui/ExportDialog' // CH-36
import { PROJECT_MENU_PREFIX, handleProjectMenu, projectSubmenu } from '../workspace/projectActions'
import { t } from '../i18n/useT'

// Chat actions shared by the chat page header, the side panel and All chats,
// so every menu offers the same items with the same wording.

export type ChatMenuPlace = 'header' | 'row'

export type ChatAction =
  | 'new' | 'open' | 'open-new-tab' | 'pin' | 'unpin' | 'mark-read' | 'mark-unread'
  | 'rename' | 'duplicate' | 'archive' | 'unarchive' | 'export' | 'delete'

const shortcutFor: Partial<Record<ChatAction, string>> = { new: 'Shift+CmdOrCtrl+E' }

/** The ⋯ menu (header) or row and context menu (row) for one chat. Drafts have nothing saved to copy, export or delete. */
export function chatMenu(chat: ChatSummary, place: ChatMenuPlace): MenuItemSpec[] {
  const item = (id: ChatAction, label: string, extra: Partial<MenuItemSpec> = {}): MenuItemSpec => ({
    id, label, ...(shortcutFor[id] ? { accelerator: shortcutFor[id] } : {}), ...extra,
  })
  const saved = !chat.draft
  const items: MenuItemSpec[] = []
  if (place === 'header') {
    items.push(item('new', t('chat.actions.newChat')), menuSeparator(), item('rename', t('chat.actions.rename')), item('duplicate', t('chat.actions.duplicate'), { enabled: saved }), item('open-new-tab', t('chat.actions.openInNewTab')))
  } else {
    items.push(item('open', t('chat.actions.open')), item('open-new-tab', t('chat.actions.openInNewTab')), menuSeparator(), item(chat.pinned ? 'unpin' : 'pin', chat.pinned ? t('chat.actions.unpin') : t('chat.actions.pin')))
    items.push(chat.unread ? item('mark-read', t('chat.actions.markAsRead')) : item('mark-unread', t('chat.actions.markAsUnread')))
    items.push(item('rename', t('chat.actions.rename')), item('duplicate', t('chat.actions.duplicate'), { enabled: saved }))
  }
  if (place === 'header' && saved) items.push(item(chat.pinned ? 'unpin' : 'pin', chat.pinned ? t('chat.actions.unpin') : t('chat.actions.pin')))
  items.push(item(chat.archived ? 'unarchive' : 'archive', chat.archived ? t('chat.actions.restoreFromArchive') : t('chat.actions.archive'), { enabled: saved }))
  // Move to project (the workspace submenu) and the export dialog (CH-36); private chats are never saved, so neither applies.
  if (saved && !chat.private) items.push(projectSubmenu([chat.id]))
  items.push(item('export', t('chat.actions.export'), { enabled: saved && !chat.private }), menuSeparator(), item('delete', t('chat.actions.deleteEllipsis'), { enabled: saved, danger: true }))
  return items
}

/** Menu entries for several selected chats. */
export function bulkMenu(chats: readonly ChatSummary[]): MenuItemSpec[] {
  const anyUnread = chats.some((c) => c.unread)
  const allPinned = chats.every((c) => c.pinned)
  const allArchived = chats.every((c) => c.archived)
  return [
    { id: allPinned ? 'unpin' : 'pin', label: allPinned ? t('chat.actions.unpin') : t('chat.actions.pin') },
    { id: anyUnread ? 'mark-read' : 'mark-unread', label: anyUnread ? t('chat.actions.markAsRead') : t('chat.actions.markAsUnread') },
    { id: allArchived ? 'unarchive' : 'archive', label: allArchived ? t('chat.actions.restoreFromArchive') : t('chat.actions.archive') },
    projectSubmenu(chats.map((c) => c.id)),
    { id: 'export', label: t('chat.actions.exportChats', { length: chats.length }) }, // CH-36
    menuSeparator(),
    { id: 'delete', label: t('chat.actions.deleteChats', { length: chats.length }), danger: true },
  ]
}

export interface ActionHooks {
  /** Start inline rename where the chat is shown. */
  rename?(): void
  /** Open the chat where this surface opens chats. */
  open?(): void
  /** Start a new chat on this surface. */
  newChat?(): void
  /** The chats were deleted (navigate away from them). */
  deleted?(ids: string[]): void
}

const fail = (err: unknown): void => {
  toast.show({ message: errorText(err), tone: 'error' })
}

/** Asks before deleting; resolves true when the chats were deleted. */
export async function deleteChats(chats: readonly Pick<ChatSummary, 'id' | 'title' | 'status'>[]): Promise<boolean> {
  if (chats.length === 0) return false
  const one = chats.length === 1 ? chats[0] : null
  const running = chats.some((c) => c.status === 'running' || c.status === 'needs-approval')
  const ok = await confirm({
    title: one ? t('chat.actions.delete', { title: one.title }) : t('chat.actions.deleteChats2', { length: chats.length }),
    message: `${t(one ? 'chat.actions.removeOne' : 'chat.actions.removeMany')}${running ? t('chat.actions.workStopsFirst') : ''}`,
    confirmLabel: t('chat.actions.delete2'),
    destructive: true,
  })
  if (!ok) return false
  try {
    await call('chats', 'remove', chats.map((c) => c.id))
    toast.show({ message: one ? t('chat.actions.chatDeleted') : t('chat.actions.chatsDeleted', { length: chats.length }), tone: 'success' })
    return true
  } catch (err) {
    fail(err)
    return false
  }
}

export async function runChatAction(action: string | null, chats: readonly ChatSummary[], hooks: ActionHooks = {}): Promise<void> {
  const first = chats[0]
  if (!action || !first) return
  const ids = chats.map((c) => c.id)
  try {
    // The Move to project items carry their own prefix.
    if (action.startsWith(PROJECT_MENU_PREFIX)) {
      await handleProjectMenu(action, ids)
      return
    }
    switch (action as ChatAction) {
      case 'new':
        hooks.newChat?.()
        return
      case 'open':
        if (hooks.open) hooks.open()
        else await call('pages', 'open', chatUrl(first.id))
        return
      case 'open-new-tab':
        await call('pages', 'open', chatUrl(first.id), { newTab: true })
        return
      case 'pin':
        await call('chats', 'pin', ids)
        return
      case 'unpin':
        await call('chats', 'unpin', ids)
        return
      case 'mark-read':
        await call('chats', 'markRead', ids)
        return
      case 'mark-unread':
        await call('chats', 'markUnread', ids)
        return
      case 'archive':
        await call('chats', 'archive', ids)
        toast.show({ message: chats.length === 1 ? t('chat.actions.chatArchived') : t('chat.actions.chatsArchived', { length: chats.length }), undo: () => void call('chats', 'unarchive', ids).catch(fail) })
        return
      case 'unarchive':
        await call('chats', 'unarchive', ids)
        toast.show({ message: chats.length === 1 ? t('chat.actions.chatRestored') : t('chat.actions.chatsRestored', { length: chats.length }) })
        return
      case 'rename':
        hooks.rename?.()
        return
      case 'duplicate': {
        const copy = await call('chats', 'duplicate', first.id)
        toast.show({ message: t('chat.actions.madeACopy', { title: copy.title }), tone: 'success', action: { label: t('chat.actions.open'), onAction: () => void call('pages', 'open', chatUrl(copy.id)).catch(fail) } })
        return
      }
      case 'export':
        // CH-36: the export dialog; several chats save into one folder.
        await openExportDialog({ kind: 'chat', ids, title: first.title })
        return
      case 'delete':
        if (await deleteChats(chats)) hooks.deleted?.(ids)
        return
    }
  } catch (err) {
    fail(err)
  }
}

/** Copies text, falling back to a hidden field where the clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    const ok = document.execCommand('copy')
    field.remove()
    return ok
  }
}
