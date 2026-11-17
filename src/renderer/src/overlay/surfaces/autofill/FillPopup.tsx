/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { CreditCard, Fingerprint, KeyRound, MapPin, Settings2 } from 'lucide-react'
import type { FillPopupProps, FillRow } from '@shared/autofill'
import { call } from '../../../api'
import { useT, type MessageKey } from '../../../i18n/useT'
import { cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { brandMark, loadableIcon, pickOutcome, siteInitial, splitRows } from './logic'

// The fill popups (OV-25, OV-26, OV-29, SS-02): saved logins, cards or
// addresses under the focused field, in any frame. Focus stays in the page:
// the arrow keys, Return and Esc reach main from the page preload, and main
// sends the highlighted row back as `activeId`. A pick only counts once the
// popup has been visible and still for half a second; main enforces that, so
// this surface just reports when it is on screen and where.

export type FillPopupKind = 'login' | 'card' | 'address'

const LABEL: Record<FillPopupKind, MessageKey> = {
  login: 'autofill.popup.loginsLabel',
  card: 'autofill.popup.cardsLabel',
  address: 'autofill.popup.addressesLabel',
}

function RowIcon({ row, site }: { row: FillRow; site: string }): ReactElement {
  const [broken, setBroken] = useState(false)
  if (row.kind === 'generated') return <KeyRound size={16} />
  if (row.kind === 'passkey') return <Fingerprint size={16} />
  if (row.kind === 'address') return <MapPin size={16} />
  if (row.kind === 'card') {
    const mark = brandMark(row.icon)
    return mark ? <span className="afp-row__brand">{mark}</span> : <CreditCard size={16} />
  }
  if (loadableIcon(row.icon) && !broken) return <img className="afp-row__favicon" src={row.icon} alt="" width={16} height={16} draggable={false} onError={() => setBroken(true)} />
  return <span className="afp-row__initial">{siteInitial(site)}</span>
}

export function makeFillPopup(kind: FillPopupKind) {
  return function FillPopup({ props, close, anchorRect, exiting }: SurfaceComponentProps<FillPopupProps>): ReactElement {
    const t = useT()
    const listId = useId()
    const { items, manage } = splitRows(props.rows)
    const generated = items.some((r) => r.kind === 'generated')
    const [status, setStatus] = useState<string | null>(null)
    const busy = useRef(false)
    const activeRef = useRef<HTMLDivElement | null>(null)

    // Tell main where the popup is once it has painted, and again whenever it moves or resizes (OV-25).
    const rect = anchorRect ?? props.anchorRect
    const rectKey = `${rect.x},${rect.y},${rect.width},${rect.height}`
    useEffect(() => {
      if (exiting) return
      let second = 0
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          if (document.visibilityState === 'visible') void call('autofill', 'surfaceShown', props.popupId, rect).catch(() => undefined)
        })
      })
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') void call('autofill', 'surfaceShown', props.popupId, rect).catch(() => undefined)
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }, [props.popupId, rectKey, exiting]) // eslint-disable-line react-hooks/exhaustive-deps -- rectKey stands for rect

    // Keep the highlighted row in view when the list scrolls.
    useEffect(() => {
      activeRef.current?.scrollIntoView({ block: 'nearest' })
    }, [props.activeId])

    const pick = async (row: FillRow): Promise<void> => {
      if (busy.current) return
      busy.current = true
      setStatus(null)
      try {
        const outcome = pickOutcome(await call('autofill', 'pick', props.popupId, row.id))
        if (outcome === 'close') close()
        else if (outcome === 'cancelled') setStatus(t('autofill.popup.authCancelled'))
      } catch {
        close()
      } finally {
        busy.current = false
      }
    }

    const writeOwn = (): void => {
      void call('autofill', 'dismiss', props.popupId).catch(() => undefined)
      close()
    }

    const active = items.find((r) => r.id === props.activeId) ?? null
    const site = props.siteLabel
    return (
      <div className={cx('afp', props.embeddingSite && 'afp--framed')} style={{ width: rect.width, height: rect.height }} onMouseDown={(e) => e.preventDefault()}>
        {props.embeddingSite && (
          <p className="afp__header" title={t('autofill.popup.crossSite', { site, embedding: props.embeddingSite })}>
            {t('autofill.popup.crossSite', { site, embedding: props.embeddingSite })}
          </p>
        )}
        {items.length === 0 ? (
          <div className="afp__empty" role="status">
            <span className="afp-row__icon" aria-hidden="true">
              <KeyRound size={16} />
            </span>
            <span className="afp__empty-text">
              <span className="afp__empty-title">{t('autofill.popup.noLogins')}</span>
              <span className="afp__empty-hint">{t('autofill.popup.noLoginsHint')}</span>
            </span>
          </div>
        ) : (
          <div id={listId} className="afp__list" role="listbox" aria-label={t(LABEL[kind], { site })} aria-activedescendant={active ? `${listId}-${active.id}` : undefined}>
            {items.map((row) => {
              const selected = row.id === props.activeId
              return (
                <div
                  key={row.id}
                  id={`${listId}-${row.id}`}
                  ref={selected ? activeRef : undefined}
                  role="option"
                  aria-selected={selected}
                  className={cx('afp-row', selected && 'afp-row--active', row.kind === 'generated' && 'afp-row--generated')}
                  onClick={() => void pick(row)}
                >
                  <span className="afp-row__icon" aria-hidden="true">
                    <RowIcon row={row} site={site} />
                  </span>
                  <span className="afp-row__text">
                    <span className="afp-row__title">{row.title}</span>
                    {row.subtitle && <span className="afp-row__subtitle">{row.subtitle}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {(manage || generated) && (
          <div className="afp__footer">
            {generated && (
              <button type="button" className="afp__link" tabIndex={-1} onClick={writeOwn}>
                {t('autofill.popup.writeOwn')}
              </button>
            )}
            {manage && (
              <button type="button" className="afp__link afp__link--end" tabIndex={-1} onClick={() => void pick(manage)}>
                <Settings2 size={13} aria-hidden="true" />
                {manage.title}
              </button>
            )}
          </div>
        )}
        <span className="ui-sr-only" aria-live="polite">
          {status ? '' : (active ? `${active.title}${active.subtitle ? `, ${active.subtitle}` : ''}` : items.length > 0 ? t('autofill.popup.keys', { count: items.length }) : '')}
        </span>
        {status && (
          <p className="afp__status" role="alert">
            {status}
          </p>
        )}
      </div>
    )
  }
}
