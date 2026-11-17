/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { Mic } from 'lucide-react'
import { useT } from '../i18n/useT'
import type { MeetingsFilter } from './logic'

// The Meetings empty state (DS-105): Apex's own still explainer in the
// 416×234 media slot (sound becoming a transcript becoming notes), drawn in
// tokens so it follows the theme, then a line of help and the start action.

const WAVE = [6, 14, 22, 12, 28, 18, 9, 24, 32, 16, 8, 20, 26, 11, 6]

function Illustration(): ReactElement {
  return (
    <svg className="mt-explainer__art" viewBox="0 0 416 234" role="img" aria-hidden="true">
      <rect className="mt-art__ground" x="0" y="0" width="416" height="234" rx="16" />
      {/* Sound, on the left */}
      <g transform="translate(36 117)">
        <circle className="mt-art__mic-ring" cx="22" cy="0" r="22" />
        <rect className="mt-art__mic" x="16" y="-12" width="12" height="18" rx="6" />
        <path className="mt-art__mic-stand" d="M12 2a10 10 0 0 0 20 0M22 12v6" fill="none" />
        {WAVE.map((h, i) => (
          <rect key={i} className="mt-art__wave" x={58 + i * 7} y={-h / 2} width="4" height={h} rx="2" />
        ))}
      </g>
      {/* Arrow */}
      <path className="mt-art__arrow" d="M178 117h22m-6-6 6 6-6 6" fill="none" />
      {/* Transcript bubbles, in the middle */}
      <g transform="translate(214 64)">
        <rect className="mt-art__bubble" x="0" y="0" width="76" height="22" rx="11" />
        <rect className="mt-art__bubble mt-art__bubble--you" x="18" y="30" width="58" height="22" rx="11" />
        <rect className="mt-art__bubble" x="0" y="60" width="66" height="22" rx="11" />
        <rect className="mt-art__bubble mt-art__bubble--you" x="10" y="90" width="66" height="22" rx="11" />
      </g>
      {/* Notes card, on the right */}
      <g transform="translate(304 52)">
        <rect className="mt-art__card" x="0" y="0" width="80" height="130" rx="12" />
        <rect className="mt-art__line mt-art__line--strong" x="12" y="16" width="44" height="7" rx="3.5" />
        {[40, 62, 84, 106].map((y, i) => (
          <g key={y}>
            <circle className={i < 2 ? 'mt-art__tick mt-art__tick--done' : 'mt-art__tick'} cx="17" cy={y + 3} r="5" />
            <rect className="mt-art__line" x="28" y={y} width={i % 2 ? 30 : 40} height="6" rx="3" />
          </g>
        ))}
      </g>
    </svg>
  )
}

export function MeetingsExplainer({ filter, onStart, disabled }: { filter: MeetingsFilter; onStart(): void; disabled: boolean }): ReactElement {
  const t = useT()
  const recordings = filter === 'recordings'
  return (
    <div className="mt-explainer">
      <div className="mt-explainer__media">
        <Illustration />
      </div>
      <p className="mt-explainer__title">{recordings ? t('meetings.empty.recordings') : t('meetings.empty')}</p>
      <p className="mt-explainer__text">{recordings ? t('meetings.empty.recordingsHint') : t('meetings.empty.hint')}</p>
      <button type="button" className="mt-start mt-start--quiet" onClick={onStart} disabled={disabled}>
        <Mic aria-hidden="true" />
        {recordings ? t('meetings.start.recording') : t('meetings.start.meeting')}
      </button>
    </div>
  )
}
