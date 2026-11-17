/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-107: one start surface. The new tab, the empty chat page and (scaled
// down) the side panel's empty chat share its corners: the floor toggle and
// notifications at the top right, and one keep-awake button at the bottom
// right. (The empty chat's switcher, floor and top corner are DS-72's
// StartChrome in chat/StartSurface.tsx; the new tab draws its own Lounge.)
import type { ReactElement } from 'react'
import { Coffee, Sofa } from 'lucide-react'
import { apex, errorText } from '../api'
import { useSettingsView } from '../companion-card/useLoaded'
import { useT } from '../i18n/useT'
import { IconButton, cx, toast } from '../ui'
import { InboxButton } from './newtab/Inbox'
import './startSurface.css'

/**
 * DS-112: keep-awake, the app setting ST-22's power-save service reads. A
 * 38 px round button 19 px from the bottom-right corner (32 px in the panel).
 */
export function StartKeepAwake({ compact = false }: { compact?: boolean }): ReactElement {
  const tr = useT()
  const keepAwake = useSettingsView()?.keepAwake === true
  return (
    <div className={cx('nt__corner nt__corner--bottom ss-corner ss-corner--bottom', compact && 'ss-corner--compact')}>
      <IconButton
        label={keepAwake ? tr('tabs.newTab.keepingAwake') : tr('tabs.newTab.keepAwake')}
        icon={<Coffee fill={keepAwake ? 'currentColor' : 'none'} />}
        pressed={keepAwake}
        className="nt__round"
        onClick={() => void apex.settings.set({ keepAwake: !keepAwake }).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))}
      />
    </div>
  )
}

export interface StartCornersProps {
  floorOn: boolean
  onToggleFloor(): void
  /** Extra class on the notifications button (the new tab fades it in last). */
  inboxClassName?: string
}

/**
 * The corner buttons (DS-107): top right, the floor toggle (DS-75) and
 * notifications (DS-112), 38 px round, 4 px apart and 19 px from the edge;
 * bottom right, keep-awake.
 */
export function StartCorners({ floorOn, onToggleFloor, inboxClassName }: StartCornersProps): ReactElement {
  const tr = useT()
  return (
    <>
      <div className="nt__corner ss-corner">
        <IconButton label={tr('tabs.newTab.floor')} icon={<Sofa />} pressed={floorOn} className="nt__round" onClick={onToggleFloor} />
        <InboxButton className={inboxClassName} />
      </div>
      <StartKeepAwake />
    </>
  )
}
