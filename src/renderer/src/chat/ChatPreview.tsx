/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState, type ReactElement } from 'react'
import { CheckCheck, Maximize2, SendHorizontal, X } from 'lucide-react'
import type { ChatSummary } from '@shared/chats'
import { atelier, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, ErrorState, IconButton, SkeletonRows, Spinner, toast } from '../ui'
import { previewMessages } from './logic/bulk'
import { markdownText, parseMarkdown } from './logic/markdown'
import { markSent, reloadChat, useChat } from './store'
import './chatTools.css'

// All chats' preview pane (CH-49): the chosen chat's latest messages beside
// the list, with a running indicator, Mark as read, Open in full and a reply
// box. ↑/↓ in the list move it (AllChats owns the selection).

const plain = (markdown: string): string => markdownText(parseMarkdown(markdown))

export function ChatPreview({ chat, companionName, onOpen, onClose }: { chat: ChatSummary | null; companionName: string; onOpen(chat: ChatSummary): void; onClose(): void }): ReactElement {
  const t = useT()
  const state = useChat(chat?.id ?? null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const messages = useMemo(() => previewMessages(state.log.items, plain), [state.log.items])

  if (!chat) {
    return (
      <aside className="cd-preview" aria-label={t('chatTools.preview.label')}>
        <p className="cd-preview__empty">{t('chatTools.preview.empty')}</p>
      </aside>
    )
  }

  const running = state.log.status !== 'idle'
  const readOnly = chat.imported !== null || chat.private
  const send = async (): Promise<void> => {
    const text = reply.trim()
    if (!text || sending) return
    setSending(true)
    markSent(chat.id)
    try {
      await atelier.agent.send(chat.id, text)
      setReply('')
    } catch (err) {
      markSent(chat.id, false)
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setSending(false)
    }
  }

  return (
    <aside className="cd-preview" aria-label={`${t('chatTools.preview.label')}: ${chat.title}`}>
      <div className="cd-preview__head">
        <h2 className="cd-preview__title" title={chat.title}>{chat.title}</h2>
        {running && (
          <span className="cd-preview__running" role="status">
            <Spinner size={11} />
            {t('chatTools.preview.running')}
          </span>
        )}
        {chat.unread && <IconButton size="sm" label={t('chatTools.preview.markRead')} icon={<CheckCheck />} onClick={() => void call('chats', 'markRead', chat.id).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))} />}
        <IconButton size="sm" label={t('chatTools.preview.open')} icon={<Maximize2 />} onClick={() => onOpen(chat)} />
        <IconButton size="sm" label={t('chatTools.preview.close')} icon={<X />} onClick={onClose} />
      </div>
      <div className="cd-preview__body" tabIndex={0} aria-live="polite">
        {state.phase === 'loading' && <SkeletonRows rows={4} />}
        {(state.phase === 'missing' || state.phase === 'failed') && <ErrorState title={t('chatTools.popover.error')} {...(state.phase === 'failed' ? { onRetry: () => reloadChat(chat.id) } : {})} />}
        {state.phase === 'ready' && messages.length === 0 && <p className="cd-preview__empty">{t('chatTools.preview.noMessages')}</p>}
        {state.phase === 'ready' &&
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'cd-preview__msg cd-preview__msg--you' : 'cd-preview__msg'}>
              <p className="cd-preview__who">{m.role === 'user' ? t('chatTools.export.you') : companionName}</p>
              <p className="cd-preview__text">{m.text}</p>
            </div>
          ))}
      </div>
      {readOnly ? (
        <p className="cd-preview__empty" style={{ flex: 'none', padding: 'var(--space-3)' }}>{t('chatTools.preview.readOnly')}</p>
      ) : (
        <form
          className="cd-preview__reply"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <textarea
            className="cd-preview__input"
            rows={1}
            value={reply}
            placeholder={t('chatTools.preview.reply', { name: companionName })}
            aria-label={t('chatTools.preview.reply', { name: companionName })}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
              // Keys typed here stay here; the list's ↑/↓ don't move the preview.
              e.stopPropagation()
            }}
          />
          <Button type="submit" size="sm" variant="primary" icon={<SendHorizontal size={13} />} loading={sending} disabled={!reply.trim()}>{t('chatTools.preview.send')}</Button>
        </form>
      )}
    </aside>
  )
}
