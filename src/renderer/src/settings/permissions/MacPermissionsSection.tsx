/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Privacy › Permissions › This Mac: one row per macOS permission
// Apex uses, with what it is for, macOS's answer and the one thing to do
// about it. Allow asks macOS right after the click; a denial links to its
// pane in System Settings; a Screen Recording grant that waits for a restart
// offers Relaunch. Every row looks again when the window comes back.
import { useEffect, useState, type ReactElement } from 'react'
import { AudioLines, Bell, CalendarDays, Camera, HardDrive, ListChecks, MapPin, Mic, MonitorUp } from 'lucide-react'
import type { CalendarStatus } from '@shared/calendar'
import type { ScreenAccess } from '@shared/speech'
import { systemPermissionRows, type SystemPermission, type SystemRow, type SystemRowState } from '@shared/systemPermissions'
import { call } from '../../api'
import { useT, type MessageKey } from '../../i18n/useT'
import { Badge, Button, ErrorState, SkeletonRows, useConfirm, type BadgeTone } from '../../ui'
import { useEvent, useLocalPreference, useResource } from '../data'
import { Card, Notice, Row, Section } from '../kit'
import { systemRowNote } from '../logic/permissions'

const ICONS: Record<SystemPermission, ReactElement> = {
  microphone: <Mic />,
  speech: <AudioLines />,
  screen: <MonitorUp />,
  camera: <Camera />,
  location: <MapPin />,
  calendars: <CalendarDays />,
  reminders: <ListChecks />,
  notifications: <Bell />,
  'full-disk': <HardDrive />,
}

const STATE: Record<SystemRowState, { tone: BadgeTone; key: MessageKey }> = {
  granted: { tone: 'success', key: 'permissionsHub.state.granted' },
  denied: { tone: 'danger', key: 'permissionsHub.state.denied' },
  restricted: { tone: 'warning', key: 'permissionsHub.state.restricted' },
  'not-determined': { tone: 'neutral', key: 'permissionsHub.state.notDetermined' },
  relaunch: { tone: 'warning', key: 'permissionsHub.state.relaunch' },
  unknown: { tone: 'neutral', key: 'permissionsHub.state.unknown' },
  managed: { tone: 'neutral', key: 'permissionsHub.state.managed' },
  unavailable: { tone: 'neutral', key: 'permissionsHub.state.unavailable' },
}

/** Calendar's kinds by their row. */
const CALENDAR_KIND = { calendars: 'events', reminders: 'reminders' } as const

const quiet = <T,>(p: Promise<T> | T): Promise<T | null> => Promise.resolve(p).catch(() => null)

export function MacPermissionsSection(): ReactElement {
  const t = useT()
  const ask = useConfirm()
  const report = useResource(() => call('systemPermissions', 'status'))
  const calendar = useResource<CalendarStatus | null>(() => quiet(call('calendar', 'status')))
  // Main's own Screen Recording answer, where offered: it remembers whether Apex asked.
  const screen = useResource<ScreenAccess | null>(() => quiet(call('speech', 'screenAccess')))
  // Without it, the same note the Transcription checklist keeps.
  const [screenAsked, setScreenAsked] = useLocalPreference<'yes' | 'no'>('apex.speech.screenAsked', 'no', ['yes', 'no'])
  const [busy, setBusy] = useState<SystemPermission | null>(null)
  const [opened, setOpened] = useState<ReadonlySet<SystemPermission>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEvent('calendar', (e) => calendar.set(e.status))
  useEvent('speech-permissions', () => {
    void report.reload()
    void screen.reload()
  })

  // Back from System Settings (focus), or the tab shown again: look again straight away.
  useEffect(() => {
    const recheck = (): void => {
      if (document.visibilityState !== 'visible') return
      void report.reload()
      void calendar.reload()
      void screen.reload()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [report.reload, calendar.reload, screen.reload])

  const allow = async (kind: SystemPermission): Promise<void> => {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'calendars' || kind === 'reminders') calendar.set(await call('calendar', 'requestAccess', CALENDAR_KIND[kind]))
      else if (kind === 'location' || kind === 'notifications' || kind === 'full-disk') return
      else if (kind === 'screen' && screen.data) {
        setScreenAsked('yes')
        screen.set(await call('speech', 'requestScreen'))
        void report.reload()
      } else {
        if (kind === 'screen') setScreenAsked('yes')
        report.set(await call('systemPermissions', 'request', kind))
      }
    } catch {
      setError(t('permissionsHub.request.failed'))
    } finally {
      setBusy(null)
    }
  }

  const openSettings = (kind: SystemPermission): void => {
    setError(null)
    setOpened((prev) => new Set(prev).add(kind))
    void Promise.resolve(call('systemPermissions', 'openSettings', kind)).catch(() => setError(t('permissionsHub.request.failed')))
  }

  const relaunch = async (): Promise<void> => {
    const ok = await ask({ title: t('permissionsHub.relaunch.title'), message: t('permissionsHub.relaunch.message'), confirmLabel: t('permissionsHub.relaunch.confirm') })
    if (!ok) return
    try {
      await call('flags', 'relaunch')
    } catch {
      setError(t('permissionsHub.relaunch.failed'))
    }
  }

  const action = (row: SystemRow, title: string): ReactElement | null => {
    if (row.action === 'allow') {
      return (
        <Button size="sm" loading={busy === row.kind} disabled={busy !== null && busy !== row.kind} aria-label={t('permissionsHub.action.allowLabel', { permission: title })} onClick={() => void allow(row.kind)}>
          {t('permissionsHub.action.allow')}
        </Button>
      )
    }
    if (row.action === 'open-settings') {
      return (
        <Button size="sm" aria-label={t('permissionsHub.action.openSettingsLabel', { permission: title })} onClick={() => openSettings(row.kind)}>
          {t('permissionsHub.action.openSettings')}
        </Button>
      )
    }
    if (row.action === 'relaunch') {
      return (
        <Button size="sm" variant="primary" onClick={() => void relaunch()}>
          {t('permissionsHub.action.relaunch')}
        </Button>
      )
    }
    return null
  }

  const body = (): ReactElement => {
    if (report.error && !report.data) {
      return <ErrorState compact title={t('permissionsHub.mac.loadError')} message={report.error} onRetry={report.reload} />
    }
    if (!report.data) return <SkeletonRows rows={5} avatar label={t('permissionsHub.mac.loading')} />
    const rows = systemPermissionRows({ report: report.data, calendar: calendar.data, screenAccess: screen.data, screenAsked: screenAsked === 'yes' })
    return (
      <>
        {rows.map((row) => {
          const title = t(`permissionsHub.mac.${row.kind}`)
          const state = STATE[row.state]
          const note = systemRowNote(row, opened.has(row.kind))
          return (
            <Row
              key={row.kind}
              anchor={`mac-${row.kind}`}
              icon={ICONS[row.kind]}
              title={title}
              description={
                <span className="ph-mac__desc">
                  <span>{t(`permissionsHub.mac.${row.kind}.purpose`)}</span>
                  <span className="ph-mac__state" aria-live="polite">
                    <Badge tone={state.tone}>{t(state.key)}</Badge>
                    {note && <span>{t(note)}</span>}
                  </span>
                </span>
              }
            >
              {action(row, title)}
            </Row>
          )
        })}
      </>
    )
  }

  // Off macOS there is nothing here to show.
  if (report.data && !report.data.supported) return <></>
  return (
    <Section title={t('permissionsHub.mac.title')} note={t('permissionsHub.mac.note')}>
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <Card>{body()}</Card>
    </Section>
  )
}
