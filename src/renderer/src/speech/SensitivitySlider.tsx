/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A sensitivity slider with its live meter (ST-21). The scale is
// logarithmic, 0.25× to 4× with 1× in the middle. Saving waits until the
// slider rests, and changes apply from the next recording.
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { t } from '@shared/i18n/core'
import { LevelMeter } from './LevelMeter'
import type { Level } from './hooks'
import { SLIDER_STEPS, formatGain, gainToSlider, sliderToGain } from './logic'

const SAVE_AFTER_MS = 300

export interface SensitivitySliderProps {
  id?: string
  label: string
  value: number
  onCommit(value: number): void
  level: Level | null | undefined
  /** No meter reading is possible (no Screen Recording for call audio). */
  meterOff?: boolean
  disabled?: boolean
}

export function SensitivitySlider({ id, label, value, onCommit, level, meterOff = false, disabled = false }: SensitivitySliderProps): ReactElement {
  const auto = useId()
  const inputId = id ?? auto
  const [position, setPosition] = useState(() => gainToSlider(value))
  const timer = useRef<number | null>(null)
  const commit = useRef(onCommit)
  commit.current = onCommit

  // Settings changed elsewhere (Reset) move the slider too.
  useEffect(() => setPosition(gainToSlider(value)), [value])
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  const gain = sliderToGain(position)
  const text = t('speech.levels.value', { value: formatGain(gain) })
  return (
    <div className="sk-slider">
      <input
        id={inputId}
        className="sk-slider__input"
        type="range"
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={position}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={text}
        style={{ ['--sk-fill' as string]: `${(position / SLIDER_STEPS) * 100}%` }}
        onChange={(e) => {
          const next = Number(e.target.value)
          setPosition(next)
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => {
            timer.current = null
            commit.current(sliderToGain(next))
          }, SAVE_AFTER_MS)
        }}
      />
      <output className="sk-slider__value" htmlFor={inputId}>
        {text}
      </output>
      <LevelMeter level={meterOff ? null : level} label={label} disabled={meterOff} className="sk-slider__meter" />
    </div>
  )
}
