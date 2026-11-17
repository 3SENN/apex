/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type KeyboardEvent, type ReactElement } from 'react'
import type { NowPlayingSurfaceProps } from '@shared/overlay/media'
import { SourceRow } from '../../../components/media/SourceRow'
import { useT } from '../../../i18n/useT'
import { EmptyState, cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'

// The now-playing popover (MD-01): every source of the window, playing ones
// first, each with its transport, speed, picture-in-picture, mute and dismiss.
// The one media keys control is marked. Going to a tab closes it; arrow keys
// move between sources and Esc closes. The overlay frame places it under its
// anchor (above when there's no room, as from the sidebar card).

export function NowPlayingPopover({ props, close, exiting }: SurfaceComponentProps<NowPlayingSurfaceProps>): ReactElement {
  const t = useT()
  const root = useRef<HTMLDivElement>(null)
  const sources = props.state.sources
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = root.current
    if (!el) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const stops = [...el.querySelectorAll<HTMLElement>('[data-np-focus]')]
    if (stops.length === 0) return
    e.preventDefault()
    const at = stops.findIndex((s) => s.closest('.np-source') === (document.activeElement as HTMLElement | null)?.closest('.np-source'))
    const next = at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + stops.length) % stops.length
    stops[next]?.focus()
  }

  return (
    <div
      ref={root}
      className="np-pop"
      role="dialog"
      aria-label={t('media.hub.title')}
      data-state={exiting ? 'closing' : 'open'}
      onKeyDown={onKeyDown}
    >
      <header className="np-pop__head">
        <h2 className="np-pop__title">{t('media.hub.title')}</h2>
      </header>
      {sources.length === 0 ? (
        <EmptyState title={t('media.hub.empty')} />
      ) : (
        <ul className="np-pop__list">
          {sources.map((s, i) => (
            <li key={s.tabId} className={cx('np-pop__item', s.active && 'np-pop__item--active')}>
              <SourceRow source={s} onGo={close} autoFocus={i === 0} />
              {s.active && sources.length > 1 && <p className="np-pop__keys">{t('media.hub.mediaKeys')}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
