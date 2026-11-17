/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, type ReactElement } from 'react'
import { z } from 'zod'
import { Download, Hourglass, Redo2, SquareArrowOutUpRight, X, type LucideIcon } from 'lucide-react'
import { type PageNoticeAnswer, type PageNoticeKind, type PageNoticeProps } from '@shared/safety'
import { useT, type MessageKey } from '../../../i18n/useT'
import { Button, IconButton } from '../../../ui'
import { noticeTarget } from '../../../pages/errors/logic'
import type { SurfaceComponentProps, SurfaceModule } from '../../types'
import './popup-blocked.css'

// The page notice (SS-07): Apex stopped something on this page.
// Blocked pop-ups, a blocked frame redirect and blocked automatic downloads
// offer Allow once and Always for this site; an unresponsive page offers
// Wait or Reload. It sits at the bottom of its tab's pane, never takes focus
// from the page, and hides while another tab shows. Esc dismisses.

interface Spec {
  icon: LucideIcon
  title: MessageKey
  detail: MessageKey
  /** The quieter answer first, then the main one. */
  answers: [PageNoticeAnswer, MessageKey][]
}

const SPECS: Record<PageNoticeKind, Spec> = {
  popup: { icon: SquareArrowOutUpRight, title: 'safety.notice.popup', detail: 'safety.notice.popupDetail', answers: [['always', 'safety.notice.always'], ['once', 'safety.notice.allowOnce']] },
  redirect: { icon: Redo2, title: 'safety.notice.redirect', detail: 'safety.notice.redirectDetail', answers: [['always', 'safety.notice.always'], ['once', 'safety.notice.open']] },
  downloads: { icon: Download, title: 'safety.notice.downloads', detail: 'safety.notice.downloadsDetail', answers: [['always', 'safety.notice.always'], ['once', 'safety.notice.allowOnce']] },
  unresponsive: { icon: Hourglass, title: 'safety.notice.unresponsive', detail: 'safety.notice.unresponsiveDetail', answers: [['wait', 'safety.notice.wait'], ['reload', 'safety.notice.reload']] },
}

export function PageNotice({ props, resolve, close }: SurfaceComponentProps<PageNoticeProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const spec = SPECS[props.kind]
  const Icon = spec.icon
  const vars = { count: props.count, host: props.host, target: noticeTarget(props.target) }
  return (
    <div className="pnotice" role="region" aria-label={t('safety.notice.label')} aria-labelledby={titleId}>
      <span className="pnotice__icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="pnotice__text" aria-live="polite">
        <p id={titleId} className="pnotice__title">
          {t(spec.title, vars)}
        </p>
        <p className="pnotice__detail">{t(spec.detail, vars)}</p>
      </div>
      <div className="pnotice__actions">
        {spec.answers.map(([answer, label], i) => (
          <Button key={answer} size="sm" variant={i === spec.answers.length - 1 ? 'primary' : 'ghost'} onClick={() => resolve(answer)}>
            {t(label)}
          </Button>
        ))}
        {props.kind !== 'unresponsive' && <IconButton size="sm" variant="ghost" icon={<X size={14} />} label={t('safety.notice.dismiss')} onClick={close} />}
      </div>
    </div>
  )
}

export const popupBlockedSurface: SurfaceModule<PageNoticeProps> = {
  component: PageNotice,
  props: z
    .object({
      tabId: z.string().min(1).max(128),
      kind: z.enum(['popup', 'redirect', 'downloads', 'unresponsive']),
      host: z.string().max(253),
      target: z.string().max(4096),
      count: z.number().int().min(0).max(100000),
    })
    .strict(),
  // Tied to its tab; a click on the page leaves it open, and it never pulls focus from the page.
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'hide-until-return', layer: 'hint', focus: false, exitMs: 120 },
  placement: 'bottom-center',
  gap: 12,
}

