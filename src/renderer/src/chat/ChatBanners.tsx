/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import { CalendarClock, CornerUpLeft, EyeOff, FileInput, Play, ShieldOff } from 'lucide-react'
import type { ApprovalMode } from '@shared/agentTools'
import type { ChatSummary } from '@shared/chats'
import { chatUrl, routineUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, RelativeTime, StatusDot, confirm, cx, toast } from '../ui'
import { useChatList, useRoutines } from './hooks'
import type { ChatState } from './store'
import './chatTools.css'

// Chat-level notes at the top of a chat (lead slot in ChatView): the routine
// run header (SK-12), the private-chat indicator (CH-30), the imported
// transcript banner (CH-31), a sub-task's link back to its parent (CH-32),
// and "Don't ask is on" (ST-12, from the agent-mode event).

const fail = (err: unknown): void => {
  toast.show({ message: errorText(err), tone: 'error' })
}

// ---- the approval mode, shared by every chat view in the window ----

let mode: ApprovalMode = 'standard'
let modeLoaded = false
const modeListeners = new Set<() => void>()

function startMode(): void {
  if (modeLoaded) return
  modeLoaded = true
  void call('agent', 'approvalMode').then(
    (m) => {
      mode = m
      for (const l of modeListeners) l()
    },
    () => undefined,
  )
  apex.onAppEvent((event) => {
    if (event.type !== 'agent-mode') return
    mode = event.mode
    for (const l of modeListeners) l()
  })
}

export function useApprovalMode(): ApprovalMode {
  const [, bump] = useState(0)
  useEffect(() => {
    startMode()
    const l = (): void => bump((n) => n + 1)
    modeListeners.add(l)
    return () => void modeListeners.delete(l)
  }, [])
  return mode
}

/** SK-12: which routine ran, when and why, its status, Open routine and Run again. */
export function RoutineRunHeader({ summary }: { summary: ChatSummary }): ReactElement | null {
  const t = useT()
  const routines = useRoutines()
  const [busy, setBusy] = useState(false)
  if (!summary.routineId) return null
  const routine = routines?.find((r) => r.id === summary.routineId)
  const deleted = routines !== null && !routine
  const run = summary.routineRun
  const status = summary.status
  const tone = status === 'running' ? 'working' : status === 'error' ? 'error' : status === 'needs-approval' ? 'needs-input' : status === 'finished' ? 'success' : 'idle'
  const again = async (): Promise<void> => {
    if (!summary.routineId || busy) return
    setBusy(true)
    try {
      await call('routines', 'runNow', summary.routineId)
      toast.show({ message: t('chatTools.routineRun.started'), tone: 'success' })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="cd-banner cd-banner--routine" aria-label={t('chatTools.routineRun.label')}>
      <CalendarClock size={16} className="cd-banner__icon" aria-hidden="true" />
      <div className="cd-banner__text">
        <p className="cd-banner__eyebrow">{t('chatTools.routineRun.label')}</p>
        <p className="cd-banner__title">{routine?.name ?? summary.title}</p>
        <p className="cd-banner__meta">
          <span>
            {t('chatTools.routineRun.ran', { when: '' }).trim()} <RelativeTime value={summary.createdAt} />
            {run && <> · {t('chatTools.routineRun.scheduled', { when: new Date(run.scheduledFor).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) })}</>}
          </span>
          {run && <span>{t(`chatTools.routineRun.trigger.${run.trigger}`)}</span>}
          <span className="cd-banner__status">
            <StatusDot status={tone} label="" size={6} pulse={false} />
            {t(`chatTools.routineRun.status.${status}`)}
          </span>
        </p>
        {deleted && <p className="cd-banner__meta">{t('chatTools.routineRun.deleted')}</p>}
      </div>
      {!deleted && (
        <div className="cd-banner__actions">
          <Button size="sm" variant="ghost" onClick={() => summary.routineId && void call('pages', 'open', routineUrl(summary.routineId)).catch(fail)}>{t('chatTools.routineRun.open')}</Button>
          <Button size="sm" icon={<Play size={13} />} loading={busy} disabled={status === 'running'} onClick={() => void again()}>{t('chatTools.routineRun.again')}</Button>
        </div>
      )}
    </section>
  )
}

