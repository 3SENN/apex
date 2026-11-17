/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { CalendarClock, Ellipsis, PhoneCall, ShieldCheck, Timer, Video, X } from 'lucide-react'
import { DESKTOP_CALL_APPS } from '@shared/desktopCalls'
import { cardPermissionBody, formatElapsed, type CardAction, type CardPayload } from '@shared/meetingCapture'
import { t, type MessageKey } from '../../i18n/useT'
import { Button, IconButton } from '../../ui/Button'
import { useMotion } from '../../ui/motion'
import '../../ui/ui.css'
import { floatInvoke, useFloatPayload } from '../api'

// The meeting card (MV-09): a meeting site opened, a calendar meeting is
// about to start, permissions are missing, or a long or silent recording
// asks whether to go on. Main decides which card shows; every button goes
// back as 'card:action' with the card's id, so a click on a card that has
// just been replaced does nothing.

const GLYPHS = { site: Video, calendar: CalendarClock, permissions: ShieldCheck, continue: Timer, app: PhoneCall } as const

const MUTE_KIND_LABEL: Record<'site' | 'calendar' | 'permissions' | 'app', MessageKey> = {
  site: 'capture.card.muteSite',
  calendar: 'capture.card.muteCalendar',
  permissions: 'capture.card.mutePermissions',
  app: 'capture.card.muteApps',
}

const PERMISSION_LABEL: Record<'microphone' | 'speech' | 'screen', MessageKey> = {
  microphone: 'capture.perm.microphone',
  speech: 'capture.perm.speech',
  screen: 'capture.perm.screen',
}

/** Ticks every `ms` while `on`; returns the time. */
function useTick(on: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [on, ms])
  return now
}

