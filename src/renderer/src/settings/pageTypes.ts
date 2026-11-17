/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings page contract (the settings router). Features export pages
// with this shape: SearchPage, DownloadSettingsPage, SiteSettingsPage
// (the atelier://settings/sites alias), and the PrivacySections and
// NetworkSection components that the router renders in Privacy and General.
import type { ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'

export interface SettingsPageProps {
  settings: SettingsView
  update(patch: SettingsPatch): Promise<void>
  tabId: string
}

export type SettingsPageComponent = (props: SettingsPageProps) => ReactElement
