/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, type ReactElement } from 'react'
import { Sparkles, X } from 'lucide-react'
import type { UpdatesSurfaceProps } from '@shared/overlay/updates'
import { Button, IconButton } from '../ui'
import { useT } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { CardFrame } from './CardFrame'

// The what's-new card (`whats-new`): a window card in the
// bottom-right corner, shown after an update with every highlight since the
// version you last saw, and again from Help › What's New. It doesn't block
// the page. ✕, Got it and Esc all resolve 'done': only your own close counts
// as seen, so a card its window took away comes back.
export function WhatsNewCard({ props, resolve, exiting }: SurfaceComponentProps<UpdatesSurfaceProps['whats-new']>): ReactElement {
  const t = useT()
  const id = useId()
  const { entry, since } = props
  const done = (): void => resolve('done')
  return (
    <CardFrame modal={false} labelledBy={`${id}-title`} exiting={exiting} onEscape={done} className="update-card--whats-new">
      <div className="update-card__head">
        <span className="update-card__glyph" aria-hidden>
          <Sparkles size={18} />
        </span>
        <div className="update-card__titles">
          <h2 id={`${id}-title`} className="update-card__title">
            {t('updates.whatsNew.title', { version: entry.version })}
          </h2>
          <span className="update-card__eyebrow">{since ? t('updates.whatsNew.since') : entry.title}</span>
        </div>
        <IconButton className="update-card__close" size="sm" label={t('updates.whatsNew.dismiss')} icon={<X size={14} />} onClick={done} tooltip={false} />
      </div>
      <ul className="update-card__highlights">
        {entry.highlights.map((h, i) => (
          <li key={i} className="update-card__highlight">
            <strong>{h.title}</strong>
            <span>{h.body}</span>
          </li>
        ))}
      </ul>
      <div className="update-card__actions">
        <Button variant="primary" onClick={done} data-autofocus>
          {t('updates.whatsNew.close')}
        </Button>
      </div>
    </CardFrame>
  )
}
