/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { ChevronsUpDown, Maximize2, PanelLeftClose, PanelRightClose } from 'lucide-react'
import type { MenuItemSpec } from '@shared/menu'
import { PANEL_WIDTH } from '@shared/ipc'
import { atelier, call, errorText } from '../api'
import '../chat/chat.css'
import { ChatChip, ChatMoreButton } from '../chat/ChatHeader'
import { ChatSkeleton } from '../chat/ChatLog'
import { ChatView, newDraftChat, type ChatViewContext } from '../chat/ChatView'
import { useChatList, useSettingsView } from '../chat/hooks'
import { chatBadge } from '../chat/logic/list'
import { expandToPage, surfaceName } from '../chat/surfaces'
import { ErrorState, IconButton, Seam, menuSeparator, showMenu, toast } from '../ui'
import { t } from '../i18n/useT' // CH-03
// CH-50
import type { ChatPopoverResult } from '@shared/overlay/chat-popover'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import { openInChrome } from '../overlay/kit/chromeHost'
import { chatPopoverModule } from '../overlay/surfaces/chat-popover'
import { chatUrl } from '@shared/url'
import '../chat/register'
import { discardPrivateChat } from '../chat/ChatBanners'

export interface AgentPanelProps {
  /** The chat to attach; null keeps the panel's own chat (or starts a fresh one). */
  chatId: string | null
  /** The companion a fresh chat starts with. */
  companionId: string
  /** Fallback when the handoff can't find the chat's tab: App opens the chat as a page. */
  onExpand(chatId: string): void
  onClose(): void
}

// The panel remembers its chat across ⌘J (it unmounts while closed) and
// chrome reloads. ⇧⌘E always starts it on a fresh chat; the listener is
// registered at import, so it runs before App opens the panel.
const PANEL_CHAT_KEY = 'atelier.panel-chat'
let panelChat: string | null = readPanelChat()
/** The last chat App asked for; kept here so reopening the panel doesn't undo a switch made inside it. */
let appliedRequest: string | null = null
let panelVersion = 0
let creating: Promise<string | null> | null = null

/** One draft at a time, even when effects run twice. */
function freshPanelChat(companionId: string | undefined): Promise<string | null> {
  creating ??= newDraftChat(companionId).finally(() => {
    creating = null
  })
  return creating
}
const panelListeners = new Set<() => void>()

function readPanelChat(): string | null {
  try {
    return sessionStorage.getItem(PANEL_CHAT_KEY)
  } catch {
    return null
  }
}

function setPanelChat(id: string | null): void {
  if (panelChat === id) return
  panelChat = id
  panelVersion++
  try {
    if (id) sessionStorage.setItem(PANEL_CHAT_KEY, id)
    else sessionStorage.removeItem(PANEL_CHAT_KEY)
  } catch {
    // Storage can be unavailable; the panel still works for this session.
  }
  for (const listener of panelListeners) listener()
}

atelier.onCommand((command) => {
  if (command === 'new-chat') setPanelChat(null)
})

const subscribePanel = (listener: () => void): (() => void) => {
  panelListeners.add(listener)
  return () => panelListeners.delete(listener)
}

