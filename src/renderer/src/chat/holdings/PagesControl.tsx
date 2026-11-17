/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { Globe } from 'lucide-react'
import type { ChatContextPage } from '@shared/chatContext'
import { faviconStack } from '@shared/filesLogic'
import type { TabsSnapshot } from '@shared/ipc'
import { t } from '@shared/i18n/core'
import { parseInternalUrl } from '@shared/url'
import { atelier, call, errorText } from '../../api'
import { openFilesSurface } from '../../files/open'
import { useCompanions } from '../../settings/data'
import { cx, toast } from '../../ui'
import { useChat } from '../store'
import { chatBeside } from '../TabsUsed'
import { NO_HELD_CHATS, type HeldChats } from '../logic/inTab' // DS-65
import { useHeldChats } from '../surfaces'
import './holdings.css'

// Pages in this chat (CH-34), the toolbar half: while the active surface is
// a chat that has pages, a stack of up to three favicons and a count. It
// opens the chat-pages-menu surface, which lists them with thumbnails.

/** The chat the toolbar is showing: the active chat tab, or the chat beside a page (in its tab, DS-65, or a split). */
export function activeChatId(snapshot: Pick<TabsSnapshot, 'split' | 'tabs' | 'activeId'>, held: HeldChats = NO_HELD_CHATS): string | null {
  const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeId)
  const route = active ? parseInternalUrl(active.url) : null
  if (route?.page === 'chat' && route.id) return route.id
  return chatBeside(snapshot, held)?.chatId ?? null
}

function usePages(chatId: string): ChatContextPage[] {
  const [pages, setPages] = useState<ChatContextPage[]>([])
  useEffect(() => {
    let alive = true
    setPages([])
    // Without the chat context service, the call fails and the control stays hidden.
    void call('chatContext', 'list', chatId).then(
      (items) => alive && setPages(items),
      () => undefined,
    )
    const off = atelier.onAppEvent((e) => {
      if (e.type === 'chat-context' && e.chatId === chatId) setPages(e.pages)
    })
    return () => {
      alive = false
      off()
    }
  }, [chatId])
  return pages
}

function Control({ chatId }: { chatId: string }): ReactElement | null {
  const pages = usePages(chatId)
  const chat = useChat(chatId)
  const companions = useCompanions()
  const [open, setOpen] = useState(false)
  const { icons, count } = faviconStack(pages)
  if (count === 0) return null
  const driving = pages.some((p) => p.controlled)
  const accent = companions.items?.find((c) => c.id === chat.summary?.companionId)?.look.colors.accent
  const label = t('files.pages.count', { count })
  const show = (el: HTMLElement): void => {
    setOpen(true)
    void openFilesSurface('chat-pages-menu', accent ? { chatId, accent } : { chatId }, el)
      .catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
      .finally(() => setOpen(false))
  }
  return (
    <button
      type="button"
      className={cx('ch-pages', driving && 'ch-pages--driving', open && 'ch-pages--open')}
      aria-label={label}
      title={t('files.pages.button')}
      aria-haspopup="listbox"
      aria-expanded={open}
      style={accent ? ({ '--ch-glow': accent } as CSSProperties) : undefined}
      onClick={(e) => show(e.currentTarget)}
    >
      <span className="ch-pages__stack" aria-hidden>
        {icons.map((icon) => (
          <span key={icon.key} className="ch-pages__icon">
            {icon.favicon ? <img src={icon.favicon} alt="" draggable={false} /> : <Globe />}
          </span>
        ))}
      </span>
      <span className="ch-pages__count" aria-hidden>
        {count}
      </span>
    </button>
  )
}

/** Mounted in the toolbar's chat-pages slot; draws nothing unless a chat with pages is showing. */
export function ChatPagesControl({ snapshot }: { snapshot: TabsSnapshot }): ReactElement | null {
  const chatId = activeChatId(snapshot, useHeldChats())
  return chatId ? <Control chatId={chatId} /> : null
}
