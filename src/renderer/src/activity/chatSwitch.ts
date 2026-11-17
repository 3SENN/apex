/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// CH-21: the + menu's activity-memory switch for one chat. It
// shows only while activity memory is on and the chat isn't private, and
// flips search_activity for this chat in place (the menu stays open).
import { useEffect, useState } from 'react'
import { t } from '@shared/i18n/core'
import { call, errorText } from '../api'
import { useChat } from '../chat/store'
import type { MenuRow } from '../chat/logic/addMenu'
import { toast } from '../ui'
import { activityRows } from './logic'
import './activity.css'

export { ACTIVITY_ROW_ID } from './logic'

export function useActivityChatRow(chatId: string): { rows: MenuRow[]; toggle(): void } {
  const chat = useChat(chatId)
  const isPrivate = chat.summary?.private === true || chat.setup?.private === true
  const [state, setState] = useState<{ enabled: boolean; included: boolean } | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([call('activity', 'settings'), call('activity', 'chatIncluded', chatId)]).then(
      ([settings, included]) => live && setState({ enabled: settings.enabled, included }),
      // Without an answer the switch stays hidden; nothing else in the menu depends on it.
      () => live && setState(null),
    )
    return () => {
      live = false
    }
  }, [chatId])

  const toggle = (): void => {
    if (!state) return
    const next = !state.included
    setState({ ...state, included: next })
    call('activity', 'includeInChat', chatId, next).catch((err: unknown) => {
      setState((s) => (s ? { ...s, included: !next } : s))
      toast.show({ tone: 'error', message: errorText(err) })
    })
  }

  return { rows: activityRows(state, isPrivate, t('memory.activity.chatSwitch')), toggle }
}
