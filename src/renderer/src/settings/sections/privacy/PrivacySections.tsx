/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { SettingsPatch } from '@shared/ipc'
import { errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { useToast } from '../../../ui'
import { Card, Section, SwitchRow } from '../../kit'
import type { SettingsPageProps } from '../../pageTypes'

// Settings › Privacy's tracking and clear-on-exit sections,
// rendered by the Privacy page. Third-party cookie blocking and Global
// Privacy Control apply to the next request (main's webRequest mux reads
// them live); clear on exit runs when Apex quits.

type ClearKey = 'cookies' | 'cache' | 'history'

const CLEAR_ROWS: { key: ClearKey; anchor: string; label: 'safety.privacy.clearCookies' | 'safety.privacy.clearCache' | 'safety.privacy.clearHistory'; body: 'safety.privacy.clearCookiesBody' | 'safety.privacy.clearCacheBody' | 'safety.privacy.clearHistoryBody' }[] = [
  { key: 'cookies', anchor: 'clear-on-exit-cookies', label: 'safety.privacy.clearCookies', body: 'safety.privacy.clearCookiesBody' },
  { key: 'cache', anchor: 'clear-on-exit-cache', label: 'safety.privacy.clearCache', body: 'safety.privacy.clearCacheBody' },
  { key: 'history', anchor: 'clear-on-exit-history', label: 'safety.privacy.clearHistory', body: 'safety.privacy.clearHistoryBody' },
]

export function PrivacySections({ settings, update }: SettingsPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const save = (patch: SettingsPatch): void => {
    update(patch).catch((err: unknown) => toast.show({ tone: 'error', message: t('safety.privacy.saveFailed', { message: errorText(err) }) }))
  }
  return (
    <>
      <Section title={t('safety.privacy.title')}>
        <Card>
          <SwitchRow
            anchor="third-party-cookies"
            label={t('safety.privacy.thirdParty')}
            description={t('safety.privacy.thirdPartyBody')}
            checked={settings.blockThirdPartyCookies}
            onChange={(blockThirdPartyCookies) => save({ blockThirdPartyCookies })}
          />
          <SwitchRow
            anchor="global-privacy-control"
            label={t('safety.privacy.gpc')}
            description={t('safety.privacy.gpcBody')}
            checked={settings.globalPrivacyControl}
            onChange={(globalPrivacyControl) => save({ globalPrivacyControl })}
          />
        </Card>
      </Section>
      <Section title={t('safety.privacy.clearTitle')}>
        <Card>
          {CLEAR_ROWS.map((row) => (
            <SwitchRow
              key={row.key}
              anchor={row.anchor}
              label={t(row.label)}
              description={t(row.body)}
              checked={settings.clearOnExit[row.key]}
              onChange={(on) => save({ clearOnExit: { ...settings.clearOnExit, [row.key]: on } })}
            />
          ))}
        </Card>
      </Section>
    </>
  )
}
