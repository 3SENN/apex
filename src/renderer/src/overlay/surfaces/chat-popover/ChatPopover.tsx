/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { CheckCheck, ExternalLink, Inbox, MessageSquarePlus, PanelLeft, PanelRight, RotateCw, Search } from 'lucide-react'
import type { ChatSummary } from '@shared/chats'
import type { ChatPopoverResult, ChatPopoverSurfaceProps } from '@shared/overlay/chat-popover'
import { chatUrl } from '@shared/url'
import { call, errorText, useAppEvent } from '../../../api'
import { chatBadge } from '../../../chat/logic/list'
import { POPOVER_FILTERS, popoverKey, popoverRows, popoverState, routineInbox, type PopoverFilter } from '../../../chat/logic/popover'
import { useT } from '../../../i18n/useT'
import { Button, IconButton, RelativeTime, SkeletonRows, StatusDot, cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import '../../../chat/chatTools.css'

// The chat-list popover from the panel header (CH-50): search,
// filters (unread, needs you, routine runs), recent chats, a routine inbox
// with Open all, Mark all read and a link to All chats. The search field
// keeps focus and drives the list (popoverKey); Tab reaches the filters and
// the footer. It answers through resolve() with a ChatPopoverResult.

type Load = { loaded: false; failed: boolean } | { loaded: true; failed: false; chats: ChatSummary[] }

export function ChatPopover({ props, resolve, close }: SurfaceComponentProps<ChatPopoverSurfaceProps['chat-popover']>): ReactElement {
  const t = useT()
  const [load, setLoad] = useState<Load>({ loaded: false, failed: false })
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PopoverFilter>('all')
  const [index, setIndex] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)

  const fetchList = useCallback(() => {
    setLoad({ loaded: false, failed: false })
    call('chats', 'list', { limit: 200 }).then(
      (chats) => setLoad({ loaded: true, failed: false, chats }),
      () => setLoad({ loaded: false, failed: true }),
    )
  }, [])
  useEffect(fetchList, [fetchList])
  useAppEvent('chats', (e) => setLoad({ loaded: true, failed: false, chats: e.items }))
  useEffect(() => field.current?.focus(), [])

  const all = load.loaded ? load.chats : []
  const rows = useMemo(() => popoverRows(all, query, filter), [all, query, filter])
  const inbox = useMemo(() => (query || filter !== 'all' ? [] : routineInbox(all)), [all, query, filter])
  const view = popoverState({ loaded: load.loaded, failed: load.failed, all: all.filter((c) => !c.draft && !c.private).length, rows: rows.length })
  const unread = all.filter((c) => c.unread).map((c) => c.id)
  // The selection follows the list; it never points past the end.
  const active = rows.length === 0 ? -1 : Math.min(Math.max(index, 0), rows.length - 1)
  useEffect(() => setIndex(0), [query, filter])

  const answer = (result: ChatPopoverResult): void => resolve(result)
  const act = (run: () => Promise<unknown>): void => {
    setActionError(null)
    run().catch((err: unknown) => setActionError(errorText(err)))
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    const result = popoverKey({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, { index: active, count: rows.length, query, filter })
    switch (result.type) {
      case 'none':
        return
      case 'move':
        setIndex(result.index)
        document.getElementById(`cd-pop-row-${result.index}`)?.scrollIntoView({ block: 'nearest' })
        break
      case 'open': {
        const chat = rows[result.index]
        if (chat) answer({ kind: 'open', chatId: chat.id, newTab: result.newTab })
        break
      }
      case 'filter':
        setFilter(result.filter)
        break
      case 'clear-query':
        setQuery('')
        break
      case 'close':
        close()
        break
    }
    e.preventDefault()
    e.stopPropagation()
  }

  let list: ReactElement
  if (view.kind === 'loading') list = <div className="cd-pop__state"><SkeletonRows rows={5} /></div>
  else if (view.kind === 'error')
    list = (
      <div className="cd-pop__state" role="alert">
        <p>{t('chatTools.popover.error')}</p>
        <Button size="sm" variant="secondary" icon={<RotateCw size={13} />} onClick={fetchList}>{t('chatTools.popover.retry')}</Button>
      </div>
    )
  else if (view.kind === 'empty') list = <div className="cd-pop__state"><p>{t('chatTools.popover.empty')}</p></div>
  else if (view.kind === 'no-matches') list = <div className="cd-pop__state" role="status"><p>{t('chatTools.popover.noMatches')}</p></div>
  else
    list = (
      <ul className="cd-pop__list" id="cd-pop-list" role="listbox" aria-label={t('chatTools.popover.title')}>
        {inbox.length > 0 && (
          <li role="presentation">
            <div className="cd-pop__group cd-pop__group-row">
              <span>
                <Inbox size={12} aria-hidden="true" /> {t('chatTools.popover.inbox')} · {inbox.length}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  act(async () => {
                    for (const c of inbox) await call('pages', 'open', chatUrl(c.id), { newTab: true })
                    close()
                  })
                }
              >
                {t('chatTools.popover.openAll')}
              </Button>
            </div>
          </li>
        )}
        {rows.map((chat, i) => {
          const badge = chatBadge(chat)
          return (
            <li
              key={chat.id}
              id={`cd-pop-row-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx('cd-pop__row', chat.id === props.chatId && 'cd-pop__row--current')}
              onPointerMove={() => i !== active && setIndex(i)}
              onClick={(e) => answer({ kind: 'open', chatId: chat.id, newTab: e.metaKey || e.ctrlKey })}
            >
              {badge ? <StatusDot status={badge.status} label={badge.label} size={7} /> : <span style={{ width: 7 }} aria-hidden="true" />}
              <span className="cd-pop__title">{chat.title}</span>
              <span className="cd-pop__when"><RelativeTime value={chat.lastActiveAt} /></span>
            </li>
          )
        })}
      </ul>
    )

  return (
    <div className="cd-pop" role="dialog" aria-label={t('chatTools.popover.title')}>
      <div className="cd-pop__search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={field}
          className="cd-pop__field"
          type="search"
          value={query}
          placeholder={t('chatTools.popover.search')}
          aria-label={t('chatTools.popover.search')}
          role="combobox"
          aria-expanded={view.kind === 'rows'}
          aria-controls="cd-pop-list"
          aria-activedescendant={active >= 0 && view.kind === 'rows' ? `cd-pop-row-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value.slice(0, 200))}
          onKeyDown={onKey}
        />
      </div>
      <div className="cd-pop__filters" role="group" aria-label={t('chatTools.popover.title')}>
        {POPOVER_FILTERS.map((f) => (
          <button key={f} type="button" className="cd-pop__filter" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`chatTools.popover.filter.${f}`)}
          </button>
        ))}
      </div>
      {list}
      {actionError && <p className="cd-pop__state" role="alert">{actionError}</p>}
      <div className="cd-pop__foot">
        <Button size="sm" variant="ghost" icon={<MessageSquarePlus size={13} />} onClick={() => answer({ kind: 'new' })}>{t('chatTools.popover.newChat')}</Button>
        {props.panel && (
          <span>
            <IconButton size="sm" label={t('chat.panel.popOut')} icon={<ExternalLink />} disabled={!props.panel.canPopOut} onClick={() => answer({ kind: 'pop-out' })} />
            <IconButton size="sm" label={props.panel.dock === 'left' ? t('chat.panel.dockRight') : t('chat.panel.dockLeft')} icon={props.panel.dock === 'left' ? <PanelRight /> : <PanelLeft />} onClick={() => answer({ kind: 'dock' })} />
          </span>
        )}
        <span>
          <Button size="sm" variant="ghost" icon={<CheckCheck size={13} />} disabled={unread.length === 0} onClick={() => act(() => call('chats', 'markRead', unread))}>{t('chatTools.popover.markAllRead')}</Button>
          <Button size="sm" variant="ghost" onClick={() => answer({ kind: 'all' })}>{t('chatTools.popover.allChats')}</Button>
        </span>
      </div>
    </div>
  )
}
