/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Wifi, WifiOff } from 'lucide-react'
import { call, useAppEvent } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, Spinner, cx } from '../../ui'
import { reconnectDelay } from './logic'
import './errors.css'

// The connection banner (SS-06) for pages that talk to the network on
// their own, such as Connectors: while offline it counts down to the next
// check (5, 10, 20, then every 30 seconds), with Retry now; when the
// `online` event says the connection is back it says so briefly and calls
// onReconnect, so the page can reconnect what it lost.

type Phase = { kind: 'online' } | { kind: 'waiting'; attempt: number; seconds: number } | { kind: 'checking'; attempt: number } | { kind: 'back' }

export function ConnectionBanner({ onReconnect, className }: { onReconnect?(): void; className?: string }): ReactElement | null {
  const t = useT()
  const [phase, setPhase] = useState<Phase>({ kind: 'online' })
  const reconnect = useRef(onReconnect)
  reconnect.current = onReconnect

  // The ref moves with the state at once, so the online event and a check's answer can't both reconnect.
  const current = useRef(phase)
  const move = (next: Phase): void => {
    current.current = next
    setPhase(next)
  }
  const isOffline = (): boolean => current.current.kind === 'waiting' || current.current.kind === 'checking'
  const goOffline = (attempt: number): void => move({ kind: 'waiting', attempt, seconds: reconnectDelay(attempt) })
  const goOnline = (): void => {
    if (!isOffline()) return
    move({ kind: 'back' })
    reconnect.current?.()
  }

  useEffect(() => {
    let live = true
    void call('network', 'isOnline').then(
      (online) => {
        if (live && !online) goOffline(0)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])

  useAppEvent('online', (e) => {
    if (e.online) goOnline()
    else if (!isOffline()) goOffline(0)
  })

  const check = (attempt: number): void => {
    move({ kind: 'checking', attempt })
    void call('network', 'check').then(
      (online) => {
        if (online) goOnline()
        else if (isOffline()) goOffline(attempt + 1)
      },
      () => {
        if (isOffline()) goOffline(attempt + 1)
      },
    )
  }

  // One tick a second while waiting; at zero the check runs.
  useEffect(() => {
    if (phase.kind !== 'waiting') return
    const timer = setTimeout(() => {
      if (phase.seconds <= 1) check(phase.attempt)
      else move({ ...phase, seconds: phase.seconds - 1 })
    }, 1000)
    return () => clearTimeout(timer)
  }, [phase])

  // "Back online" shows for a moment, then the banner goes.
  useEffect(() => {
    if (phase.kind !== 'back') return
    const timer = setTimeout(() => move({ kind: 'online' }), 3000)
    return () => clearTimeout(timer)
  }, [phase])

  if (phase.kind === 'online') return null
  const back = phase.kind === 'back'
  return (
    <div className={cx('conn-banner', back && 'conn-banner--back', className)} role="status" aria-live="polite">
      <span className="conn-banner__icon" aria-hidden="true">
        {back ? <Wifi size={16} /> : <WifiOff size={16} />}
      </span>
      <span className="conn-banner__text">
        {back ? t('safety.online.back') : phase.kind === 'checking' ? t('safety.online.checking') : (
          <>
            {t('safety.online.offline')}. {t('safety.online.reconnecting', { seconds: phase.seconds })}
          </>
        )}
      </span>
      {phase.kind === 'checking' && <Spinner size={12} />}
      {phase.kind === 'waiting' && (
        <Button size="sm" variant="secondary" onClick={() => check(phase.attempt)}>
          {t('safety.online.retryNow')}
        </Button>
      )}
    </div>
  )
}
