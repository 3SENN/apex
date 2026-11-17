/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { SidebarOptionsSurfaceProps } from '@shared/overlay/tabs'
import { SidebarOptionsBody } from '../../../components/sidebar/SidebarOptions'
import type { SurfaceComponentProps } from '../../types'
import { useT } from '../../../i18n/useT'

// SH-09: sidebar options as an overlay popover under the header button. The
// chrome passes the current options and updates them as each change saves.
export function SidebarOptionsSurface({ props, close }: SurfaceComponentProps<SidebarOptionsSurfaceProps>): ReactElement {
  const t = useT()
  return (
    <div className="side-options side-options--surface ui-popover" role="dialog" aria-label={t('tabs.sidebarOptions.sidebarOptions')}>
      <SidebarOptionsBody options={props.options} onClose={close} />
    </div>
  )
}
