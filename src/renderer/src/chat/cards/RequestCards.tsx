/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, Globe, ShieldCheck, Table2, TriangleAlert } from 'lucide-react'
import { AUTO_APPROVAL_MS, scopeExplanation, type AgentRequestResponse, type ApprovalScope } from '@shared/agentTools'
import type { LogItem } from '../../agentLog'
import { call, errorText } from '../../api'
import { useT, type T } from '../../i18n/useT'
import { Button, cx, showMenu, toast, useMotion } from '../../ui'
import { useChat } from '../store'
import { useCompanion } from '../hooks'
import type { RequestCardProps } from '../requestCards'
import { approvalScopes, countdownFraction, needsSecondConfirm, secondsLeft } from '../logic/requests'
import '../chatTools.css'

// The agent's request cards in the tray (CH-39, CH-42, CH-43). Each answers through
// agent.respond and then tells the tray it is done; main appends
// request-resolved, which settles the log item everywhere.

type ItemOf<K extends LogItem['kind']> = Extract<LogItem, { kind: K }>

/** Sends a decision; a failure stays on the card with a toast so you can try again. */
async function respond(chatId: string, requestId: string, response: AgentRequestResponse): Promise<boolean> {
  try {
    await call('agent', 'respond', chatId, requestId, response)
    return true
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
    return false
  }
}

