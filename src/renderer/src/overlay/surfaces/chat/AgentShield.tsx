/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties, ReactElement } from 'react'
import type { AgentShieldProps } from '@shared/overlay/chat'
import { call } from '../../../api'
import { useT } from '../../../i18n/useT'
import type { SurfaceComponentProps } from '../../types'
import './atWork.css'

// OV-22: while the agent drives, this layer covers the tab in the overlay
// view, so your clicks never land on a page mid-step. It shows a not-allowed
// cursor, a soft inner glow in the companion's colour (DS-26: no stroke, no
// looping) and the agent's own pointer. A click asks the notice to offer
// take over. Page scripts can't reach it: it isn't in the page.

export function AgentShield({ props, exiting }: SurfaceComponentProps<AgentShieldProps>): ReactElement {
  const t = useT()
  const style = { ['--at-glow' as string]: props.companion.glow } as CSSProperties
  const cursor = props.cursor
  return (
    <div
      className="at-shield"
      data-exiting={exiting || undefined}
      style={style}
      // A press anywhere: the notice offers take over (keyboard users have the notice's own button).
      onPointerDown={(e) => {
        e.preventDefault()
        void call('agent', 'nudge', props.tabId)
      }}
      onContextMenu={(e) => e.preventDefault()}
      aria-hidden="true"
      title={t('atWork.shield.label', { name: props.companion.name })}
    >
      <span className="at-shield__glow" />
      {cursor && (
        <svg className="at-shield__cursor" viewBox="0 0 20 24" width="20" height="24" style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} aria-label={t('atWork.shield.cursor', { name: props.companion.name })}>
          {/* Apex's own arrow: rounded, filled in the companion's colour with a light rim. */}
          <path d="M2.5 1.8 L2.5 18.6 Q2.5 20 3.7 19.2 L7.6 15.9 L10.4 22 Q10.9 23 11.9 22.6 L13.6 21.8 Q14.6 21.3 14.1 20.3 L11.4 14.4 L16.4 14.2 Q17.8 14.1 16.8 13.1 L3.9 1.1 Q2.5 0 2.5 1.8 Z" />
        </svg>
      )}
    </div>
  )
}
