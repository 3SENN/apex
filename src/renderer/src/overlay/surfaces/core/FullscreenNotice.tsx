/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, type ReactElement } from 'react'
import type { CoreSurfaceProps } from '@shared/overlay/core'
import { useT } from '../../../i18n/useT'
import type { SurfaceComponentProps } from '../../types'

/** How long the notice stays before it fades (OV-13). */
export const FULLSCREEN_NOTICE_MS = 3000

// The full-screen notice (OV-13): a pill at the top centre naming the site
// (or "this page"), saying Esc exits, gone after about three seconds.
export function FullscreenNotice({ props, close }: SurfaceComponentProps<CoreSurfaceProps['fullscreen-notice']>): ReactElement {
  const t = useT()
  useEffect(() => {
    const timer = setTimeout(close, FULLSCREEN_NOTICE_MS)
    return () => clearTimeout(timer)
    // Once per mount; a new full screen opens a new notice.
  }, [])
  const text = props.host ? t('core.fullscreen.notice', { host: props.host }) : t('core.fullscreen.noticeThisPage')
  return (
    <div className="ov-fs-notice" role="status" aria-live="polite">
      {text}
    </div>
  )
}
