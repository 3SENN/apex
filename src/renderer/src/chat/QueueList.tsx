/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { CalendarClock, CircleAlert, Mic, Pencil, RotateCw, SendHorizontal, TextQuote, WifiOff, X } from 'lucide-react'
import type { QueuedMessage } from '@shared/chats'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { Button, IconButton, cx, toast } from '../ui'
import { queueBadges, type QueueBadge } from './logic/status'
import { patchChat } from './store'

// CH-15: the visible queue above the composer. Messages (and routine runs
// aimed at this chat) go out in order; each can be edited, removed, or sent
// now, which interrupts the run. A failed one holds the queue until Retry.

export interface QueueListProps {
  chatId: string
  queued: readonly QueuedMessage[]
  editingId: string | null
  running: boolean
  onEdit(item: QueuedMessage): void
  onAct(): void
}

const BADGE_ICON: Record<QueueBadge, ReactElement> = {
  failed: <CircleAlert size={11} aria-hidden="true" />,
  offline: <WifiOff size={11} aria-hidden="true" />,
  routine: <CalendarClock size={11} aria-hidden="true" />,
  voice: <Mic size={11} aria-hidden="true" />,
  selection: <TextQuote size={11} aria-hidden="true" />,
}

const fail = (err: unknown): void => void toast.show({ message: errorText(err), tone: 'error' })

export function QueueList({ chatId, queued, editingId, running, onEdit, onAct }: QueueListProps): ReactElement | null {
  if (queued.length === 0) return null
  const remove = (id: string): void => {
    void call('chats', 'editQueued', chatId, id, null).then((next) => patchChat(chatId, { queued: next }), fail)
  }
  const sendNow = (id: string): void => {
    onAct()
    void call('chats', 'sendNow', chatId, id).catch(fail)
  }
  const retry = (id: string): void => {
    onAct()
    void call('chats', 'retryQueued', chatId, id).catch(fail)
  }
  return (
    <ul className="chat-queue" aria-label={t('chat.queue.label')}>
      {queued.map((item, i) => {
        const badges = queueBadges(item)
        return (
          <li key={item.id} className={cx('chat-queue__item', editingId === item.id && 'chat-queue__item--editing', item.failed && 'chat-queue__item--failed')}>
            <span className="chat-queue__label">{i === 0 ? t('chat.queue.next') : t('chat.queue.position', { n: i + 1 })}</span>
            <span className="chat-queue__main">
              <span className="chat-queue__text">{item.text}</span>
              {badges.length > 0 && (
                <span className="chat-queue__badges">
                  {badges.map((b) => (
                    <span key={b} className={`chat-queue__badge chat-queue__badge--${b}`}>
                      {BADGE_ICON[b]}
                      {b === 'failed' ? t('chat.queue.failed', { reason: item.failed ?? '' }) : t(b === 'offline' ? 'chat.queue.offline' : `chat.queue.source.${b}`)}
                    </span>
                  ))}
                </span>
              )}
            </span>
            {item.failed ? (
              <Button size="sm" variant="ghost" icon={<RotateCw size={12} />} onClick={() => retry(item.id)}>{t('chat.queue.retry')}</Button>
            ) : (
              <IconButton size="sm" label={running ? t('chat.queue.sendNowHint') : t('chat.queue.sendNow')} icon={<SendHorizontal />} onClick={() => sendNow(item.id)} />
            )}
            <IconButton size="sm" label={t('chat.queue.edit')} icon={<Pencil />} disabled={editingId === item.id} onClick={() => onEdit(item)} />
            <IconButton size="sm" label={t('chat.queue.remove')} icon={<X />} onClick={() => remove(item.id)} />
          </li>
        )
      })}
    </ul>
  )
}
