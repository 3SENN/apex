/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { ShieldCheck, ZapIcon } from 'lucide-react'
import type { ChatSummary } from '@shared/chats'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { cx, toast } from '../ui'
import { patchChat } from './store'

// CH-18: the chat's permission mode. Ask first is the default (new chats start
// from the global setting in main); act without asking shows as a badge while
// it is on. Guarded password, one-time-code and payment fields stay blocked
// either way: main's guard decides that, not this toggle.

/** Turns the chat's act-without-asking mode on or off, optimistically (the composer chip's switch row and the badge). */
export async function setActWithoutAsking(chatId: string, summary: ChatSummary, next: boolean): Promise<void> {
  patchChat(chatId, { summary: { ...summary, actWithoutAsking: next } })
  try {
    await call('chats', 'setActWithoutAsking', chatId, next)
  } catch (err) {
    patchChat(chatId, { summary: { ...summary, actWithoutAsking: !next } })
    toast.show({ message: errorText(err), tone: 'error' })
  }
}

/** DS-125: at rest the control row has no shield; while the mode is on, a badge says so and turns it off. */
export function ModeToggle({ chatId, summary, name, compact = false }: { chatId: string; summary: ChatSummary | null; name: string; compact?: boolean }): ReactElement | null {
  const [busy, setBusy] = useState(false)
  if (!summary || summary.imported) return null
  const on = summary.actWithoutAsking ?? false
  if (compact && !on) return null
  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await setActWithoutAsking(chatId, summary, !on)
    } finally {
      setBusy(false)
    }
  }
  const label = on ? t('chat.mode.turnOff') : t('chat.mode.turnOn', { name })
  return (
    <button
      type="button"
      className={cx('chat-mode', on && 'chat-mode--on')}
      aria-pressed={on}
      aria-label={`${on ? t('chat.mode.badge') : t('chat.mode.ask')}. ${label}`}
      title={`${label}. ${t('chat.mode.note')}`}
      disabled={busy}
      onClick={() => void toggle()}
    >
      {on ? <ZapIcon size={13} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
      {on && <span className="chat-mode__label">{t('chat.mode.badge')}</span>}
    </button>
  )
}
