/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type ReactElement } from 'react'
import { AudioLines, Music } from 'lucide-react'
import { useT } from '../../i18n/useT'
import { IconButton, cx } from '../../ui'
import { useMedia } from './mediaStore'
import { useNowPlayingPopover } from './useNowPlayingPopover'
import './media.css'

// The toolbar's now-playing button (MD-01), like the media control other
// browsers keep in their toolbar: it shows while any tab of the window (or
// another window of the profile) plays or holds paused media, and opens the
// popover with every source. Its bars sway while something plays (held still
// under reduced motion). Settings › Appearance hides it.

export function NowPlayingButton(): ReactElement | null {
  const t = useT()
  const { state, button } = useMedia()
  const anchor = useRef<HTMLSpanElement>(null)
  const popover = useNowPlayingPopover(anchor, state)
  const count = state.sources.length
  if (!button || count === 0) return null
  const playing = state.sources.some((s) => s.playing)
  const label = count > 1 ? `${t('media.button.label')}, ${t('media.button.count', { count: state.sources.filter((s) => s.playing).length || count })}` : `${t('media.button.label')}: ${state.sources[0]!.title}`
  return (
    <span ref={anchor} className={cx('np-button', playing && 'np-button--playing')}>
      <IconButton
        label={label}
        tooltip={t('media.button.label')}
        icon={playing ? <AudioLines /> : <Music />}
        className={popover.open ? 'ui-icon-btn--on' : undefined}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        badge={count > 1 ? <span className="np-button__count" aria-hidden>{count}</span> : undefined}
        onClick={popover.toggle}
      />
    </span>
  )
}
