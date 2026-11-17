/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { AppWindow, Globe, Maximize2, PanelRightClose, X } from 'lucide-react'
import type { TabInfo, TabsSnapshot } from '@shared/ipc'
import { chatUrl, parseInternalUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { t } from '../i18n/useT'
import { Button, IconButton, cx, toast } from '../ui'
import { useTabs } from './hooks'
import { NO_HELD_CHATS, canHoldChat, heldChatOf, type HeldChats } from './logic/inTab'
import { holdChatInTab, releaseChatInTab, useHeldChats } from './surfaces'
import { useChat, type ChatState } from './store'

// CH-33 and SH-32: the tabs a chat used. The details panel lists them
// (Switch, Close, Close all); while the chat shows pages beside it, a small
// strip in the toolbar switches the page beside it, expands it or hides it.

const fail = (err: unknown): void => void toast.show({ message: errorText(err), tone: 'error' })

/** The open tabs a chat used, in the order it used them (its own chat page left out). */
export function usedTabs(state: Pick<ChatState, 'usedTabIds'>, tabs: readonly TabInfo[], exclude?: string | null): TabInfo[] {
  return state.usedTabIds.flatMap((id) => (id === exclude ? [] : tabs.filter((tab) => tab.id === id)))
}

function Favicon({ tab }: { tab: TabInfo }): ReactElement {
  return tab.favicon ? <img className="chat-tabs__favicon" src={tab.favicon} alt="" draggable={false} /> : <Globe size={13} className="chat-tabs__favicon" aria-hidden="true" />
}

/**
 * The "routine and tabs used" section's tab rows (DS-124 #5). The details
 * panel (CH-35) mounts it; it draws nothing while the chat used no open tab.
 */
export function TabsUsedSection({ chatId, state }: { chatId: string; state: ChatState }): ReactElement | null {
  const snapshot = useTabs()
  const used = usedTabs(state, snapshot.tabs)
  if (used.length === 0) return null
  const busy = state.log.status !== 'idle'
  return (
    <div className="chat-tabs" role="group" aria-label={t('chat.tabs.section')}>
      <ul className="chat-tabs__list">
        {used.map((tab) => {
          const title = tab.title || tab.url
          const inUse = state.tabIds.includes(tab.id)
          return (
            <li key={tab.id} className={cx('chat-tabs__row', tab.id === snapshot.activeId && 'chat-tabs__row--active')}>
              <button type="button" className="chat-tabs__switch" title={t('chat.tabs.switch', { title })} onClick={() => void apex.tabs.activate(tab.id)}>
                <Favicon tab={tab} />
                <span className="chat-tabs__title">{title}</span>
                {inUse && <span className="chat-tabs__state">{t('chat.tabs.inUse')}</span>}
              </button>
              <IconButton size="sm" label={t('chat.tabs.close', { title })} icon={<X />} disabled={inUse && busy} onClick={() => void call('chats', 'closeTabsUsed', chatId, [tab.id]).catch(fail)} />
            </li>
          )
        })}
      </ul>
      {used.length > 1 && (
        <Button size="sm" variant="ghost" icon={<AppWindow size={13} />} disabled={busy} onClick={() => void call('chats', 'closeTabsUsed', chatId).catch(fail)}>
          {t('chat.tabs.closeAll')}
        </Button>
      )}
    </div>
  )
}

export interface ChatBeside {
  chatId: string
  chatTabId: string
  pageTabId: string
  /** DS-65: the chat and its page share one tab (expanded from the panel), not a split. */
  inTab: boolean
}

/**
 * The chat beside a page: the active tab holding a chat beside its own page
 * (DS-65), or the chat page in a split and the page beside it. Null otherwise.
 */
export function chatBeside(snapshot: Pick<TabsSnapshot, 'split' | 'tabs'> & { activeId?: string | null }, held: HeldChats = NO_HELD_CHATS): ChatBeside | null {
  const heldHere = heldChatOf(held, snapshot.activeId)
  if (heldHere && snapshot.activeId) return { chatId: heldHere, chatTabId: snapshot.activeId, pageTabId: snapshot.activeId, inTab: true }
  const split = snapshot.split
  if (!split) return null
  for (const [chatTabId, pageTabId] of [[split.primaryId, split.secondaryId], [split.secondaryId, split.primaryId]] as const) {
    const tab = snapshot.tabs.find((x) => x.id === chatTabId)
    const route = tab ? parseInternalUrl(tab.url) : null
    if (route?.page === 'chat' && route.id) return { chatId: route.id, chatTabId, pageTabId, inTab: false }
  }
  return null
}

/**
 * SH-32 and CH-33's side-by-side strip: while a chat shows a page
 * beside it, a thin divider, then that chat's pages (the one beside it marked),
 * expand (the page on its own) and hide (the chat on its own).
 */
export function ChatPagesCluster({ snapshot }: { snapshot: TabsSnapshot }): ReactElement | null {
  const beside = chatBeside(snapshot, useHeldChats())
  if (!beside) return null
  return <ChatPages beside={beside} snapshot={snapshot} />
}

function ChatPages({ beside, snapshot }: { beside: ChatBeside; snapshot: TabsSnapshot }): ReactElement | null {
  const state = useChat(beside.chatId)
  // In one tab (DS-65) the chat can move only to another website's tab.
  const pages = usedTabs(state, snapshot.tabs, beside.chatTabId).filter((tab) => (beside.inTab ? canHoldChat(tab.url) : !parseInternalUrl(tab.url)))
  const shown = snapshot.tabs.find((tab) => tab.id === beside.pageTabId)
  // The page beside the chat always shows, even when the chat never acted on it.
  const list = shown && !pages.some((p) => p.id === shown.id) ? [shown, ...pages] : pages
  if (list.length === 0) return null
  const showBeside = (pageId: string): void => {
    if (pageId === beside.pageTabId) return
    // DS-65: in one tab, the chat moves to the other page's tab and that tab comes forward.
    if (beside.inTab) {
      holdChatInTab(pageId, beside.chatId)
      void apex.tabs.activate(pageId).catch(fail)
      return
    }
    void call('split', 'openWith', beside.chatTabId, pageId).catch(fail)
  }
  const expand = async (): Promise<void> => {
    if (beside.inTab) return releaseChatInTab(beside.pageTabId)
    await call('split', 'close').catch(fail)
    await apex.tabs.activate(beside.pageTabId)
  }
  const hide = async (): Promise<void> => {
    // DS-65: the page keeps its tab and the chat opens as a page of its own.
    if (beside.inTab) {
      releaseChatInTab(beside.pageTabId)
      await call('pages', 'open', chatUrl(beside.chatId)).catch(fail)
      return
    }
    await call('split', 'close').catch(fail)
    await apex.tabs.activate(beside.chatTabId)
  }
  return (
    <div className="chat-pages" role="group" aria-label={t('chat.pages.label')}>
      <span className="chat-pages__divider" aria-hidden="true" />
      {list.slice(0, 5).map((tab) => {
        const title = tab.title || tab.url
        const current = tab.id === beside.pageTabId
        return (
          <button key={tab.id} type="button" className={cx('chat-pages__page', current && 'chat-pages__page--current')} aria-pressed={current} title={t('chat.pages.show', { title })} onClick={() => showBeside(tab.id)}>
            <Favicon tab={tab} />
            <span className="ui-sr-only">{t('chat.pages.show', { title })}</span>
          </button>
        )
      })}
      <IconButton size="sm" label={t('chat.pages.expand')} icon={<Maximize2 />} onClick={() => void expand()} />
      <IconButton size="sm" label={t('chat.pages.hide')} icon={<PanelRightClose />} onClick={() => void hide()} />
    </div>
  )
}
