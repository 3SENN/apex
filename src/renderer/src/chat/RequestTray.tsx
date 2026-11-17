/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Companion } from '@shared/services'
import type { AgentControlState } from '@shared/services/chat'
import type { LogItem } from '../agentLog'
import { atelier, call, errorText, useAppEvent } from '../api'
import { t } from '../i18n/useT'
import { Button, IconButton, cx, toast, usePresenceList } from '../ui'
import { CompanionAvatar } from './CompanionAvatar'
import { useTabs } from './hooks'
import { EMPTY_TRAY, allowAllTargets, pruneTray, trayEntries, trayReduce, trayView, type Handoff, type TrayAction, type TrayEntry, type TrayState } from './logic/tray'
import { pendingRequests, requestCardFor, type PendingRequest } from './requestCards'
import { surfaceName, type Driving } from './surfaces'

// CH-38 / DS-62: one tray docked above the composer for everything waiting on
// you. One request shows at a time; with more there is a counter, previous
// and next, Allow all (for plain approvals) and Dismiss. A request grows up
// out of the composer and folds back when answered; nothing pulses.

type Approval = Extract<LogItem, { kind: 'approval' }>

// ---- hand-offs (sign-in, CAPTCHA, a tab you took over) ----

const handoffStates = new Map<string, { chatId: string; state: AgentControlState }>()
let handoffsAsked = false

/** Tabs this chat hands to you right now, from the agent-control events. */
export function useHandoffs(chatId: string): Handoff[] {
  const tabs = useTabs()
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (handoffsAsked) return
    handoffsAsked = true
    void call('agent', 'controlStates').then(
      (views) => {
        for (const v of views) handoffStates.set(v.tabId, { chatId: v.chatId, state: v.state })
        setVersion((n) => n + 1)
      },
      () => undefined,
    )
  }, [])
  useAppEvent('agent-control', (e) => {
    if (e.state === 'idle') handoffStates.delete(e.tabId)
    else handoffStates.set(e.tabId, { chatId: e.chatId, state: e.state })
    setVersion((n) => n + 1)
  })
  return useMemo(() => {
    const out: Handoff[] = []
    for (const [tabId, entry] of handoffStates) {
      if (entry.chatId !== chatId || (entry.state !== 'challenge' && entry.state !== 'taken-over')) continue
      const tab = tabs.tabs.find((x) => x.id === tabId)
      if (!tab) continue
      out.push({ tabId, title: tab.title || tab.url, state: entry.state })
    }
    return out
  }, [chatId, tabs, version])
}

// ---- the tray ----

const trayStates = new Map<string, TrayState>()

export interface RequestTrayProps {
  chatId: string
  items: readonly LogItem[]
  companion: Companion | null | undefined
  name: string
  driving: Driving
  handoffs: readonly Handoff[]
}

/** The requests waiting in a chat, as the tray lists them (also tells the composer to go single-row). */
export function useTrayEntries(chatId: string, items: readonly LogItem[], handoffs: readonly Handoff[]): TrayEntry[] {
  return useMemo(() => {
    const sourced = pendingRequests(items, chatId)
      .filter((r) => requestCardFor(r.kind))
      .map((r): TrayEntry => ({ id: r.id, kind: r.kind, data: r.data }))
    return trayEntries({ items, sourced, handoffs, approvalCard: requestCardFor('approval') !== null })
  }, [items, chatId, handoffs])
}

export function RequestTray({ chatId, items, companion, name, driving, handoffs }: RequestTrayProps): ReactElement | null {
  const entries = useTrayEntries(chatId, items, handoffs)
  const [state, setState] = useState<TrayState>(() => trayStates.get(chatId) ?? EMPTY_TRAY)
  const pruned = pruneTray(entries, state)
  useEffect(() => {
    if (pruned !== state) setState(pruned)
    trayStates.set(chatId, pruned)
  }, [pruned, state, chatId])
  const dispatch = (action: TrayAction): void => setState((s) => trayReduce(entries, s, action))
  const view = trayView(entries, pruned)
  const shown = usePresenceList(view.entry ? [view.entry] : [], (e) => e.id)
  const mirror = !driving.driving && driving.elsewhere !== null
  const approvals = allowAllTargets(entries, pruned)

  if (shown.length === 0 && view.hidden === 0) return null

  const allowAll = (): void => {
    driving.claim()
    for (const id of approvals) void atelier.agent.approve(chatId, id, true)
  }

  return (
    <div className="chat-requests" role="region" aria-label={t('chat.tray.label')}>
      {shown.map((entry) => (
        <div key={entry.key} className="chat-request" data-phase={entry.phase} role={entry.phase === 'exit' ? undefined : 'alert'}>
          <div className="chat-request__clip">
            <div className={cx('chat-request__body', requestCardFor(entry.item.kind) && 'chat-request__body--card')} inert={mirror || entry.phase === 'exit'}>
              <TrayCard entry={entry.item} chatId={chatId} companion={companion} name={name} driving={driving} mirror={mirror} onDismiss={() => dispatch({ type: 'dismiss', id: entry.item.id })} />
            </div>
          </div>
        </div>
      ))}
      {(view.total > 1 || view.hidden > 0) && (
        <div className="chat-tray__bar">
          {view.total > 1 && (
            <>
              <IconButton size="sm" label={t('chat.tray.previous')} icon={<ChevronLeft />} onClick={() => dispatch({ type: 'previous' })} />
              <span className="chat-tray__count" aria-live="polite">{t('chat.tray.count', { n: view.index + 1, total: view.total })}</span>
              <IconButton size="sm" label={t('chat.tray.next')} icon={<ChevronRight />} onClick={() => dispatch({ type: 'next' })} />
            </>
          )}
          <span className="chat-tray__spacer" />
          {view.hidden > 0 && (
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'restore' })}>
              {t('chat.tray.hidden', { count: view.hidden })} · {t('chat.tray.show')}
            </Button>
          )}
          {approvals.length > 1 && !mirror && <Button size="sm" variant="ghost" onClick={allowAll}>{t('chat.tray.allowAll')}</Button>}
        </div>
      )}
    </div>
  )
}