/** The side panel: one chat beside the page, with a switcher and an expand-to-page button. */
export function AgentPanel({ chatId, companionId, onExpand, onClose }: AgentPanelProps): ReactElement {
  useSyncExternalStore(subscribePanel, () => panelVersion)
  // A chat App asks for shows from the first render; switching inside the panel wins after that.
  const requested = chatId && chatId !== appliedRequest ? chatId : null
  const attached = requested ?? panelChat
  const [failed, setFailed] = useState(false)
  const settings = useSettingsView()
  const [width, setWidth] = useState(settings.panelWidth)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    // A cleared request lets the same chat be asked for again later.
    if (!chatId) appliedRequest = null
    if (!chatId || chatId === appliedRequest) return
    appliedRequest = chatId
    setPanelChat(chatId)
  }, [chatId])

  useEffect(() => {
    if (!dragging) setWidth(settings.panelWidth)
  }, [settings.panelWidth, dragging])

  // No chat yet: start a draft for the panel's companion.
  useEffect(() => {
    if (attached || failed) return
    let live = true
    void freshPanelChat(companionId || undefined).then((id) => {
      if (!live) return
      if (id) setPanelChat(id)
      else setFailed(true)
    })
    return () => {
      live = false
    }
  }, [attached, failed, companionId])

  const attach = useCallback((id: string) => setPanelChat(id), [])
  // DS-65: the chat moves to a page (beside this one) and the panel closes.
  const expand = useCallback(
    (id: string) => {
      void expandToPage(id).then((tabId) => {
        if (!tabId) onExpand(id)
      })
      onClose()
    },
    [onExpand, onClose],
  )

  return (
    <aside className="chat-panel" style={{ width }} aria-label={t('chat.agentPanel.companionPanel')} data-dock={settings.panelDock /* CH-03 */}>
      <Seam
        className="chat-panel__seam"
        value={width}
        min={PANEL_WIDTH.min}
        max={PANEL_WIDTH.max}
        reverse={settings.panelDock !== 'left'}
        resetTo={PANEL_WIDTH.default}
        label={t('chat.agentPanel.resizeTheCompanionPanel')}
        valueText={(v) => t('chat.agentPanel.pixelsWide', { v })}
        onChange={setWidth}
        onDragChange={setDragging}
        onCommit={(value) => void atelier.settings.set({ panelWidth: value })}
      />
      {attached ? (
        <ChatView
          key={attached}
          chatId={attached}
          surfaceId="panel"
          variant="panel"
          onChangeChat={attach}
          newChatCompanionId={companionId || undefined}
          header={(context) => <PanelHeader chatId={attached} context={context} onAttach={attach} onExpand={expand} onClose={onClose} />}
        />
      ) : failed ? (
        <div className="chat-view chat-view--panel">
          <PanelBar onClose={onClose} />
          <div className="chat-view__state">
            <ErrorState title={t('chat.agentPanel.couldnTStartA')} message={t('chat.agentPanel.atelierCouldNotCreate')} onRetry={() => setFailed(false)} />
          </div>
        </div>
      ) : (
        <div className="chat-view chat-view--panel">
          <PanelBar onClose={onClose} />
          <div className="chat-view__state chat-view__state--loading"><ChatSkeleton rows={3} label={t('chat.agentPanel.startingAChat')} /></div>
        </div>
      )}
    </aside>
  )
}

function PanelBar({ onClose }: { onClose(): void }): ReactElement {
  const left = useSettingsView().panelDock === 'left' // CH-03
  return (
    <header className="chat-panel__header">
      <span className="chat-panel__spacer" />
      <IconButton label={t('chat.agentPanel.hidePanel')} shortcut="CmdOrCtrl+J" icon={left ? <PanelLeftClose /> : <PanelRightClose />} onClick={onClose} />
    </header>
  )
}

interface PanelHeaderProps {
  chatId: string
  context: ChatViewContext
  onAttach(id: string): void
  onExpand(chatId: string): void
  onClose(): void
}

