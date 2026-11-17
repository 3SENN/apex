/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type ReactElement } from 'react'
import { ChevronUp } from 'lucide-react'
import type { MediaSource } from '@shared/media'
import { useT } from '../../i18n/useT'
import { IconButton } from '../../ui'
import { useMedia } from './mediaStore'
import { SourceRow } from './SourceRow'
import { useNowPlayingPopover } from './useNowPlayingPopover'
import './media.css'

// The sidebar's media card (SH-17, now from the media hub, MD-01): the newest
// source that isn't showing, with its artwork, title and site, previous, play
// or pause, next and dismiss. With more than one source, a button opens the
// now-playing popover with all of them. Main picks the card's source; the
// card hides while nothing qualifies.

export function NowPlayingCard(): ReactElement | null {
  const t = useT()
  const { state } = useMedia()
  const anchor = useRef<HTMLElement>(null)
  const popover = useNowPlayingPopover(anchor, state)
  const source: MediaSource | undefined = state.sources.find((s) => s.tabId === state.cardId)
  if (!source) return null
  return (
    <section ref={anchor} className="np-card" aria-label={t('media.hub.title')}>
      <SourceRow source={source} compact />
      {state.sources.length > 1 && (
        <IconButton size="sm" className="np-card__more" label={t('media.source.more')} aria-haspopup="dialog" aria-expanded={popover.open} icon={<ChevronUp />} badge={<span className="np-button__count" aria-hidden>{state.sources.length}</span>} onClick={popover.toggle} />
      )}
    </section>
  )
}
