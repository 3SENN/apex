/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Privacy › Permissions (apex://settings/access): every permission
// in one place. This Mac's (macOS only) with live status and the one action
// each needs, then the website permissions by kind with their defaults and
// the websites that have their own answer.
import type { ReactElement } from 'react'
import { apex } from '../../api'
import { useT } from '../../i18n/useT'
import { PageHeader } from '../kit'
import type { SettingsPageProps } from '../pageTypes'
import { MacPermissionsSection } from './MacPermissionsSection'
import { SitePermissionsSection } from './SitePermissionsSection'
import './permissionsHub.css'

export function PermissionsHubPage({ settings, update }: SettingsPageProps): ReactElement {
  const t = useT()
  return (
    <>
      <PageHeader title={t('permissionsHub.title')} description={t('permissionsHub.description')} />
      {apex.platform === 'darwin' && <MacPermissionsSection />}
      <SitePermissionsSection settings={settings} update={update} />
    </>
  )
}
