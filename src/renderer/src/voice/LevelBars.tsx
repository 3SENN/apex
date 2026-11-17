/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useState, type ReactElement } from 'react'
import type { FloatEvent } from '@shared/float'
import { useFloatEvent } from '../float/api'

// The live microphone level in the voice floats (MV-04): five bars that
// follow the helper's level lines. Under reduced motion it is one still bar
// whose fill shows the level, with no bouncing.

const BARS = [0.55, 0.8, 1, 0.8, 0.55]

export function LevelBars({ reduced, label }: { reduced: boolean; label: string }): ReactElement {
  const [level, setLevel] = useState(0)
  const onEvent = useCallback((e: FloatEvent) => {
    if (e.type === 'level' && e.source === 'mic') setLevel((prev) => prev * 0.4 + Math.min(1, Math.max(e.rms * 3.2, e.peak * 0.9)) * 0.6)
  }, [])
  useFloatEvent(onEvent)
  if (reduced) {
    return (
      <span className="voice-level voice-level--still" role="img" aria-label={label}>
        <span className="voice-level__fill" style={{ width: `${Math.round(Math.max(0.08, level) * 100)}%` }} />
      </span>
    )
  }
  return (
    <span className="voice-level" role="img" aria-label={label}>
      {BARS.map((weight, i) => (
        <span key={i} className="voice-level__bar" style={{ transform: `scaleY(${(0.18 + Math.min(1, level * weight) * 0.82).toFixed(3)})` }} />
      ))}
    </span>
  )
}
