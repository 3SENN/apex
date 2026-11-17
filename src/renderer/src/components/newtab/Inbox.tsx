/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Bell, CheckCheck, CircleAlert, MessageCircleQuestionMark, Repeat } from 'lucide-react'
import type { ChatSummary } from '@shared/chats'
import type { Routine, RoutineRun } from '@shared/routines'
import { atelier, call, relativeTime, useLiveList } from '../../api'
import { IconButton, showPopoverMenu, type PopoverItem } from '../../ui'
import { buildInbox, inboxUnread, type InboxItem } from './newtabLogic'
import { useT } from '../../i18n/useT'

// The start surface's notifications (DS-112): a 38 px round button that opens
// an in-window inbox of pending approvals and routine results, newest first,
// with mark-read. An unread dot sits on the button while anything is new.

const RUNS_SHOWN = 20

function useRuns(): [RoutineRun[], () => void] {
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const reload = (): void => {
    void (call('routines', 'runs', { limit: RUNS_SHOWN }) as Promise<{ runs: RoutineRun[] }>).then(
      (r) => setRuns(r.runs),
      () => setRuns([]),
    )
  }
  useEffect(() => {
    reload()
    return atelier.onAppEvent((e) => {
      if (e.type === 'routine-runs') reload()
    })
  }, [])
  return [runs, reload]
}

function glyphFor(item: InboxItem): ReactElement {
  if (item.kind === 'approval') return <MessageCircleQuestionMark aria-hidden />
  if (item.status === 'error') return <CircleAlert aria-hidden />
  return <Repeat aria-hidden />
}

export function InboxButton({ className }: { className?: string }): ReactElement {
  const t = useT()
  const [chats] = useLiveList<ChatSummary, 'chats'>(() => (call('chats', 'list', { limit: 200 }) as Promise<ChatSummary[]>).catch(() => []), 'chats', (e) => e.items)
  const [routines] = useLiveList<Routine, 'routines'>(() => (call('routines', 'list') as Promise<Routine[]>).catch(() => []), 'routines', (e) => e.items)
  const [runs, reloadRuns] = useRuns()
  const items = useMemo(
    () => buildInbox({ chats, runs, routineNames: new Map(routines.map((r) => [r.id, r.name])) }),
    [chats, runs, routines],
  )
  const unread = inboxUnread(items)

  const open = async (anchor: HTMLElement): Promise<void> => {
    const now = Date.now()
    const approvals = items.filter((i) => i.kind === 'approval')
    const results = items.filter((i) => i.kind === 'routine')
    const row = (i: InboxItem): PopoverItem => ({
      id: i.id,
      label: i.title,
      description: `${i.detail} · ${relativeTime(i.at, now)}`,
      icon: glyphFor(i),
      strong: i.unread,
      trailing: i.unread ? <span className="nt-inbox__dot" aria-label={t('tabs.newTabInbox.unread')} /> : undefined,
    })
    const list: PopoverItem[] =
      items.length === 0
        ? [{ id: 'empty', label: t('tabs.newTabInbox.nothingNew'), description: t('tabs.newTabInbox.routineResultsAndApprovals'), disabled: true }]
        : [
            ...(approvals.length ? [{ id: 'h:approvals', label: t('tabs.newTabInbox.waitingForYou'), kind: 'header' as const }, ...approvals.map(row)] : []),
            ...(results.length ? [{ id: 'h:results', label: t('tabs.newTabInbox.routineResults'), kind: 'header' as const }, ...results.map(row)] : []),
            ...(results.some((r) => r.unread) ? [{ id: 'sep', label: '', kind: 'separator' as const }, { id: 'mark-read', label: t('tabs.newTabInbox.markAllAsRead'), icon: <CheckCheck aria-hidden /> }] : []),
          ]
    const choice = await showPopoverMenu(list, anchor, { label: t('tabs.newTabInbox.notifications'), width: 320, align: 'end', gap: 6, rowHeight: 44, className: 'nt-inbox' })
    if (!choice) return
    if (choice === 'mark-read') {
      await call('routines', 'markRunsRead').catch(() => undefined)
      return reloadRuns()
    }
    const item = items.find((i) => i.id === choice)
    if (item?.chatId) void call('pages', 'open', `atelier://chat/${item.chatId}`)
    else if (item?.kind === 'routine') void call('pages', 'open', 'atelier://routines')
  }

  return (
    <span className={['nt-inbox-button', className].filter(Boolean).join(' ')}>
      <IconButton
        label={unread > 0 ? `Notifications, ${unread} new` : t('tabs.newTabInbox.notifications')}
        icon={<Bell />}
        className="nt__round"
        aria-haspopup="menu"
        onClick={(e) => void open(e.currentTarget)}
      />
      {unread > 0 && <span className="nt-inbox-button__dot" aria-hidden="true" />}
    </span>
  )
}