function originHost(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/** The sentence a broader scope confirms; main's wording when it is there, Atelier's own fallback otherwise. */
function explain(t: T, item: ItemOf<'approval'>, scope: ApprovalScope): string {
  try {
    if (item.action) return scopeExplanation(item.action, item.origin, scope)
  } catch {
    // Main has no wording for it.
  }
  return scope === 'site' ? t('chatTools.request.scope.site', { origin: originHost(item.origin) }) : t('chatTools.request.scope.chat')
}

/** CH-39: an approval with a scope choice; broader scopes explain themselves and ask again. */
export function ApprovalScopeCard({ request, chatId, done }: RequestCardProps): ReactElement {
  const t = useT()
  const item = request.data as ItemOf<'approval'>
  const scopes = approvalScopes(item)
  const [confirming, setConfirming] = useState<ApprovalScope | null>(null)
  const [busy, setBusy] = useState(false)
  const more = useRef<HTMLButtonElement>(null)

  const answer = async (allowed: boolean, scope: ApprovalScope): Promise<void> => {
    if (busy) return
    setBusy(true)
    if (await respond(chatId, item.id, { kind: 'approval', allowed, scope })) done({ allowed, scope })
    else setBusy(false)
  }

  const pickScope = async (): Promise<void> => {
    const broader = scopes.filter((s) => s !== 'once')
    const picked = await showMenu(
      broader.map((s) => ({ id: s, label: s === 'chat' ? t('chatTools.request.allowChat') : t('chatTools.request.allowSite', { origin: originHost(item.origin) }) })),
      more.current ?? { x: 0, y: 0 },
    )
    if (picked === 'chat' || picked === 'site') setConfirming(picked)
  }

  if (confirming) {
    return (
      <div className="cd-request" role="group" aria-label={item.description}>
        <ShieldCheck size={16} className="cd-request__icon" aria-hidden="true" />
        <div className="cd-request__text">
          <p className="cd-request__title">{confirming === 'chat' ? t('chatTools.request.allowChat') : t('chatTools.request.allowSite', { origin: originHost(item.origin) })}</p>
          <p className="cd-request__detail">{explain(t, item, confirming)}</p>
        </div>
        <div className="cd-request__actions">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>{t('chatTools.request.back')}</Button>
          <Button size="sm" variant="primary" className="chat-co-button" loading={busy} data-autofocus onClick={() => void answer(true, confirming)}>{t('chatTools.request.confirm')}</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="cd-request" role="group" aria-label={item.description}>
      <ShieldCheck size={16} className="cd-request__icon" aria-hidden="true" />
      <div className="cd-request__text">
        <p className="cd-request__title">{item.description}</p>
        {item.origin && <p className="cd-request__detail">{originHost(item.origin)}</p>}
        {scopes.length === 1 && item.action && <p className="cd-request__note">{t('chatTools.request.alwaysAsk')}</p>}
      </div>
      <div className="cd-request__actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(false, 'once')}>{t('chatTools.request.deny')}</Button>
        <div className="cd-split">
          <Button size="sm" variant="primary" className={cx('chat-co-button', scopes.length > 1 && 'cd-split__main')} loading={busy} onClick={() => void answer(true, 'once')}>{t('chatTools.request.allowOnce')}</Button>
          {scopes.length > 1 && (
            <Button ref={more} size="sm" variant="primary" className="chat-co-button cd-split__more" aria-label={t('chatTools.request.moreScopes')} aria-haspopup="menu" disabled={busy} onClick={() => void pickScope()}>
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Ticks while mounted, every `ms`. */
function useTick(ms: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms, active])
  return now
}

/** CH-42: an 8 s countdown before a rule-approved action runs, with Stop and Run now. Reduced motion: a static bar and the seconds. */
export function AutoApprovalCard({ request, chatId, done }: RequestCardProps): ReactElement {
  const t = useT()
  const item = request.data as ItemOf<'auto-approval'>
  const { reduced } = useMotion()
  const [busy, setBusy] = useState<'stop' | 'run-now' | null>(null)
  const now = useTick(reduced ? 1000 : 250, busy === null)
  const seconds = secondsLeft(item.runsAt, now)
  const act = async (action: 'stop' | 'run-now'): Promise<void> => {
    if (busy) return
    setBusy(action)
    if (await respond(chatId, item.id, { kind: 'auto-approval', action })) done({ action })
    else setBusy(null)
  }
  return (
    <div className="cd-request cd-request--auto" role="group" aria-label={item.description}>
      <ShieldCheck size={16} className="cd-request__icon" aria-hidden="true" />
      <div className="cd-request__text">
        <p className="cd-request__eyebrow">{t('chatTools.auto.title')}</p>
        <p className="cd-request__title">{item.description}</p>
        <p className="cd-request__detail">{item.rule === 'site' ? t('chatTools.auto.ruleSite', { origin: originHost(item.origin) }) : t('chatTools.auto.ruleChat')}</p>
        <div className="cd-countdown" role="timer" aria-live="off">
          {/* The bar drains between ticks; under reduced motion it stays still and the seconds count down. */}
          <span className={cx('cd-countdown__bar', !reduced && 'cd-countdown__bar--live')} style={{ transform: `scaleX(${reduced ? 1 : countdownFraction(item.runsAt, now, AUTO_APPROVAL_MS)})` }} />
          <span className="cd-countdown__label">{t('chatTools.auto.countdown', { seconds })}</span>
        </div>
      </div>
      <div className="cd-request__actions">
        <Button size="sm" variant="ghost" loading={busy === 'stop'} disabled={busy !== null} onClick={() => void act('stop')}>{t('chatTools.auto.stop')}</Button>
        <Button size="sm" variant="primary" className="chat-co-button" loading={busy === 'run-now'} disabled={busy !== null} onClick={() => void act('run-now')}>{t('chatTools.auto.runNow')}</Button>
      </div>
    </div>
  )
}

/** CH-43: the first action on a new site asks: this time, this chat, always, or block. */
export function SiteAccessCard({ request, chatId, done }: RequestCardProps): ReactElement {
  const t = useT()
  const item = request.data as ItemOf<'site-access'>
  const state = useChat(chatId)
  const companion = useCompanion(state.setup?.companionId ?? state.summary?.companionId ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const choose = async (choice: 'once' | 'chat' | 'site' | 'block'): Promise<void> => {
    if (busy) return
    setBusy(choice)
    if (await respond(chatId, item.id, { kind: 'site-access', choice })) done({ choice })
    else setBusy(null)
  }
  const host = originHost(item.origin)
  return (
    <div className="cd-request" role="group" aria-label={t('chatTools.site.title', { name: companion?.name ?? '', origin: host })}>
      <Globe size={16} className="cd-request__icon" aria-hidden="true" />
      <div className="cd-request__text">
        <p className="cd-request__title">{t('chatTools.site.title', { name: companion?.name ?? '', origin: host })}</p>
        {item.action && <p className="cd-request__detail">{t('chatTools.site.action', { action: item.action })}</p>}
      </div>
      <div className="cd-request__actions cd-request__actions--wrap">
        <Button size="sm" variant="ghost" loading={busy === 'block'} disabled={busy !== null} onClick={() => void choose('block')}>{t('chatTools.site.block')}</Button>
        <Button size="sm" loading={busy === 'site'} disabled={busy !== null} onClick={() => void choose('site')}>{t('chatTools.site.always')}</Button>
        <Button size="sm" loading={busy === 'chat'} disabled={busy !== null} onClick={() => void choose('chat')}>{t('chatTools.site.chat')}</Button>
        <Button size="sm" variant="primary" className="chat-co-button" loading={busy === 'once'} disabled={busy !== null} onClick={() => void choose('once')}>{t('chatTools.site.once')}</Button>
      </div>
    </div>
  )
}

/** CH-43: a write to a local table shows the statement and its scope; destructive changes warn. */
export function TableWriteCard({ request, chatId, done }: RequestCardProps): ReactElement {
  const t = useT()
  const item = request.data as ItemOf<'table-write'>
  const [busy, setBusy] = useState<string | null>(null)
  const decide = async (allowed: boolean, scope: 'once' | 'chat'): Promise<void> => {
    if (busy) return
    setBusy(allowed ? scope : 'deny')
    if (await respond(chatId, item.id, { kind: 'table-write', allowed, scope })) done({ allowed, scope })
    else setBusy(null)
  }
  return (
    <div className={cx('cd-request', item.destructive && 'cd-request--warning')} role="group" aria-label={t('chatTools.table.title', { table: item.table })}>
      {item.destructive ? <TriangleAlert size={16} className="cd-request__icon" aria-hidden="true" /> : <Table2 size={16} className="cd-request__icon" aria-hidden="true" />}
      <div className="cd-request__text">
        <p className="cd-request__title">{t('chatTools.table.title', { table: item.table })}</p>
        <pre className="cd-request__sql" tabIndex={0}>{item.sql}</pre>
        {item.scope && <p className="cd-request__detail">{t('chatTools.table.scope', { scope: item.scope })}</p>}
        {item.destructive && <p className="cd-request__warning" role="note">{t('chatTools.table.destructive')}</p>}
      </div>
      <div className="cd-request__actions cd-request__actions--wrap">
        <Button size="sm" variant="ghost" loading={busy === 'deny'} disabled={busy !== null} onClick={() => void decide(false, 'once')}>{t('chatTools.table.deny')}</Button>
        {!item.destructive && <Button size="sm" loading={busy === 'chat'} disabled={busy !== null} onClick={() => void decide(true, 'chat')}>{t('chatTools.table.chat')}</Button>}
        <Button size="sm" variant={item.destructive ? 'danger' : 'primary'} className={item.destructive ? undefined : 'chat-co-button'} loading={busy === 'once'} disabled={busy !== null} onClick={() => void decide(true, 'once')}>{t('chatTools.table.once')}</Button>
      </div>
    </div>
  )
}
