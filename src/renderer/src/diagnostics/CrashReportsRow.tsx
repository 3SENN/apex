/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { call, useAppEvent } from '../api'
import { useT } from '../i18n/useT'
import { Card, Section } from '../settings/kit'
import { Switch, useToast } from '../ui'

// The Settings › Privacy row: "Keep crash reports on this
// computer", off by default. Nothing is ever uploaded; turning it off
// deletes the dumps already kept.

export function CrashReportsRow({ settings, update }: { settings: SettingsView; update(patch: SettingsPatch): void | Promise<void> }): ReactElement {
  const t = useT()
  const toast = useToast()
  const [dumps, setDumps] = useState(0)

  useEffect(() => {
    let live = true
    call('diagnostics', 'crashState')
      .then((s) => live && setDumps(s.dumps))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  useAppEvent('crash', (e) => setDumps(e.state.dumps))

  const change = async (crashReports: boolean): Promise<void> => {
    const had = dumps
    await update({ crashReports })
    if (!crashReports && had > 0) toast.show({ tone: 'success', message: t('diagnostics.privacy.deleted') })
  }

  return (
    <Section title={t('diagnostics.privacy.section')}>
      <Card>
        <div data-settings-anchor="crash-reports">
          <Switch label={t('diagnostics.privacy.crashReports')} description={t('diagnostics.privacy.crashReportsHint')} checked={settings.crashReports} onChange={(on) => void change(on)} />
        </div>
      </Card>
    </Section>
  )
}
