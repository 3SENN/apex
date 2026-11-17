/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, type CSSProperties, type ReactElement } from 'react'
import { RotateCcw } from 'lucide-react'
import { LOOK_ADJUST_GROUPS, LOOK_ADJUST_LIMIT, LOOK_ADJUST_STEP, type CompanionLook, type LookAdjustKey } from '@shared/companion'
import { adjustOf } from '@shared/companionLogic'
import { withAdjust, withoutAdjust } from './logic/adjust'
import { useT, t } from '../i18n/useT'

// DS-120: the part adjustments as labelled sliders, an ink track left of the
// round thumb and a light one to its right. Each value runs -1..1 around the
// part as drawn (0); the rig and the face texture apply them.

interface AdjustSlidersProps {
  look: CompanionLook
  /** `merge` groups a drag into one undo step; `seal` ends it. */
  onChange(look: CompanionLook, merge: string): void
  onSeal(): void
  /** Only these groups (a look-ring panel's slider card); reset then clears just their keys. */
  groups?: ReadonlyArray<(typeof LOOK_ADJUST_GROUPS)[number]['id']>
}

function spoken(value: number): string {
  if (value === 0) return 'as drawn'
  const pct = Math.round(Math.abs(value) * 100)
  return value > 0 ? t('coCard.adjustSliders.more', { pct }) : t('coCard.adjustSliders.less', { pct })
}

export function AdjustSliders({ look, onChange, onSeal, groups }: AdjustSlidersProps): ReactElement {
  const t = useT()
  const base = useId()
  const shown = groups ? LOOK_ADJUST_GROUPS.filter((g) => groups.includes(g.id)) : LOOK_ADJUST_GROUPS
  const keys = shown.flatMap((g) => g.keys.map((k) => k.key))
  const touched = look.adjust !== undefined && (groups ? keys.some((k) => adjustOf(look, k) !== 0) : Object.keys(look.adjust).length > 0)
  const reset = (): CompanionLook => (groups ? keys.reduce((next, k) => withAdjust(next, k, 0), look) : withoutAdjust(look))
  return (
    <div className="co-adjust" role="group" aria-label={t('coCard.adjustSliders.fineTune')}>
      {shown.map((group) => (
        <div key={group.id} className="co-adjust__group">
          {group.keys.map(({ key, label }) => {
            const value = adjustOf(look, key)
            const id = `${base}-${key}`
            const fill = ((value + LOOK_ADJUST_LIMIT) / (LOOK_ADJUST_LIMIT * 2)) * 100
            return (
              <div key={key} className="co-adjust__row">
                <label htmlFor={id} className="co-adjust__label">
                  {label}
                </label>
                <input
                  id={id}
                  className="co-adjust__slider"
                  type="range"
                  min={-LOOK_ADJUST_LIMIT}
                  max={LOOK_ADJUST_LIMIT}
                  step={LOOK_ADJUST_STEP}
                  value={value}
                  aria-valuetext={spoken(value)}
                  style={{ '--fill': `${fill}%` } as CSSProperties}
                  onChange={(e) => onChange(withAdjust(look, key, Number(e.target.value)), `adjust:${key}`)}
                  onPointerUp={onSeal}
                  onKeyUp={onSeal}
                  onBlur={onSeal}
                  onDoubleClick={() => {
                    onChange(withAdjust(look, key, 0), `adjust:${key}`)
                    onSeal()
                  }}
                />
              </div>
            )
          })}
        </div>
      ))}
      <button
        type="button"
        className="co-adjust__reset"
        disabled={!touched}
        onClick={() => {
          onChange(reset(), 'adjust:reset')
          onSeal()
        }}
      >
        <RotateCcw aria-hidden /> {t('coCard.adjustSliders.resetAdjustments')}
      </button>
    </div>
  )
}
