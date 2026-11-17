/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A live input level: the fill follows the average, a thin tick the peak.
// On a decibel scale, so normal speech fills most of it. Under reduced motion
// it moves without easing and redraws a few times a second.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { t } from '@shared/i18n/core'
import { cx, useReducedMotion } from '../ui'
import type { Level } from './hooks'
import { levelToFraction } from './logic'

const REDUCED_INTERVAL_MS = 250

export function LevelMeter({ level, label, disabled = false, className }: { level: Level | null | undefined; label: string; disabled?: boolean; className?: string }): ReactElement {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState<Level | null>(level ?? null)
  const latest = useRef(level)
  latest.current = level

  useEffect(() => {
    if (!reduced) {
      setShown(level ?? null)
      return
    }
    const timer = window.setTimeout(() => setShown(latest.current ?? null), REDUCED_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [level, reduced])

  const fill = levelToFraction(shown?.rms ?? 0)
  const peak = levelToFraction(shown?.peak ?? 0)
  const percent = Math.round(fill * 100)
  return (
    <div
      className={cx('sk-meter', reduced && 'sk-meter--still', disabled && 'sk-meter--off', className)}
      role="meter"
      aria-label={t('speech.levels.meter', { name: label })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span className="sk-meter__fill" style={{ transform: `scaleX(${fill})` }} />
      {peak > 0 && <span className="sk-meter__peak" style={{ left: `calc(${peak * 100}% - 1px)` }} />}
    </div>
  )
}
