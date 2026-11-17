/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { Mic, Square, X } from 'lucide-react'
import { useT } from '../../i18n/useT'
import { Spinner, cx, useReducedMotion } from '../../ui'
import { levelBars } from './logic'
import { runErrorAction, type Dictation } from './useDictation'
import './dictation.css'

// What dictation shows while it runs (MV-07): a live level meter, the words
// being heard, and Stop; then a short transcribing state; or the error with
// the one action that fixes it. It sits just above the field it fills.

export function LevelBars({ level, bars = 4, className }: { level: number; bars?: number; className?: string }): ReactElement {
  const reduced = useReducedMotion()
  // Reduced motion keeps the meter still: a steady mark that says "listening".
  const heights = reduced ? Array.from({ length: bars }, () => 0.5) : levelBars(level, bars)
  return (
    <span className={cx('dict-level', reduced && 'dict-level--still', className)} aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i} className="dict-level__bar" style={{ transform: `scaleY(${h})` }} />
      ))}
    </span>
  )
}

export interface DictationBarProps {
  dictation: Dictation
  /** Stops and keeps the words in the field (the composer's secondary does the same). */
  onStop(): void
  className?: string
}

export function DictationBar({ dictation, onStop, className }: DictationBarProps): ReactElement | null {
  const t = useT()
  const { state, error, partial, heard, level } = dictation
  if (state === 'error' && error) {
    const action = error.copy.action
    const actionLabel = action?.kind === 'privacy' ? t('meetings.dictation.action.privacy') : action?.kind === 'settings' ? t('meetings.dictation.action.settings') : action?.kind === 'retry' ? t('meetings.dictation.action.retry') : null
    return (
      <div className={cx('dict-bar dict-bar--error', className)} role="alert">
        <Mic className="dict-bar__icon" aria-hidden="true" />
        <span className="dict-bar__text">{t(error.copy.message)}</span>
        {actionLabel && (
          <button type="button" className="dict-bar__action" onClick={() => runErrorAction(error, () => void dictation.start())}>
            {actionLabel}
          </button>
        )}
        <button type="button" className="dict-bar__close" aria-label={t('meetings.dictation.dismiss')} onClick={dictation.dismissError}>
          <X aria-hidden="true" />
        </button>
      </div>
    )
  }
  if (state === 'starting' || state === 'transcribing') {
    return (
      <div className={cx('dict-bar', className)} role="status">
        <Spinner size={12} />
        <span className="dict-bar__text dict-bar__text--muted">{state === 'starting' ? t('meetings.dictation.starting') : t('meetings.dictation.transcribing')}</span>
      </div>
    )
  }
  if (state !== 'listening') return null
  const words = [heard, partial].filter(Boolean).join(' ')
  return (
    <div className={cx('dict-bar dict-bar--listening', className)}>
      <LevelBars level={level} />
      <span className="dict-bar__text" aria-live="polite">
        {words ? <span className="dict-bar__words">{heard}{heard && partial ? ' ' : ''}<span className="dict-bar__partial">{partial}</span></span> : <span className="dict-bar__text--muted">{t('meetings.dictation.listening')}</span>}
      </span>
      <button type="button" className="dict-bar__action" onClick={onStop}>
        <Square aria-hidden="true" className="dict-bar__stop-glyph" />
        {t('meetings.dictation.stop')}
      </button>
    </div>
  )
}
