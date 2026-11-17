/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, type ReactElement } from 'react'
import { CalendarClock, CircleArrowUp, MessagesSquare, Mic } from 'lucide-react'
import type { UpdatesSurfaceProps } from '@shared/overlay/updates'
import { Button } from '../ui'
import { useT } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { CardFrame } from './CardFrame'

// The restart card (`update-restart`): what is still running, then Restart
// now or Restart when they finish. Esc and Not now leave the update ready.
export function RestartCard({ props, resolve, close, exiting }: SurfaceComponentProps<UpdatesSurfaceProps['update-restart']>): ReactElement {
  const t = useT()
  const id = useId()
  const { running, version } = props
  const lines: Array<{ key: string; icon: ReactElement; text: string }> = []
  if (running.chats > 0) lines.push({ key: 'chats', icon: <MessagesSquare size={15} aria-hidden />, text: t('updates.restart.chats', { count: running.chats }) })
  if (running.routines > 0) lines.push({ key: 'routines', icon: <CalendarClock size={15} aria-hidden />, text: t('updates.restart.routines', { count: running.routines }) })
  if (running.meeting) lines.push({ key: 'meeting', icon: <Mic size={15} aria-hidden />, text: t('updates.restart.meeting') })
  const busy = lines.length > 0
  return (
    <CardFrame modal labelledBy={`${id}-title`} describedBy={`${id}-body`} exiting={exiting} onEscape={close} className="update-card--restart">
      <div className="update-card__head">
        <span className="update-card__glyph" aria-hidden>
          <CircleArrowUp size={18} />
        </span>
        <div className="update-card__titles">
          <h2 id={`${id}-title`} className="update-card__title">
            {t('updates.restart.title')}
          </h2>
        </div>
      </div>
      <p id={`${id}-body`} className="update-card__body">
        {version ? t('updates.restart.bodyVersion', { version }) : t('updates.restart.body')}
      </p>
      {busy && (
        <ul className="update-card__list" data-restart-running>
          {lines.map((l) => (
            <li key={l.key} className="update-card__item">
              {l.icon}
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="update-card__actions">
        <Button variant="ghost" onClick={close}>
          {t('updates.restart.cancel')}
        </Button>
        {busy && (
          <Button variant="secondary" onClick={() => resolve('when-idle')} data-autofocus>
            {t('updates.restart.whenDone')}
          </Button>
        )}
        <Button variant="primary" onClick={() => resolve('now')} {...(busy ? {} : { 'data-autofocus': true })}>
          {t('updates.restart.now')}
        </Button>
      </div>
    </CardFrame>
  )
}
