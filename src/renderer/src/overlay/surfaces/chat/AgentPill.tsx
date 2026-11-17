/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties, ReactElement } from 'react'
import { MessageCircleQuestionMark } from 'lucide-react'
import { accentVariables } from '@shared/accent'
import type { AgentPillProps } from '@shared/overlay/chat'
import { useT } from '../../../i18n/useT'
import type { SurfaceComponentProps } from '../../types'
import { pillText } from './logic'
import './atWork.css'

// While the panel is closed, a small pill under the chat button
// says a chat is working or needs you. A click opens the panel on it.

export function AgentPill({ props, resolve, exiting }: SurfaceComponentProps<AgentPillProps>): ReactElement {
  const t = useT()
  const { title, detail } = pillText(props)
  const style = { ...accentVariables(props.companion.accent), ['--at-glow' as string]: props.companion.glow } as CSSProperties
  return (
    <button
      type="button"
      className="at-pill"
      data-mode={props.mode}
      data-exiting={exiting || undefined}
      style={style}
      onClick={() => resolve('open')}
      aria-label={`${title}. ${t('atWork.pill.open')}`}
    >
      <span className="at-pill__mark" aria-hidden="true">
        {props.mode === 'approval' ? <MessageCircleQuestionMark /> : <i />}
      </span>
      <span className="at-pill__title">{title}</span>
      {detail && <span className="at-pill__detail">{detail}</span>}
    </button>
  )
}