function MuteMenu({ card, onPick, onClose }: { card: CardPayload; onPick(action: CardAction): void; onClose(): void }): ReactElement | null {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [])
  if (card.mode === 'continue') return null
  const items: Array<{ action: CardAction; label: string }> = [
    // A desktop call: this app first, then every app.
    ...(card.mode === 'app' && card.app ? [{ action: 'mute-app' as const, label: t('capture.card.muteApp', { app: DESKTOP_CALL_APPS[card.app].name }) }] : []),
    { action: 'mute-kind', label: t(MUTE_KIND_LABEL[card.mode]) },
    ...(card.host ? [{ action: 'mute-site' as const, label: t('capture.card.muteHost', { host: card.host }) }] : []),
    { action: 'mute-all', label: t('capture.card.muteAll') },
  ]
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
  return (
    <div ref={list} className="mc-menu" role="menu" aria-label={t('capture.card.more')} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button key={item.action} type="button" role="menuitem" className="mc-menu__item" onClick={() => onPick(item.action)}>
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function MeetingCard(): ReactElement | null {
  const card = useFloatPayload<CardPayload>()
  const { reduced } = useMotion()
  const [busy, setBusy] = useState<CardAction | null>(null)
  const [failed, setFailed] = useState(false)
  const [menu, setMenu] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  // The countdown runs from when this card arrived; main's own timer started then too.
  const [arrived, setArrived] = useState(() => Date.now())
  useEffect(() => {
    setArrived(Date.now())
    setBusy(null)
    setFailed(false)
    setMenu(false)
  }, [card?.id, card?.mode])

  const counting = card?.mode === 'continue' && typeof card.countdownMs === 'number'
  const now = useTick(counting || card?.mode === 'calendar', counting ? 250 : 15_000)

  if (!card) return null
  const Glyph = GLYPHS[card.mode]

  const act = (action: CardAction): void => {
    if (busy) return
    setBusy(action)
    setFailed(false)
    setMenu(false)
    floatInvoke('card:action', action, ...(card.id ? [card.id] : [])).catch(() => {
      setBusy(null)
      setFailed(true)
    })
  }

  const remaining = counting ? Math.max(0, (card.countdownMs ?? 0) - (now - arrived)) : 0
  const subtitle =
    card.mode === 'calendar' && card.startsAt
      ? [t('capture.card.startsIn', { minutes: Math.max(0, Math.ceil((card.startsAt - now) / 60_000)) }), card.host].filter(Boolean).join(' · ')
      : card.mode === 'continue'
        ? t('capture.card.stoppingIn', { time: formatElapsed(remaining + 999) })
        : card.mode === 'app'
          ? card.startsAt && card.app
            ? t('capture.card.appFromCalendar', { app: DESKTOP_CALL_APPS[card.app].name })
            : ''
          : (card.host ?? '')

  let body: string
  switch (card.mode) {
    case 'site':
      body = t(card.audioOnly ? 'capture.card.siteAudioBody' : 'capture.card.siteBody')
      break
    case 'calendar':
      body = t('capture.card.calendarBody')
      break
    case 'permissions':
      body = card.canRecord ? t(cardPermissionBody(card)) : t('capture.card.permissionsBody')
      break
    case 'continue':
      body = t(card.reason === 'silent' ? 'capture.card.continueSilent' : 'capture.card.continueLong')
      break
    case 'app':
      body = t(card.audioOnly ? 'capture.card.appAudioBody' : 'capture.card.appBody')
      break
  }

  const title =
    card.mode === 'permissions' && !card.canRecord
      ? t('capture.card.permissionsTitle')
      : card.mode === 'app'
        ? t(card.audioOnly ? 'capture.card.appPromptAudio' : 'capture.card.appPrompt', { title: card.title })
        : card.title
  const button = (action: CardAction, label: string, variant: 'primary' | 'secondary' | 'ghost' = 'secondary'): ReactElement => (
    <Button key={action} size="sm" variant={variant} loading={busy === action} disabled={busy !== null && busy !== action} onClick={() => act(action)}>
      {label}
    </Button>
  )

  const actions: ReactElement[] = []
  switch (card.mode) {
    case 'site':
      actions.push(button('record', t('capture.card.record'), 'primary'), button('join-only', t('capture.card.joinOnly')), button('settings', t('capture.card.settings'), 'ghost'))
      break
    case 'calendar':
      if (card.joinable) actions.push(button('record', t('capture.card.joinAndRecord'), 'primary'), button('join-only', t('capture.card.join')))
      else actions.push(button('record', t('capture.card.recordOnly'), 'primary'))
      break
    case 'permissions':
      actions.push(button('setup', t('capture.card.setUp'), 'primary'))
      // Without Speech Recognition it records audio only; without Screen Recording, your side only.
      if (card.canRecord) actions.push(button('record', t(card.missing?.includes('speech') ? 'capture.card.recordAudioOnly' : 'capture.card.recordMicOnly')))
      actions.push(button('dont-show-again', t('capture.card.dontShowAgain'), 'ghost'))
      break
    case 'continue':
      actions.push(button('continue', t('capture.card.keepRecording'), 'primary'), button('stop', t('capture.card.stopNow')))
      break
    case 'app':
      actions.push(button('record', t(card.audioOnly ? 'capture.card.record' : 'capture.card.takeNotes'), 'primary'), button('dismiss', t('capture.card.notNow')), button('settings', t('capture.card.settings'), 'ghost'))
      break
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape' && !menu) {
      e.preventDefault()
      act('dismiss')
    }
  }

  return (
    <section className="float-card mc-card" data-mode={card.mode} role="dialog" aria-labelledby="mc-title" aria-describedby="mc-body" onKeyDown={onKeyDown}>
      <header className="mc-head">
        <span className="mc-glyph" aria-hidden="true">
          <Glyph size={16} strokeWidth={2} />
        </span>
        <div className="mc-titles">
          <h1 id="mc-title" className="mc-title">
            {title}
          </h1>
          {subtitle && (
            <p className="mc-sub" aria-live={card.mode === 'continue' ? 'off' : undefined}>
              {subtitle}
            </p>
          )}
        </div>
        {card.mode !== 'continue' && (
          <IconButton
            ref={moreButton}
            size="sm"
            label={t('capture.card.more')}
            icon={<Ellipsis size={16} />}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          />
        )}
        <IconButton size="sm" label={t('capture.card.dismiss')} icon={<X size={16} />} disabled={busy !== null} onClick={() => act('dismiss')} />
      </header>
      {menu && (
        <MuteMenu
          card={card}
          onPick={act}
          onClose={() => {
            setMenu(false)
            moreButton.current?.focus()
          }}
        />
      )}
      <p id="mc-body" className="mc-body">
        {body}
      </p>
      {card.mode === 'permissions' && !card.canRecord && card.missing && (
        <ul className="mc-missing">
          {card.missing.map((kind) => (
            <li key={kind}>{t(PERMISSION_LABEL[kind])}</li>
          ))}
        </ul>
      )}
      {counting && (
        <div
          className="mc-countdown"
          role="progressbar"
          aria-label={t('capture.card.stoppingIn', { time: formatElapsed(remaining + 999) })}
          aria-valuemin={0}
          aria-valuemax={Math.round((card.countdownMs ?? 0) / 1000)}
          aria-valuenow={Math.ceil(remaining / 1000)}
        >
          <span className="mc-countdown__fill" data-snap={reduced || undefined} style={{ transform: `scaleX(${(card.countdownMs ?? 1) > 0 ? remaining / (card.countdownMs ?? 1) : 0})` }} />
        </div>
      )}
      {failed && (
        <p className="mc-error" role="alert">
          {t('capture.card.error')}
        </p>
      )}
      <div className="mc-actions">{actions}</div>
    </section>
  )
}
