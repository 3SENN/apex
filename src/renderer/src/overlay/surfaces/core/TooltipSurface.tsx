/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { KeyCaps } from '../../../ui/KeyCaps'
import type { SurfaceComponentProps } from '../../types'
import type { CoreSurfaceProps } from '@shared/overlay/core'

// The dark tooltip (OV-06, DS-95): a 13 px label with the shortcut as small
// lighter key caps, in the passive tier so it never catches a click.
export function TooltipSurface({ props }: SurfaceComponentProps<CoreSurfaceProps['tooltip']>): ReactElement {
  return (
    <div className="ov-tooltip" role="tooltip">
      <span className="ov-tooltip__label">{props.label}</span>
      <KeyCaps shortcutId={props.shortcutId ?? null} tone="inverse" />
    </div>
  )
}