/** CH-30: ends a private chat; with messages in it, asks first. Resolves true when it was discarded. */
export async function discardPrivateChat(chatId: string, hasContent: boolean): Promise<boolean> {
  const { t } = await import('../i18n/useT')
  if (hasContent) {
    const ok = await confirm({ title: t('chatTools.private.confirmTitle'), message: t('chatTools.private.confirmMessage'), confirmLabel: t('chatTools.private.confirm'), destructive: true })
    if (!ok) return false
  }
  try {
    await call('chats', 'discard', chatId)
    return true
  } catch (err) {
    fail(err)
    return false
  }
}

/** CH-30: the private-chat note: not saved, memory off, and a way to end it. */
export function PrivateBanner({ chatId, state, onDiscarded }: { chatId: string; state: ChatState; onDiscarded?(): void }): ReactElement {
  const t = useT()
  const hasContent = state.log.items.length > 0
  return (
    <section className="cd-banner cd-banner--private" aria-label={t('chatTools.private.label')}>
      <EyeOff size={16} className="cd-banner__icon" aria-hidden="true" />
      <div className="cd-banner__text">
        <p className="cd-banner__title">{t('chatTools.private.label')}</p>
        <p className="cd-banner__meta">{t('chatTools.private.detail')}</p>
      </div>
      {!state.summary?.draft && (
        <div className="cd-banner__actions">
          <Button size="sm" variant="ghost" onClick={() => void discardPrivateChat(chatId, hasContent).then((done) => done && onDiscarded?.())}>{t('chatTools.private.end')}</Button>
        </div>
      )}
    </section>
  )
}

