/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { PeekFrameProps } from '@shared/overlay/address'
import { PEEK_HEADER_PX, PEEK_RADIUS_PX, peekHeaderParts, peekLayout } from '@shared/peekLayout'
import { FileText, Lock, Maximize2, TriangleAlert, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { Spinner, cx } from '../ui'
import type { SurfaceComponentProps } from '../overlay/types'

// The peek-frame surface (SH-43): the backdrop over the window and the
// card's header. The peeked page is a native view main places above the
// overlay with the same peekLayout numbers, so the two line up. A click on
// the backdrop, Esc or ✕ closes it ('close'); "Open as tab" resolves
// 'promote'. The card scales in, except under reduced motion.

export function PeekFrame({ props, resolve, viewport, exiting }: SurfaceComponentProps<PeekFrameProps>): ReactElement {
  const t = useT()
  const [full, setFull] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const size = { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight }
  const { card } = peekLayout(size)
  const parts = peekHeaderParts(props.url)

  useEffect(() => setFull(false), [props.url])
  useEffect(() => {
    if (!full) return
    field.current?.focus()
    field.current?.select()
  }, [full])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    if (full) setFull(false)
    else resolve('close')
  }

  return (
    <div className={cx('pk', exiting && 'pk--exiting')} onKeyDown={onKeyDown}>
      <div className="pk__backdrop" aria-hidden onPointerDown={() => resolve('close')} />
      <section
        className="pk__card"
        role="dialog"
        aria-label={t('address.peek.label')}
        style={{ left: card.x, top: card.y, width: card.width, height: card.height, borderRadius: PEEK_RADIUS_PX }}
      >
        <header className="pk__head" style={{ height: PEEK_HEADER_PX }}>
          <span className="pk__state">
            {props.loading ? (
              <Spinner size={13} label={t('address.peek.label')} />
            ) : parts.kind === 'file' ? (
              <FileText size={14} aria-hidden />
            ) : parts.secure ? (
              <Lock size={13} aria-label={t('address.peek.secure')} />
            ) : (
              <TriangleAlert size={14} className="pk__insecure" aria-label={t('address.pill.notSecure')} />
            )}
          </span>
          {full ? (
            <input ref={field} className="pk__url" value={props.url} readOnly aria-label={t('address.peek.showUrl')} onBlur={() => setFull(false)} spellCheck={false} />
          ) : (
            <button type="button" className="pk__where" title={props.title || props.url} aria-label={`${t('address.peek.showUrl')}: ${props.url}`} onClick={() => setFull(true)}>
              <span className="pk__host">{parts.host}</span>
              {parts.path && <span className="pk__path">{parts.path}</span>}
            </button>
          )}
          <button type="button" className="pk__open" onClick={() => resolve('promote')}>
            <Maximize2 size={13} aria-hidden />
            {t('address.peek.openAsTab')}
          </button>
          <button type="button" className="pk__close" aria-label={t('address.peek.close')} title={t('address.peek.close')} onClick={() => resolve('close')}>
            <X size={15} aria-hidden />
          </button>
        </header>
      </section>
    </div>
  )
}
