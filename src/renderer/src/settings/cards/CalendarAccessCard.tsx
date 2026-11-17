/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Calendar and Reminders access card, mounted
// on the Agent permissions page under "This Mac". Each kind has its own
// switch in Apex and its own macOS permission; companions read a kind only
// when both say yes, and never change anything. Without the helper (another
// platform, or a build without it) the card says so.
import { useEffect, useState, type ReactElement } from 'react'
import { CalendarDays, ListChecks, ShieldAlert } from 'lucide-react'
import type { CalendarKind, CalendarPermission, CalendarStatus } from '@shared/calendar'
import { call, errorText } from '../../api'
import { t, type MessageKey } from '../../i18n/useT'
import { Card } from '../kit'
import { useEvent, useResource } from '../data'
import { Badge, Button, ErrorState, SkeletonRows, Switch, type BadgeTone } from '../../ui'
import { SiteSuggestionsSetting } from '../../suggestions/SiteSuggestionsSetting'
import '../../apps/platform.css'

const KINDS: ReadonlyArray<{ kind: CalendarKind; icon: ReactElement }> = [
  { kind: 'events', icon: <CalendarDays aria-hidden /> },
  { kind: 'reminders', icon: <ListChecks aria-hidden /> },
]

const STATE: Record<CalendarPermission, { tone: BadgeTone; key: MessageKey }> = {
  granted: { tone: 'success', key: 'platform.calendar.state.granted' },
  denied: { tone: 'danger', key: 'platform.calendar.state.denied' },
  restricted: { tone: 'warning', key: 'platform.calendar.state.restricted' },
  'not-determined': { tone: 'neutral', key: 'platform.calendar.state.notDetermined' },
}

/** What one row says under its title, given the switch and the permission. */
export function calendarRowNote(status: CalendarStatus, kind: CalendarKind): MessageKey {
  const permission = status[kind]
  if (!status.enabled[kind]) return permission === 'denied' ? 'platform.calendar.note.offDenied' : 'platform.calendar.note.off'
  if (permission === 'granted') return kind === 'events' ? 'platform.calendar.note.onEvents' : 'platform.calendar.note.onReminders'
  if (permission === 'restricted') return 'platform.calendar.note.restricted'
  if (permission === 'denied') return 'platform.calendar.note.denied'
  return 'platform.calendar.note.ask'
}

export function CalendarAccessCard(): ReactElement {
  const status = useResource<CalendarStatus>(() => call('calendar', 'status'))
  const [busy, setBusy] = useState<CalendarKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEvent('calendar', (e) => status.set(e.status))
  // Back from System Settings (or the macOS prompt): read the permissions again.
  useEffect(() => {
    const recheck = (): void => {
      if (document.visibilityState === 'visible') void status.reload()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [status.reload])

  const run = async (kind: CalendarKind, fn: () => Promise<CalendarStatus>): Promise<void> => {
    setBusy(kind)
    setError(null)
    try {
      status.set(await fn())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }
  const toggle = (kind: CalendarKind, on: boolean): void => {
    const current = status.data
    // Turning on before macOS was ever asked asks now; the grant switches it on.
    if (on && current?.[kind] === 'not-determined') void run(kind, () => call('calendar', 'requestAccess', kind))
    else void run(kind, () => call('calendar', 'setEnabled', kind, on))
  }

  if (status.error && !status.data) {
    return (
      <Card>
        <ErrorState compact title={t('platform.calendar.loadError')} message={status.error} onRetry={status.reload} />
      </Card>
    )
  }
  if (!status.data) {
    return (
      <Card>
        <SkeletonRows rows={2} avatar label={t('platform.calendar.loading')} />
      </Card>
    )
  }
  const data = status.data

  return (
    <Card>
      <div className="pl-access" role="group" aria-label={t('platform.calendar.title')}>
        {!data.available && (
          <div className="pl-access__row">
            <span className="pl-access__icon">
              <ShieldAlert aria-hidden />
            </span>
            <span className="pl-access__text">
              <p className="pl-access__title">{t('platform.calendar.unavailable.title')}</p>
              <p className="pl-access__desc">{t('platform.calendar.unavailable.detail')}</p>
            </span>
          </div>
        )}
        {KINDS.map(({ kind, icon }) => {
          const permission = data[kind]
          const state = STATE[permission]
          const titleId = `pl-cal-${kind}`
          return (
            <div className="pl-access__row" key={kind} data-settings-anchor={`calendar-${kind}`}>
              <span className="pl-access__icon">{icon}</span>
              <span className="pl-access__text">
                <p className="pl-access__title" id={titleId}>
                  {t(kind === 'events' ? 'platform.calendar.events' : 'platform.calendar.reminders')}
                </p>
                <p className="pl-access__desc">{t(kind === 'events' ? 'platform.calendar.eventsDetail' : 'platform.calendar.remindersDetail')}</p>
                {data.available && (
                  <span className="pl-access__state">
                    <Badge tone={state.tone}>{t(state.key)}</Badge>
                    <span className="pl-access__desc" aria-live="polite">
                      {t(calendarRowNote(data, kind))}
                    </span>
                  </span>
                )}
                {data.available && (permission === 'not-determined' || permission === 'denied' || permission === 'restricted') && (
                  <span className="pl-access__state">
                    {permission === 'not-determined' ? (
                      <Button size="sm" loading={busy === kind} onClick={() => void run(kind, () => call('calendar', 'requestAccess', kind))}>
                        {t('platform.calendar.grant')}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => Promise.resolve(call('calendar', 'openPrivacySettings', kind)).catch((err: unknown) => setError(errorText(err)))}>
                        {t('platform.calendar.openPrivacy')}
                      </Button>
                    )}
                  </span>
                )}
              </span>
              <Switch
                checked={data.available && data.enabled[kind]}
                disabled={!data.available || busy !== null || permission === 'restricted'}
                onChange={(on) => toggle(kind, on)}
                aria-label={t(kind === 'events' ? 'platform.calendar.switchEvents' : 'platform.calendar.switchReminders')}
              />
            </div>
          )
        })}
        {error && (
          <p className="pl-error" role="alert">
            {error}
          </p>
        )}
        <p className="pl-access__desc" style={{ margin: '0 0 10px 48px' }}>
          {t('platform.calendar.footer')}
        </p>
        <SiteSuggestionsSetting />
      </div>
    </Card>
  )
}
