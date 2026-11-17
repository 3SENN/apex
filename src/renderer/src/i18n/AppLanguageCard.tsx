/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useState, type ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { AVAILABLE_LANGUAGES, isAppLanguageSetting, needsRestart, negotiate, type AppLanguage, type AppLanguageSetting } from '@shared/i18n/locales'
import { call, errorText } from '../api'
import { Button, Select, VisuallyHidden } from '../ui'
import { useResource } from '../settings/data'
import { Card, Notice, Row, Section } from '../settings/kit'
import { useT } from './useT'

// The "Atelier's language" card on the Languages page (ST-27): System (the
// language it resolves to) / English / Nederlands. The chrome relabels at
// once; Chromium's own menus and the spellcheck panel follow at the next
// launch, so a language that differs from the one Atelier started in offers
// Restart now.

const ENDONYM: Record<AppLanguage, string> = Object.fromEntries(AVAILABLE_LANGUAGES.map((l) => [l.code, l.name])) as Record<AppLanguage, string>

/** The language Chromium started in: main launches it with the app language (src/main/i18n/early.ts). */
function launchedLanguage(): AppLanguage {
  try {
    return negotiate([navigator.language])
  } catch {
    return 'en'
  }
}

export function AppLanguageCard({ settings, update }: { settings: SettingsView; update(patch: SettingsPatch): void | Promise<void> }): ReactElement {
  const t = useT()
  const selectId = useId()
  const [launched] = useState(launchedLanguage)
  const [announce, setAnnounce] = useState('')
  const [restartError, setRestartError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const about = useResource(() => call('about', 'info'))
  const system = about.data?.systemLanguages.length ? about.data.systemLanguages : [...navigator.languages]
  const systemLanguage = negotiate(system)
  const value: AppLanguageSetting = isAppLanguageSetting(settings.appLanguage) ? settings.appLanguage : 'system'
  const pending = needsRestart(value, system, launched)

  const options = [
    { value: 'system' as const, label: t('settings.languages.app.system', { name: ENDONYM[systemLanguage] }) },
    ...AVAILABLE_LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
  ]

  const choose = (next: AppLanguageSetting): void => {
    if (next === value) return
    setRestartError(null)
    const resolved = next === 'system' ? systemLanguage : next
    void Promise.resolve(update({ appLanguage: next })).then(() => setAnnounce(t('settings.languages.app.changed', { name: ENDONYM[resolved] })))
  }

  const restart = async (): Promise<void> => {
    setRestarting(true)
    setRestartError(null)
    try {
      await call('flags', 'relaunch')
    } catch (err) {
      setRestartError(`${t('settings.languages.app.restart.failed')} ${errorText(err)}`.trim())
    } finally {
      setRestarting(false)
    }
  }

  const resolvedNow = value === 'system' ? systemLanguage : value
  return (
    <Section title={t('settings.languages.app.title')}>
      <Card>
        <Row
          anchor="app-language"
          title={t('settings.languages.app.label')}
          description={
            settings.languages.mode === 'system'
              ? `${t('settings.languages.app.description')} ${t('settings.languages.app.followsSystem', { name: ENDONYM[resolvedNow] })}`
              : t('settings.languages.app.description')
          }
          htmlFor={selectId}
        >
          <Select id={selectId} size="sm" value={value} options={options} onChange={(next) => choose(next)} />
        </Row>
        {pending && (
          <Notice
            tone="info"
            action={
              <Button size="sm" variant="secondary" loading={restarting} onClick={() => void restart()}>
                {t('settings.languages.app.restart.now')}
              </Button>
            }
          >
            <strong>{t('settings.languages.app.restart.title')}</strong> {t('settings.languages.app.restart.body')}
          </Notice>
        )}
        {restartError && <Notice tone="error">{restartError}</Notice>}
        <VisuallyHidden>
          <span aria-live="polite">{announce}</span>
        </VisuallyHidden>
      </Card>
    </Section>
  )
}