interface TrayCardProps {
  entry: TrayEntry
  chatId: string
  companion: Companion | null | undefined
  name: string
  driving: Driving
  mirror: boolean
  onDismiss(): void
}

function TrayCard({ entry, chatId, companion, name, driving, mirror, onDismiss }: TrayCardProps): ReactElement | null {
  const Card = requestCardFor(entry.kind)
  if (Card) {
    const request: PendingRequest = { id: entry.id, kind: entry.kind, chatId, data: entry.data }
    return <Card request={request} chatId={chatId} done={() => driving.claim()} dismiss={onDismiss} />
  }
  if (entry.kind === 'handoff') return <HandoffCard handoff={entry.data as Handoff} companion={companion} name={name} driving={driving} disabled={mirror} onDismiss={onDismiss} />
  if (entry.kind !== 'approval') return null
  const item = entry.data as Approval
  const answer = (allowed: boolean): void => {
    driving.claim()
    void atelier.agent.approve(chatId, item.id, allowed)
  }
  return (
    <>
      <CompanionAvatar companion={companion} size={20} mood="approval" mark="approval" />
      <div className="chat-request__text">
        <p className="chat-request__title">{item.description}</p>
        {item.origin && <p className="chat-request__origin">{item.origin}</p>}
        {mirror && driving.elsewhere && <p className="chat-request__elsewhere">{t('chat.tray.elsewhere', { surface: surfaceName(driving.elsewhere) })}</p>}
      </div>
      <div className="chat-request__actions">
        <Button size="sm" variant="ghost" disabled={mirror} onClick={onDismiss}>{t('chat.tray.dismiss')}</Button>
        <Button size="sm" variant="ghost" disabled={mirror} onClick={() => answer(false)}>{t('chat.tray.deny')}</Button>
        <Button size="sm" variant="primary" className="chat-co-button" disabled={mirror} onClick={() => answer(true)}>{t('chat.tray.allow')}</Button>
      </div>
    </>
  )
}

function HandoffCard({ handoff, companion, name, driving, disabled, onDismiss }: { handoff: Handoff; companion: Companion | null | undefined; name: string; driving: Driving; disabled: boolean; onDismiss(): void }): ReactElement {
  const challenge = handoff.state === 'challenge'
  const finish = async (): Promise<void> => {
    driving.claim()
    try {
      await (challenge ? call('agent', 'challengeDone', handoff.tabId) : call('agent', 'handBack', handoff.tabId))
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }
  return (
    <>
      <CompanionAvatar companion={companion} size={20} mood="approval" mark="approval" />
      <div className="chat-request__text">
        <p className="chat-request__title">{t(challenge ? 'chat.tray.handoff.challenge' : 'chat.tray.handoff.takenOver', { title: handoff.title })}</p>
        <p className="chat-request__origin">{t(challenge ? 'chat.tray.handoff.challengeBody' : 'chat.tray.handoff.takenOverBody', { name })}</p>
      </div>
      <div className="chat-request__actions">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onDismiss}>{t('chat.tray.dismiss')}</Button>
        <Button size="sm" variant="ghost" onClick={() => void atelier.tabs.activate(handoff.tabId)}>{t('chat.tray.handoff.show')}</Button>
        <Button size="sm" variant="primary" className="chat-co-button" disabled={disabled} onClick={() => void finish()}>{t(challenge ? 'chat.tray.handoff.done' : 'chat.tray.handoff.handBack')}</Button>
      </div>
    </>
  )
}
