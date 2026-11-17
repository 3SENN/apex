/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { SPLIT_EVEN, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '@shared/tabs'
import { call } from '../../api'
import { t } from '../../i18n/useT'
import { SPLIT_SNAP_POINTS, snapHaptic } from '../../native/snapHaptic'
import { Seam } from '../../ui'
import { clampRatio } from './logic'

// The split seam (SH-41) in the gap between the two panes. Its value is the
// left pane's share of the width, so arrow keys step 8 px (⇧ for bigger
// steps), a double-click resets to even and Esc during a drag puts it back.
// The live ratio goes straight onto the content's CSS variables, and the
// native views follow on the next frame; the settled ratio is saved in the
// window session. `snapPoints` and `onSnap` are the haptics extension point.

interface SplitSeamProps {
  ratio: number
  /** Re-measures the panes so the native views follow a live change. */
  onLayout(): void
  snapPoints?: readonly number[]
  onSnap?(point: number): void
}

/** The content's width less the gap between the panes. */
function usableWidth(content: HTMLElement | null): number {
  if (!content) return 0
  const gap = parseFloat(getComputedStyle(content).columnGap) || 0
  return Math.max(0, content.clientWidth - gap)
}

export function applyRatio(content: HTMLElement | null, ratio: number): void {
  if (!content) return
  const r = clampRatio(ratio)
  content.style.setProperty('--split-left', String(r))
  content.style.setProperty('--split-right', String(1 - r))
}

export function SplitSeam({ ratio, onLayout, snapPoints = SPLIT_SNAP_POINTS, onSnap = snapHaptic }: SplitSeamProps): ReactElement {
  const anchor = useRef<HTMLSpanElement>(null)
  const [value, setValue] = useState(clampRatio(ratio))
  const [usable, setUsable] = useState(0)
  const content = (): HTMLElement | null => anchor.current?.parentElement ?? null

  // A saved change (the menu's reset, another window) moves the seam too.
  useLayoutEffect(() => setValue(clampRatio(ratio)), [ratio])
  useLayoutEffect(() => {
    const el = content()
    if (!el) return
    const measure = (): void => setUsable(usableWidth(el))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const live = (next: number): void => {
    setValue(next)
    applyRatio(content(), next)
    requestAnimationFrame(onLayout)
  }
  const step = usable > 0 ? 8 / usable : 0.01
  return (
    <span ref={anchor} className="split-seam-slot" style={{ ['--split-seam-at' as string]: value }}>
      <Seam
        className="split-seam"
        label={t('tabs.split.seam')}
        value={value}
        min={SPLIT_RATIO_MIN}
        max={SPLIT_RATIO_MAX}
        pixelsPerUnit={Math.max(1, usable)}
        step={step}
        resetTo={SPLIT_EVEN}
        valueText={(v) => `${Math.round(v * 100)} / ${100 - Math.round(v * 100)}`}
        snapPoints={snapPoints}
        onSnap={onSnap}
        onDragChange={(dragging) => content()?.classList.toggle('content--resizing', dragging)}
        onChange={live}
        onCommit={(v) => void call('split', 'setRatio', clampRatio(v)).catch(() => undefined)}
      />
    </span>
  )
}
