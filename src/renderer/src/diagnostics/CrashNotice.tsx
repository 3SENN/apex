/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useLayoutEffect, useRef, type ReactElement } from 'react'
import { LifeBuoy, X } from 'lucide-react'
import type { DiagnosticsSurfaceProps } from '@shared/overlay/diagnostics'
import { useT } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { Button, IconButton, cx } from '../ui'
import './diagnostics.css'

// The crash notice: a window card on the launch after Atelier
// ended uncleanly. Report a problem (with any kept crash dumps switched
// on), Dismiss, and, while crash reports are off, keep them from now on.

export type CrashNoticeProps = DiagnosticsSurfaceProps['crash-notice']
export type CrashNoticeChoice = 'report' | 'keep' | 'dismiss'

export interface CrashCardProps extends CrashNoticeProps {
  onChoose(choice: CrashNoticeChoice): void
  exiting?: boolean
}

/** The card itself; the overlay surface and the chrome's fallback both draw it. */
export function CrashCard({ dumps, crashReportsOn, onChoose, exiting = false }: CrashCardProps): ReactElement {
  const t = useT()
  const titleId = useId()
  const bodyId = useId()
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    primary.current?.focus({ preventScroll: true })
  }, [])
  return (
    <section
      className={cx('dg-crash', exiting && 'dg-crash--exiting')}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onChoose('dismiss')
      }}
    >
      <span className="dg-crash__icon" aria-hidden>
        <LifeBuoy />
      </span>
      <div className="dg-crash__text">
        <h2 id={titleId} className="dg-crash__title">
          {t('diagnostics.crash.title')}
        </h2>
        <p id={bodyId} className="dg-crash__body">
          {dumps > 0 ? t('diagnostics.crash.bodyDumps', { count: dumps }) : t('diagnostics.crash.body')}
        </p>
        <div className="dg-crash__actions">
          <Button ref={primary} size="sm" variant="primary" onClick={() => onChoose('report')}>
            {t('diagnostics.crash.report')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChoose('dismiss')}>
            {t('diagnostics.crash.dismiss')}
          </Button>
        </div>
        {!crashReportsOn && (
          <button type="button" className="dg-link" onClick={() => onChoose('keep')}>
            {t('diagnostics.crash.keep')}
          </button>
        )}
      </div>
      <IconButton className="dg-crash__close" label={t('diagnostics.crash.dismiss')} tooltip={false} size="sm" icon={<X />} onClick={() => onChoose('dismiss')} />
    </section>
  )
}

/** The overlay surface: resolves with the choice. */
export function CrashNotice({ props, resolve, reportBounds, exiting }: SurfaceComponentProps<CrashNoticeProps>): ReactElement {
  const wrap = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const r = wrap.current?.getBoundingClientRect()
    if (r) reportBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
  }, [])
  return (
    <div ref={wrap} className="dg-crash-wrap">
      <CrashCard {...props} exiting={exiting} onChoose={(choice) => resolve(choice)} />
    </div>
  )
}
