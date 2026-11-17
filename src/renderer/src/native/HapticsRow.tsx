/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { useT } from '../i18n/useT'
import { Card, Section, SwitchRow } from '../settings/kit'
import { isMac } from '../ui'

/** The row's data-settings-anchor (the settings search and smoke find it by this). */
export const HAPTICS_ANCHOR = 'haptics'

// The Settings › General row: "Haptic feedback on the trackpad" (macOS
// only; other platforms have no trackpad haptics, so the row is hidden).
// `bare` renders just the switch row, for a page that already has a card.
export function HapticsRow({ settings, update, bare = false }: { settings: SettingsView; update(patch: SettingsPatch): void | Promise<void>; bare?: boolean }): ReactElement | null {
  const t = useT()
  if (!isMac) return null
  const row = (
    <SwitchRow
      anchor={HAPTICS_ANCHOR}
      label={t('native.haptics.row')}
      description={t('native.haptics.description')}
      checked={settings.haptics}
      onChange={(haptics) => void update({ haptics })}
    />
  )
  if (bare) return row
  return (
    <Section title={t('native.haptics.section')}>
      <Card>{row}</Card>
    </Section>
  )
}
