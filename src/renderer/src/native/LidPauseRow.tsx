/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { useT } from '../i18n/useT'
import { Card, Section, SwitchRow } from '../settings/kit'
import { isMac } from '../ui'

/** The row's data-settings-anchor (the settings search and smoke find it by this). */
export const LID_PAUSE_ANCHOR = 'lid-pause'

// The Settings › Transcription row: pause a meeting recording while the lid
// is closed. Only a Mac reports its lid, so elsewhere the same setting is
// worded as sleep. `bare` renders just the switch row, for a page that
// already has a card.
export function LidPauseRow({ settings, update, bare = false }: { settings: SettingsView; update(patch: SettingsPatch): void | Promise<void>; bare?: boolean }): ReactElement {
  const t = useT()
  const row = (
    <SwitchRow
      anchor={LID_PAUSE_ANCHOR}
      label={t(isMac ? 'native.lid.row' : 'native.lid.rowSleep')}
      description={t(isMac ? 'native.lid.description' : 'native.lid.descriptionSleep')}
      checked={settings.pauseMeetingsOnLidClose}
      onChange={(pauseMeetingsOnLidClose) => void update({ pauseMeetingsOnLidClose })}
    />
  )
  if (bare) return row
  return (
    <Section title={t('native.lid.section')}>
      <Card>{row}</Card>
    </Section>
  )
}