/** CH-31: where an imported conversation came from, read-only, and how to carry on in a fresh chat. */
export function ImportedBanner({ summary }: { summary: ChatSummary }): ReactElement | null {
  const t = useT()
  const [busy, setBusy] = useState<'summary' | 'transcript' | null>(null)
  const imported = summary.imported
  if (!imported) return null
  const carryOn = async (how: 'summary' | 'transcript'): Promise<void> => {
    if (busy) return
    setBusy(how)
    try {
      const id = await call('conversations', 'continueFrom', summary.id, how)
      await call('pages', 'open', chatUrl(id))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="cd-banner cd-banner--imported" aria-label={t('chatTools.imported.title', { source: t(`chatTools.imported.source.${imported.source}`) })}>
      <FileInput size={16} className="cd-banner__icon" aria-hidden="true" />
      <div className="cd-banner__text">
        <p className="cd-banner__title">{t('chatTools.imported.title', { source: t(`chatTools.imported.source.${imported.source}`) })}</p>
        {imported.originalCreatedAt !== null && <p className="cd-banner__meta">{t('chatTools.imported.date', { date: new Date(imported.originalCreatedAt).toLocaleDateString(undefined, { dateStyle: 'long' }) })}</p>}
        <p className="cd-banner__meta">{t('chatTools.imported.readOnly')}</p>
      </div>
      <div className="cd-banner__actions cd-banner__actions--stack">
        <Button size="sm" variant="primary" className="chat-co-button" loading={busy === 'summary'} disabled={busy !== null} onClick={() => void carryOn('summary')}>{t('chatTools.imported.summary')}</Button>
        <Button size="sm" loading={busy === 'transcript'} disabled={busy !== null} onClick={() => void carryOn('transcript')}>{t('chatTools.imported.transcript')}</Button>
      </div>
    </section>
  )
}

/** CH-32: a sub-task's header links back to the chat that handed it out. */
export function ParentLink({ summary }: { summary: ChatSummary }): ReactElement | null {
  const t = useT()
  const chats = useChatList()
  if (!summary.parentChatId) return null
  const parent = chats?.find((c) => c.id === summary.parentChatId)
  return (
    <button type="button" className="cd-parent-link" onClick={() => summary.parentChatId && void call('pages', 'open', chatUrl(summary.parentChatId)).catch(fail)}>
      <CornerUpLeft size={13} aria-hidden="true" />
      <span>{parent ? t('chatTools.child.label', { title: parent.title }) : t('chatTools.child.open')}</span>
    </button>
  )
}

/** ST-12: "Don't ask" is a runtime mode; while it is on, every chat says so, with a way out. */
export function DontAskBanner(): ReactElement | null {
  const t = useT()
  const current = useApprovalMode()
  const [busy, setBusy] = useState(false)
  if (current !== 'dont-ask') return null
  return (
    <section className={cx('cd-banner', 'cd-banner--warning')} role="status">
      <ShieldOff size={16} className="cd-banner__icon" aria-hidden="true" />
      <div className="cd-banner__text">
        <p className="cd-banner__meta cd-banner__meta--strong">{t('chatTools.dontAsk.text')}</p>
      </div>
      <div className="cd-banner__actions">
        <Button
          size="sm"
          loading={busy}
          onClick={() => {
            setBusy(true)
            void call('agent', 'setApprovalMode', 'standard').catch(fail).finally(() => setBusy(false))
          }}
        >
          {t('chatTools.dontAsk.off')}
        </Button>
      </div>
    </section>
  )
}

/** Every banner above a chat's messages, in one place for ChatView's lead slot. */
export function ChatBanners({ chatId, state, onDiscarded }: { chatId: string; state: ChatState; onDiscarded?(): void }): ReactElement | null {
  const summary = state.summary
  if (!summary) return <DontAskBanner />
  return (
    <>
      <DontAskBanner />
      <ParentLink summary={summary} />
      {summary.private && <PrivateBanner chatId={chatId} state={state} {...(onDiscarded ? { onDiscarded } : {})} />}
      {summary.routineId && <RoutineRunHeader summary={summary} />}
      {summary.imported && <ImportedBanner summary={summary} />}
    </>
  )
}

/**
 * CH-30: the private toggle before the first message. A chat's privacy is set
 * when it is made, so switching makes a fresh draft with the other setting
 * (with the same companion) and shows it here; a private draft is dropped.
 */
export function PrivateToggle({ chatId, state, onChangeChat }: { chatId: string; state: ChatState; onChangeChat(id: string): void }): ReactElement | null {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const summary = state.summary
  if (!summary?.draft || state.log.items.length > 0) return null
  const on = summary.private
  const flip = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const next = await call('chats', 'create', { companionId: summary.companionId, ...(on ? {} : { private: true }) })
      if (on) void call('chats', 'discard', chatId).catch(() => undefined)
      onChangeChat(next.id)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cd-private-row">
      <button type="button" className="cd-private-toggle" aria-pressed={on} disabled={busy} title={t('chatTools.private.toggleHint')} onClick={() => void flip()}>
        <EyeOff size={14} aria-hidden="true" />
        {t('chatTools.private.toggle')}
      </button>
    </div>
  )
}

/** CH-30: the header's small private mark, so a private chat is never mistaken for a saved one. */
export function PrivateHeaderChip({ summary }: { summary: ChatSummary | null }): ReactElement | null {
  const t = useT()
  if (!summary?.private) return null
  return (
    <span className="cd-head-chip" title={t('chatTools.private.detail')}>
      <EyeOff size={12} aria-hidden="true" />
      {t('chatTools.private.label')}
    </span>
  )
}

/** CH-30 on the new tab: the same toggle, held by the page until you send. */
export function NewTabPrivateToggle({ on, onChange }: { on: boolean; onChange(on: boolean): void }): ReactElement {
  const t = useT()
  return (
    <div className="cd-private-row">
      <button type="button" className="cd-private-toggle" aria-pressed={on} title={t('chatTools.private.toggleHint')} onClick={() => onChange(!on)}>
        <EyeOff size={14} aria-hidden="true" />
        {t('chatTools.private.toggle')}
      </button>
    </div>
  )
}

/** CH-30: starts a private chat from the new tab and shows it there. */
export function startPrivateChat(tabId: string, text: string, companionId: string): void {
  void apex.agent.start(text, { companionId, private: true }).then(
    (chatId) => void apex.nav.go(tabId, chatUrl(chatId)),
    (err: unknown) => fail(err),
  )
}
