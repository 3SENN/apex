/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  Ban,
  CircleAlert,
  CloudOff,
  FileWarning,
  Gauge,
  HardDrive,
  Hourglass,
  KeyRound,
  LogIn,
  MessagesSquare,
  OctagonX,
  Play,
  RotateCw,
  ShieldAlert,
  SquareTerminal,
  Timer,
  Download,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { PROVIDER_CONSOLE_URL } from '@shared/chatErrors'
import type { LogItem } from '../agentLog'
import { atelier, call, errorText, useAppEvent } from '../api'
import { t } from '../i18n/useT'
import { Button, Spinner, cx, toast, useNow } from '../ui'
import { detailsText, errorCard, PICK_MODEL_EVENT, retrySecondsLeft, shouldAutoRetry, type ErrorAction, type ErrorIcon } from './logic/errors'
import { ENGINE_UI } from '@engines/renderer'

// The chat cards: the step-limit card (CH-14), the stop mark (CH-17),
// error cards by type (SS-03), the save-failure notice (SS-05), the offline
// banner (SS-04, SS-06) and the older-pages bar and missing-anchor notice (CH-13).

// ---- online (SS-06) ----

let onlineNow = true
let onlineAsked = false

/** The one online state main follows, with its live changes. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(onlineNow)
  useEffect(() => {
    if (onlineAsked) return
    onlineAsked = true
    let live = true
    void call('network', 'isOnline').then(
      (v) => {
        onlineNow = v
        if (live) setOnline(v)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])
  useAppEvent('online', (e) => {
    onlineNow = e.online
    setOnline(e.online)
  })
  return online
}

/** SS-04: offline, the composer stays usable and sends wait for the connection. */
export function OfflineBanner({ online }: { online: boolean }): ReactElement | null {
  if (online) return null
  return (
    <div className="chat-banner chat-banner--offline" role="status">
      <WifiOff size={14} aria-hidden="true" />
      <span>{t('chat.offline.banner')}</span>
    </div>
  )
}

// ---- save failures (SS-05) ----

export function SaveErrorNotice({ chatId, error }: { chatId: string; error: string | null | undefined }): ReactElement | null {
  const [busy, setBusy] = useState(false)
  if (!error) return null
  const retry = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('chats', 'retrySave', chatId)
      toast.show({ message: t('chat.save.retried'), tone: 'success' })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="chat-banner chat-banner--error" role="alert">
      <HardDrive size={14} aria-hidden="true" />
      <span>{t('chat.save.failed', { reason: error })}</span>
      <Button size="sm" loading={busy} onClick={() => void retry()}>{t('chat.save.retry')}</Button>
    </div>
  )
}

// ---- step limit and stop (CH-14, CH-17) ----

type StepLimitItem = Extract<LogItem, { kind: 'step-limit' }>

/** Settings › Model and key, scrolled to No step limit. */
export const STEP_LIMIT_SETTINGS_URL = 'atelier://settings/model?highlight=step-limit'
type StoppedItem = Extract<LogItem, { kind: 'stopped' }>

export interface StepLimitCardProps {
  chatId: string
  item: StepLimitItem
  name: string
  /** It is the chat's newest item and nothing runs: Continue picks the run up. */
  canContinue: boolean
  onAct(): void
}

