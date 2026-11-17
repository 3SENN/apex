/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useState, type ReactElement } from 'react'
import { Music, Pause, PictureInPicture2, Play, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react'
import { MEDIA_RATES, nearestRate, rateLabel, type MediaSource } from '@shared/media'
import { currentLocale } from '@shared/i18n/core'
import { useT } from '../../i18n/useT'
import { IconButton, Select, cx } from '../../ui'
import { focusMedia, runMedia, setMediaRate, toggleMediaPip } from './mediaStore'
import './media.css'

// One now-playing source (MD-01): artwork (or the site's icon), title, artist
// and site, then previous, play or pause and next. The full row (the popover)
// adds speed, picture-in-picture, mute and dismiss; the compact one (the
// sidebar card) keeps the transport. Clicking the artwork or title goes to
// the tab. Every button has its own name, so a screen reader hears each one.

function Artwork({ source, size }: { source: MediaSource; size: number }): ReactElement {
  const t = useT()
  const [broken, setBroken] = useState<string | null>(null)
  const src = source.artwork && broken !== source.artwork ? source.artwork : source.favicon && broken !== source.favicon ? source.favicon : null
  const art = src !== null && src === source.artwork
  return (
    <span className={cx('np-art', art && 'np-art--cover')} style={{ width: size, height: size }} aria-hidden={!art}>
      {src ? (
        <img src={src} alt={art ? t('media.source.artwork', { title: source.title }) : ''} draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(src)} />
      ) : (
        <Music aria-hidden />
      )}
    </span>
  )
}

export function sourceMeta(source: MediaSource, t: ReturnType<typeof useT>): string {
  const where = source.elsewhere ? t('media.source.elsewhere') : source.visible ? t('media.source.thisTab') : ''
  return [source.artist, source.site, where].filter(Boolean).join(' · ')
}

export function SourceRow({ source, compact = false, onGo, autoFocus = false }: { source: MediaSource; compact?: boolean; onGo?: () => void; autoFocus?: boolean }): ReactElement {
  const t = useT()
  const id = source.tabId
  const meta = sourceMeta(source, t)
  const locale = currentLocale()
  const rate = nearestRate(source.rate)
  const metaId = useId()
  return (
    <div className={cx('np-source', compact && 'np-source--compact', source.playing && 'np-source--playing')} data-tab-id={id}>
      <button
        type="button"
        className="np-source__page"
        data-np-focus
        data-autofocus={autoFocus ? '' : undefined}
        aria-label={t('media.source.goToNamed', { title: source.title })}
        aria-describedby={metaId}
        onClick={() => {
          focusMedia(id)
          onGo?.()
        }}
      >
        <Artwork source={source} size={compact ? 32 : 44} />
        <span className="np-source__text">
          <span className="np-source__title">{source.title}</span>
          <span className="np-source__meta" id={metaId}>
            {!source.playing && <span className="np-source__state">{t('media.source.paused')} · </span>}
            {meta}
          </span>
        </span>
      </button>
      <span className="np-source__transport">
        {source.canPrevious && <IconButton size="sm" label={t('media.source.previous')} icon={<SkipBack />} onClick={() => runMedia(id, 'previous')} />}
        <IconButton
          size="sm"
          variant={compact ? 'ghost' : 'subtle'}
          className="np-source__play"
          label={source.playing ? t('media.source.pause') : t('media.source.play')}
          icon={source.playing ? <Pause /> : <Play />}
          onClick={() => runMedia(id, source.playing ? 'pause' : 'play')}
        />
        {source.canNext && <IconButton size="sm" label={t('media.source.next')} icon={<SkipForward />} onClick={() => runMedia(id, 'next')} />}
        {compact && <IconButton size="sm" label={t('media.source.dismiss')} icon={<X />} onClick={() => runMedia(id, 'dismiss')} />}
      </span>
      {!compact && (
        <span className="np-source__extras">
          <Select
            size="sm"
            className="np-source__speed"
            aria-label={t('media.source.speedNow', { rate: rateLabel(rate, locale) })}
            value={String(rate)}
            options={MEDIA_RATES.map((r) => ({ value: String(r), label: r === 1 ? t('media.speed.normal') : rateLabel(r, locale) }))}
            onChange={(value) => setMediaRate(id, Number(value))}
          />
          <span className="np-source__spacer" />
          {(source.canPip || source.pip) && (
            <IconButton size="sm" label={source.pip ? t('media.source.pipLeave') : t('media.source.pip')} pressed={source.pip} icon={<PictureInPicture2 />} onClick={() => toggleMediaPip(id)} />
          )}
          <IconButton size="sm" label={source.muted ? t('media.source.unmute') : t('media.source.mute')} pressed={source.muted} icon={source.muted ? <VolumeX /> : <Volume2 />} onClick={() => runMedia(id, source.muted ? 'unmute' : 'mute')} />
          <IconButton size="sm" label={t('media.source.dismiss')} icon={<X />} onClick={() => runMedia(id, 'dismiss')} />
        </span>
      )}
    </div>
  )
}
