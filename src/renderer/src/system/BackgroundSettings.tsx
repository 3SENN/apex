/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Settings › General rows: open Apex when you log in (read
// live from the OS, never stored), and keep running in the menu bar,
// notification area or system tray when all windows are closed. The second
// row is hidden on a Linux desktop without a tray.
import { useState, type ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import type { LoginItemState } from '@shared/system'
import { apex, call, errorText } from '../api'
import { useEvent, useResource } from '../settings/data'
import { Card, Section } from '../settings/kit'
import { Button, ErrorState, SkeletonRows, Switch } from '../ui'
import { useT, type MessageKey } from '../i18n/useT'
import { backgroundLabels, platformKind, requestLoginItemApproval } from './platform'
import './system.css'

/** Anchors for the settings index (?highlight=…), as the kit's SwitchRow marks them. */
export const OPEN_AT_LOGIN_ANCHOR = 'open-at-login'
export const RUN_IN_BACKGROUND_ANCHOR = 'run-in-background'

function statusNote(state: LoginItemState, win: boolean): MessageKey | null {
  if (state.status === 'requires-approval') return win ? 'system.general.openAtLogin.approval.win' : 'system.general.openAtLogin.approval.mac'
  if (state.status === 'not-found') return 'system.general.openAtLogin.notFound'
  if (!state.supported) return 'system.general.openAtLogin.unpackaged'
  return null
}

export function BackgroundSettings({ settings, update }: { settings: SettingsView; update(patch: SettingsPatch): void | Promise<void> }): ReactElement {
  const t = useT()
  const kind = platformKind(apex.platform)
  const labels = backgroundLabels(kind)
  const system = useResource(async () => {
    const [login, tray] = await Promise.all([call('system', 'loginItem'), call('system', 'trayAvailable')])
    return { login, tray }
  })
  useEvent('login-item', (e) => {
    if (system.data) system.set({ ...system.data, login: e.state })
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setOpenAtLogin = async (on: boolean): Promise<void> => {
    if (busy || !system.data) return
    setBusy(true)
    setError(null)
    try {
      const login = await call('system', 'setOpenAtLogin', on)
      system.set({ ...system.data, login })
      if (on && login.status === 'requires-approval') requestLoginItemApproval()
    } catch (err) {
      setError(t('system.general.openAtLogin.error', { message: errorText(err) }))
    } finally {
      setBusy(false)
    }
  }

  let content: ReactElement
  if (!system.data && system.loading) content = <SkeletonRows rows={2} label={t('system.general.section')} />
  else if (!system.data) content = <ErrorState compact message={t('system.general.openAtLogin.loadError')} onRetry={system.reload} />
  else {
    const { login, tray } = system.data
    const note = statusNote(login, kind === 'win')
    const quiet = settings.runInBackground && tray
    content = (
      <>
        <div data-settings-anchor={OPEN_AT_LOGIN_ANCHOR} className="sp-switch-anchor sys-row" aria-busy={busy || undefined}>
          <Switch
            label={t('system.general.openAtLogin')}
            description={t(quiet ? labels.quiet : 'system.general.openAtLogin.description')}
            checked={login.openAtLogin}
            disabled={!login.supported || busy}
            onChange={(on) => void setOpenAtLogin(on)}
          />
          {note && (
            <div className={login.status === 'requires-approval' || login.status === 'not-found' ? 'sys-note sys-note--warning' : 'sys-note'} role="status">
              <span>{t(note)}</span>
              {login.status === 'requires-approval' && (
                <Button size="sm" onClick={requestLoginItemApproval}>
                  {t('system.general.openAtLogin.review')}
                </Button>
              )}
            </div>
          )}
          {error && (
            <p className="sys-note sys-note--error" role="alert">
              {error}
            </p>
          )}
        </div>
        {tray && (
          <div data-settings-anchor={RUN_IN_BACKGROUND_ANCHOR} className="sp-switch-anchor sys-row">
            <Switch label={t(labels.label)} description={t(labels.description)} checked={settings.runInBackground} onChange={(runInBackground) => void update({ runInBackground })} />
          </div>
        )}
      </>
    )
  }
  return (
    <Section title={t('system.general.section')}>
      <Card>{content}</Card>
    </Section>
  )
}