export function StepLimitCard({ chatId, item, name, canContinue, onAct }: StepLimitCardProps): ReactElement {
  const [busy, setBusy] = useState(false)
  const go = async (): Promise<void> => {
    onAct()
    setBusy(true)
    try {
      await call('chats', 'continue', chatId)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="chat-card chat-card--info" role="note">
      <Timer size={16} className="chat-card__icon" aria-hidden="true" />
      <div className="chat-card__text">
        <p className="chat-card__title">{t('chat.stepLimit.title', { name, steps: item.steps })}</p>
        {canContinue && <p className="chat-card__body">{t('chat.stepLimit.body', { name })}</p>}
      </div>
      <div className="chat-card__actions">
        {canContinue && <Button size="sm" variant="primary" className="chat-co-button" icon={<Play size={13} />} loading={busy} onClick={() => void go()}>{t('chat.stepLimit.continue')}</Button>}
        {/* The step limit's own setting, highlighted, so you can turn it off. */}
        <Button size="sm" variant={canContinue ? 'ghost' : 'secondary'} onClick={() => void call('pages', 'open', STEP_LIMIT_SETTINGS_URL)}>{t('chat.stepLimit.settings')}</Button>
      </div>
    </div>
  )
}

export function StoppedMark({ item }: { item: StoppedItem }): ReactElement {
  const key = item.reason === 'interrupt' ? 'chat.stopped.interrupt' : item.reason === 'error' ? 'chat.stopped.error' : 'chat.stopped.user'
  return (
    <p className={cx('chat-stopped', `chat-stopped--${item.reason}`)}>
      <OctagonX size={12} aria-hidden="true" />
      <span>{t(key)}</span>
    </p>
  )
}

// ---- error cards (SS-03) ----

const ICONS: Record<ErrorIcon, LucideIcon> = {
  offline: WifiOff,
  wait: Hourglass,
  busy: Gauge,
  unavailable: CloudOff,
  model: Ban,
  size: FileWarning,
  long: MessagesSquare,
  refusal: ShieldAlert,
  key: KeyRound,
  quota: Gauge,
  'signed-out': LogIn,
  limit: Hourglass,
  missing: SquareTerminal,
  update: Download,
  disk: HardDrive,
  other: CircleAlert,
}

const ACTION_LABEL: Record<Exclude<ErrorAction, 'none' | 'engine-step'>, Parameters<typeof t>[0]> = {
  retry: 'chat.error.action.retry',
  settings: 'chat.error.action.settings',
  model: 'chat.error.action.model',
  'new-chat': 'chat.error.action.newChat',
  console: 'chat.error.action.console',
  engine: 'chat.error.action.engine',
  'pick-model': 'chat.error.action.pickModel',
}

/** Errors that already retried on their own, so a remount doesn't retry twice. */
const autoRetried = new Set<string>()

type NoticeItem = Extract<LogItem, { kind: 'notice' }>

export interface ErrorCardProps {
  chatId: string
  item: NoticeItem
  name: string
  /** The chat's newest item: its retry is the one that counts. */
  last: boolean
  /** When the error arrived in this session (null when it came from the saved log). */
  arrivedAt: number | null
  driving: boolean
  online: boolean
  running: boolean
  onNewChat(): void
  onAct(): void
  /** Another action for this error (Compact and continue for a chat that is too long). */
  extra?: ReactNode
}

export function ErrorCard({ chatId, item, name, last, arrivedAt, driving, online, running, onNewChat, onAct, extra }: ErrorCardProps): ReactElement {
  const card = errorCard(item.code, item.text, item.facts)
  const Icon = ICONS[card.icon]
  const [busy, setBusy] = useState(false)
  // The engine's own next step (an update, say), from the engine that reported the error.
  const step = ENGINE_UI.useErrorStep({ code: card.code, offered: card.action === 'engine-step' || card.secondary === 'engine-step', chatId, model: item.facts?.model, last, arrivedAt, onAct })
  const key = `${chatId}:${arrivedAt ?? 'saved'}`
  const auto = arrivedAt !== null && shouldAutoRetry({ card, retryAfterMs: item.retryAfterMs, live: true, last, driving, retried: autoRetried.has(key), online })

  const retry = async (): Promise<void> => {
    onAct()
    setBusy(true)
    try {
      // Main re-sends the last turn; your message is not added again.
      await call('chats', 'retry', chatId)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  // SS-06: a reply that failed for want of a connection goes again once it is back (from the driving surface, once).
  const wasOnline = useRef(online)
  useEffect(() => {
    const back = online && !wasOnline.current
    wasOnline.current = online
    if (!back || card.code !== 'offline' || !last || arrivedAt === null || !driving || running || autoRetried.has(key)) return
    autoRetried.add(key)
    void retry()
  }, [online])

  const act = (action: ErrorAction): void => {
    switch (action) {
      case 'retry':
        void retry()
        break
      case 'settings':
      case 'model':
      case 'engine':
        void call('pages', 'open', 'atelier://settings/model')
        break
      case 'new-chat':
        onNewChat()
        break
      case 'console':
        void atelier.tabs.create(PROVIDER_CONSOLE_URL).catch(() => undefined)
        break
      case 'engine-step':
        step?.run()
        break
      case 'pick-model':
        window.dispatchEvent(new CustomEvent(PICK_MODEL_EVENT, { detail: { chatId } }))
        break
      case 'none':
        break
    }
  }

  // After a step that handed over to something outside Atelier (Terminal), Retry looks again first.
  const manual = step?.manual === true
  const base = [card.action, card.secondary].filter((a): a is Exclude<ErrorAction, 'none'> => a !== null && a !== 'none' && (a !== 'retry' || last) && (a !== 'engine-step' || step !== null))
  const actions = manual && last && !base.includes('retry') ? [...base, 'retry' as const] : base
  const progress = step?.progress ?? null
  const working = step?.working === true
  const details = detailsText(item.details)
  const body = card.body ? t(card.body, card.bodyVars) : item.text
  return (
    <div className={cx('chat-card', `chat-card--${card.tone}`)} role={card.tone === 'error' ? 'alert' : 'status'} data-code={card.code}>
      <Icon size={16} className="chat-card__icon" aria-hidden="true" />
      <div className="chat-card__text">
        <p className="chat-card__title">{t(card.title, { name })}</p>
        {body && body !== t(card.title, { name }) && <p className="chat-card__body">{body}</p>}
        {progress && (
          <p className={cx('chat-card__countdown', `chat-card__progress--${progress.tone}`)} aria-live="polite">
            {progress.tone === 'busy' && <Spinner size={11} />} {progress.text}
          </p>
        )}
        {details && (
          <details className="chat-card__details">
            <summary>{t('chat.error.details')}</summary>
            <pre>{details}</pre>
          </details>
        )}
        {auto && arrivedAt !== null && !running && (
          <RetryCountdown
            arrivedAt={arrivedAt}
            retryAfterMs={item.retryAfterMs}
            onDue={() => {
              autoRetried.add(key)
              void retry()
            }}
          />
        )}
      </div>
      {(actions.length > 0 || extra) && !running && (
        <div className="chat-card__actions">
          {extra}
          {actions.map((action, i) => (
            <Button
              key={action}
              size="sm"
              variant={i === 0 ? 'primary' : 'ghost'}
              className={i === 0 ? 'chat-co-button' : undefined}
              icon={action === 'retry' ? <RotateCw size={13} /> : action === 'engine-step' ? step?.icon : undefined}
              loading={(action === 'retry' && busy) || (action === 'engine-step' && working)}
              disabled={action === 'engine-step' && working}
              onClick={() => (action === 'retry' && manual && step ? void step.recheck().finally(() => act('retry')) : act(action))}
            >
              {action === 'engine-step' ? step?.label : t(action === 'retry' && auto ? 'chat.error.action.retryNow' : ACTION_LABEL[action])}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Counts down to the automatic retry and fires it once (only cards that retry by themselves tick). */
function RetryCountdown({ arrivedAt, retryAfterMs, onDue }: { arrivedAt: number; retryAfterMs: number | undefined; onDue(): void }): ReactElement {
  const now = useNow()
  const seconds = retrySecondsLeft(arrivedAt, retryAfterMs, now)
  const fired = useRef(false)
  useEffect(() => {
    if (seconds > 0 || fired.current) return
    fired.current = true
    onDue()
  }, [seconds])
  return (
    <p className="chat-card__countdown" aria-live="polite">
      {seconds > 0 ? t('chat.error.retryIn', { seconds }) : <><Spinner size={11} /> {t('chat.error.retrying')}</>}
    </p>
  )
}

// ---- older pages and anchors (CH-13) ----

export function OlderBar({ loading, error, onLoad }: { loading: boolean; error: string | null | undefined; onLoad(): void }): ReactElement {
  if (loading) {
    return (
      <div className="chat-older" role="status">
        <Spinner size={12} />
        <span>{t('chat.older.loading')}</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="chat-older chat-older--failed" role="alert">
        <span>{t('chat.older.failed')}</span>
        <Button size="sm" variant="ghost" onClick={onLoad}>{t('chat.older.retry')}</Button>
      </div>
    )
  }
  return (
    <div className="chat-older">
      <Button size="sm" variant="ghost" onClick={onLoad}>{t('chat.older.more')}</Button>
    </div>
  )
}

export function AnchorMissing({ onNewest, onClose }: { onNewest(): void; onClose(): void }): ReactElement {
  return (
    <div className="chat-banner chat-banner--info" role="status">
      <MessagesSquare size={14} aria-hidden="true" />
      <span>{t('chat.anchor.missing')}</span>
      <Button
        size="sm"
        onClick={() => {
          onNewest()
          onClose()
        }}
      >
        {t('chat.anchor.newest')}
      </Button>
    </div>
  )
}
