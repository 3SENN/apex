/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { ZoomPopoverProps } from '@shared/overlay/address'
import { Minus, Plus } from 'lucide-react'
import { apex, call } from '../../../api'
import { useT } from '../../../i18n/useT'
import type { SurfaceComponentProps } from '../../types'

// The zoom popover (SH-45): minus, the percentage, plus and reset,
// from the pill's zoom chip. Each press applies at once to every tab on the
// host; reset closes it, since the chip goes too.

export const ZOOM_MIN = 25
export const ZOOM_MAX = 500

export function ZoomPopover({ props, close }: SurfaceComponentProps<ZoomPopoverProps>): ReactElement {
  const t = useT()
  const [percent, setPercent] = useState(props.percent)
  useEffect(() => setPercent(props.percent), [props.percent])
  // ⌘+ and ⌘- while it is open, or Ctrl+wheel, move the value here too.
  useEffect(
    () =>
      apex.tabs.onChanged((snapshot) => {
        const tab = snapshot.tabs.find((x) => x.id === props.tabId)
        if (tab) setPercent(tab.zoomPercent)
      }),
    [props.tabId],
  )

  const step = (delta: 1 | -1): void => {
    void call('zoom', 'step', props.tabId, delta).then(setPercent, () => undefined)
  }
  const reset = (): void => {
    void call('zoom', 'reset', props.tabId).then(() => close(), () => undefined)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      step(-1)
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      step(1)
    } else if (e.key === '0') {
      e.preventDefault()
      reset()
    }
  }

  return (
    <div className="zp" role="group" aria-label={t('address.zoom.label')} onKeyDown={onKeyDown}>
      <button type="button" className="zp__btn" aria-label={t('address.zoom.out')} title={t('address.zoom.out')} disabled={percent <= ZOOM_MIN} onClick={() => step(-1)}>
        <Minus size={14} aria-hidden />
      </button>
      <output className="zp__value" aria-live="polite">
        {t('address.zoom.percent', { percent })}
      </output>
      <button type="button" className="zp__btn" aria-label={t('address.zoom.in')} title={t('address.zoom.in')} disabled={percent >= ZOOM_MAX} onClick={() => step(1)} data-autofocus>
        <Plus size={14} aria-hidden />
      </button>
      <button type="button" className="zp__reset" onClick={reset} disabled={percent === 100}>
        {t('address.zoom.reset')}
      </button>
    </div>
  )
}
