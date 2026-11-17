/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { LinkBubbleProps, LinkPreviewProps, PageProgressProps } from '@shared/overlay/address'
import type { LoadStage } from '@shared/tabs'
import { displayHost } from '@shared/domains'
import { Globe } from 'lucide-react'
import { useT } from '../../../i18n/useT'
import { cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'

// The passive address surfaces: they never take input or focus. The link bubble
// (SH-46) sits at the bottom left of its tab's pane; the progress bar
// (SS-01, DS-28) runs along the pane's top edge; the preview card
// opens under a link while ⌥ is held or after a long press.

/** How far along the bar is at each stage; it never moves between stages (DS-28). */
export const PROGRESS_AT: Record<LoadStage, number> = { idle: 0, started: 0.18, response: 0.5, 'dom-ready': 0.82, finished: 1 }

export function LinkBubble({ props }: SurfaceComponentProps<LinkBubbleProps>): ReactElement {
  return (
    <div className="lb-area">
      <div className="lb" role="status" aria-live="off">
        {props.text}
      </div>
    </div>
  )
}

export function PageProgress({ props }: SurfaceComponentProps<PageProgressProps>): ReactElement {
  const t = useT()
  const fraction = PROGRESS_AT[props.stage]
  return (
    <div className="pp-area">
      <div
        className={cx('pp', props.stage === 'finished' && 'pp--done')}
        role="progressbar"
        aria-label={t('address.load.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <span className="pp__fill" style={{ transform: `scaleX(${fraction})` }} />
      </div>
    </div>
  )
}

export function LinkPreviewCard({ props }: SurfaceComponentProps<LinkPreviewProps>): ReactElement {
  const t = useT()
  const { preview, failed } = props
  const host = preview?.domain || displayHost(props.url).display || props.url
  const loading = !preview && !failed
  return (
    <div className={cx('lpv', loading && 'lpv--loading')} role="tooltip" aria-label={t('address.link.preview')} aria-busy={loading}>
      {preview?.image && <img className="lpv__image" src={preview.image} alt="" draggable={false} />}
      <div className="lpv__body">
        {loading ? (
          <>
            <span className="lpv__skeleton lpv__skeleton--title" aria-hidden />
            <span className="lpv__skeleton" aria-hidden />
            <span className="ui-sr-only">{t('address.link.previewLoading')}</span>
          </>
        ) : failed ? (
          <p className="lpv__failed">{t('address.link.previewFailed')}</p>
        ) : (
          <>
            {preview?.title && <p className="lpv__title">{preview.title}</p>}
            {preview?.description && <p className="lpv__desc">{preview.description}</p>}
          </>
        )}
        <p className="lpv__domain">
          <Globe size={12} aria-hidden />
          <span>{preview?.siteName && preview.siteName !== host ? `${preview.siteName} · ${host}` : host}</span>
        </p>
      </div>
    </div>
  )
}
