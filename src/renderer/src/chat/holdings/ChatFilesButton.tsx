/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import { FolderOpen } from 'lucide-react'
import { t } from '@shared/i18n/core'
import { apex, call, errorText } from '../../api'
import { openChatFiles } from '../../files/open'
import { IconButton, toast } from '../../ui'
import './holdings.css'

// The chat header's files button (CH-28): opens the chat files modal, with a
// small count of what the chat holds. The same modal is in the chat's menu.

export function useFileCount(chatId: string): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void call('chatFiles', 'count', chatId).then(
        (n) => alive && setCount(n),
        () => alive && setCount(null),
      )
    }
    load()
    // What a chat holds changes as it reads pages, takes attachments and makes files.
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = apex.onAppEvent((e) => {
      if (!((e.type === 'chat-context' && e.chatId === chatId) || e.type === 'library-files') || timer) return
      timer = setTimeout(() => {
        timer = null
        load()
      }, 300)
    })
    return () => {
      alive = false
      off()
      if (timer) clearTimeout(timer)
    }
  }, [chatId])
  return count
}

export function showChatFiles(chatId: string, anchor?: HTMLElement | null): void {
  void openChatFiles(chatId, anchor).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
}

export function ChatFilesButton({ chatId }: { chatId: string }): ReactElement {
  const count = useFileCount(chatId)
  return (
    <span className="ch-files">
      <IconButton label={count ? `${t('files.chat.button')} (${count})` : t('files.chat.button')} aria-haspopup="dialog" icon={<FolderOpen />} onClick={(e) => showChatFiles(chatId, e.currentTarget)} />
      {count !== null && count > 0 && (
        <span className="ch-files__count" aria-hidden>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </span>
  )
}