/** DS-64: the same floating chip as the chat page (face, title, status word), plus switch, expand, ⋯ and hide. */
function PanelHeader({ chatId, context, onAttach, onExpand, onClose }: PanelHeaderProps): ReactElement {
  const { state, companion, name, driving, mood, newChat } = context
  const [renaming, setRenaming] = useState(false)
  const chats = useChatList()
  const summary = state.summary
  const dock = useSettingsView().panelDock // CH-03

  const status = (() => {
    if (driving.elsewhere) return driving.elsewhere === 'panel' ? t('chat.agentPanel.followingPanel') : t('chat.agentPanel.followingPage')
    if (state.phase === 'missing') return t('chat.agentPanel.notFound')
    if (state.log.status === 'running' && state.queued.length > 0) return t('chat.agentPanel.workingQueued', { count: state.queued.length })
    return undefined
  })()

  // CH-50: the chat-list popover; the native menu below stays as the fallback.
  const openPopover = async (el: HTMLElement): Promise<void> => {
    const props = { chatId: summary?.draft ? null : chatId, panel: { canPopOut: state.phase === 'ready' && !summary?.draft, dock } }
    const anchor = anchorFromElement(el)
    let result
    try {
      result = await openSurface('chat-popover', anchor, props)
    } catch {
      result = await openInChrome(chatPopoverModule, props, anchor, { anchorEl: el })
    }
    if (!('value' in result) || !result.value) return
    const picked = result.value as ChatPopoverResult
    // CH-30: leaving a private chat with something in it asks first, then discards it.
    const leaving = (picked.kind === 'open' && !picked.newTab && picked.chatId !== chatId) || picked.kind === 'new'
    if (leaving && summary?.private && !summary.draft && !(await discardPrivateChat(chatId, state.log.items.length > 0))) return
    switch (picked.kind) {
      case 'open':
        if (picked.newTab) void call('pages', 'open', chatUrl(picked.chatId), { newTab: true }).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
        else onAttach(picked.chatId)
        return
      case 'new':
        newChat()
        return
      case 'all':
        void call('pages', 'open', 'atelier://chats')
        return
      case 'pop-out':
        try {
          await call('windows', 'openChat', chatId)
          onClose()
        } catch (err) {
          toast.show({ message: errorText(err), tone: 'error' })
        }
        return
      case 'dock':
        void atelier.settings.set({ panelDock: dock === 'left' ? 'right' : 'left' })
        return
    }
  }

  const openSwitcher = async (anchor: Element): Promise<void> => {
    const recent = (chats ?? []).filter((c) => !c.archived).slice(0, 10)
    const items: MenuItemSpec[] = [
      { id: 'new', label: t('chat.agentPanel.newChat'), accelerator: 'Shift+CmdOrCtrl+E' },
      menuSeparator(),
      ...recent.map((c): MenuItemSpec => {
        const mark = chatBadge(c)
        return { id: `chat:${c.id}`, label: mark ? `${c.title} · ${mark.label}` : c.title, type: 'radio', checked: c.id === chatId }
      }),
      ...(recent.length > 0 ? [menuSeparator()] : []),
      { id: 'all', label: t('chat.agentPanel.allChats'), accelerator: 'Shift+CmdOrCtrl+L' },
      // Pop out into a chat window, and the side the panel docks on
      menuSeparator(),
      { id: 'pop-out', label: t('chat.panel.popOut'), enabled: state.phase === 'ready' && !summary?.draft },
      { id: 'dock', label: dock === 'left' ? t('chat.panel.dockRight') : t('chat.panel.dockLeft') },
    ]
    const picked = await showMenu(items, anchor)
    if (picked === 'pop-out') {
      try {
        await call('windows', 'openChat', chatId)
        onClose()
      } catch (err) {
        toast.show({ message: errorText(err), tone: 'error' })
      }
      return
    }
    if (picked === 'dock') {
      void atelier.settings.set({ panelDock: dock === 'left' ? 'right' : 'left' })
      return
    }
    if (picked === 'new') newChat()
    else if (picked === 'all') void call('pages', 'open', 'atelier://chats')
    else if (picked?.startsWith('chat:')) onAttach(picked.slice(5))
  }

  return (
    <header className="chat-panel__header">
      <ChatChip chatId={chatId} state={state} companion={companion} mood={mood} renaming={renaming} onRenamingChange={setRenaming} fallbackTitle={name} status={status} />
      <span className="chat-panel__spacer" />
      <IconButton label={t('chat.agentPanel.switchChat')} icon={<ChevronsUpDown />} aria-haspopup="dialog" onClick={(e) => {
        const el = e.currentTarget
        void openPopover(el).catch(() => openSwitcher(el)) /* CH-50 */
      }} />
      <IconButton label={t('chat.agentPanel.openAsAPage')} tooltip={t('chat.agentPanel.openAsAPage2')} icon={<Maximize2 />} disabled={state.phase !== 'ready'} onClick={() => onExpand(chatId)} />
      {summary && <ChatMoreButton summary={summary} hooks={{ newChat, rename: () => setRenaming(true), deleted: newChat }} />}
      <IconButton label={t('chat.agentPanel.hidePanel')} shortcut="CmdOrCtrl+J" icon={dock === 'left' ? <PanelLeftClose /> : <PanelRightClose />} onClick={onClose} />
    </header>
  )
}
