/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, type ReactElement } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { UpdatesSurfaceProps } from '@shared/overlay/updates'
import { Button } from '../ui'
import { useT } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { CardFrame } from './CardFrame'

// The unsupported-version prompt (`update-unsupported`): Update now, or
// Remind me later (a 3-day snooze that survives restarts). Esc just closes;
// the prompt comes back on the next start.
export function UnsupportedPrompt({ props, resolve, close, exiting }: SurfaceComponentProps<UpdatesSurfaceProps['update-unsupported']>): ReactElement {
  const t = useT()
  const id = useId()
  return (
    <CardFrame modal labelledBy={`${id}-title`} describedBy={`${id}-body`} exiting={exiting} onEscape={close} className="update-card--unsupported">
      <div className="update-card__head">
        <span className="update-card__glyph update-card__glyph--warning" aria-hidden>
          <TriangleAlert size={18} />
        </span>
        <div className="update-card__titles">
          <h2 id={`${id}-title`} className="update-card__title">
            {t('updates.unsupported.title')}
          </h2>
        </div>
      </div>
      <p id={`${id}-body`} className="update-card__body">
        {props.message ?? t('updates.unsupported.body', { below: props.below })}
      </p>
      <div className="update-card__actions">
        <Button variant="secondary" onClick={() => resolve('later')}>
          {t('updates.unsupported.remindLater')}
        </Button>
        <Button variant="primary" onClick={() => resolve('update')} data-autofocus>
          {t('updates.unsupported.updateNow')}
        </Button>
      </div>
    </CardFrame>
  )
}
