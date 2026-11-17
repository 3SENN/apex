/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { useLatest } from './hooks'
import { cx } from './logic/format'
import { seamDragValue, seamKeyValue, seamResetValue, seamSnapCrossings, type SeamOrientation } from './logic/seam'

export interface SeamProps {
  /** The current size, in px unless pixelsPerUnit says otherwise. */
  value: number
  min: number
  max: number
  /** Every live step: pointer moves, key presses, resets, and the revert on Esc. */
  onChange(value: number): void
  /** The settled value: pointer release, a key step or a reset. Save here. */
  onCommit?(value: number): void
  /** Double-click target, or a function of the current value (e.g. toggle default and all). */
  resetTo?: number | ((current: number) => number)
  /** 'vertical' is an upright bar that sizes widths; 'horizontal' sizes heights. */
  orientation?: SeamOrientation
  /** Set when the sized element is after the seam (right of or below it). */
  reverse?: boolean
  /** Arrow-key step (default 8 for px, use 1 for rows). */
  step?: number
  /** Shift+arrow and Page Up/Down (default four steps). */
  largeStep?: number
  /** Pixels per unit, e.g. a row height when the value counts rows. */
  pixelsPerUnit?: number
  /** Round dragged values to multiples of this. */
  snap?: number
  /** Accessible name, e.g. "Resize sidebar". */
  label: string
  /** Spoken value, e.g. (v) => `${v} pixels` or `${v} chats shown`. */
  valueText?(value: number): string
  /** Id of the element it sizes. */
  controls?: string
  disabled?: boolean
  /** Tells the parent a drag started or ended (e.g. to pause animations). */
  onDragChange?(dragging: boolean): void
  /** Values (in the seam's own units: ratios for the split seam) whose crossing calls onSnap. */
  snapPoints?: readonly number[]
  /** Once per crossing, during pointer drags only: never for keys, resets or the Esc revert. */
  onSnap?(point: number): void
  className?: string
  style?: CSSProperties
}

interface DragState {
  pointerId: number
  origin: number
  start: number
  last: number
}

/**
 * A resizable divider: drag it live, Esc during a drag restores the old size,
 * double-click resets, arrows step a focused seam, Home and End jump to the
 * limits. It renders only the handle; the parent positions it on the edge.
 */
export function Seam({
  value,
  min,
  max,
  onChange,
  onCommit,
  resetTo,
  orientation = 'vertical',
  reverse = false,
  step = 8,
  largeStep,
  pixelsPerUnit = 1,
  snap,
  label,
  valueText,
  controls,
  disabled = false,
  onDragChange,
  snapPoints,
  onSnap,
  className,
  style,
}: SeamProps): ReactElement {
  const el = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)
  const change = useLatest(onChange)
  const dragChange = useLatest(onDragChange)
  const vertical = orientation === 'vertical'
  const axis = (e: { clientX: number; clientY: number }): number => (vertical ? e.clientX : e.clientY)

  const finish = (commit: boolean): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (el.current?.hasPointerCapture(d.pointerId)) el.current.releasePointerCapture(d.pointerId)
    setDragging(false)
    if (commit) {
      if (d.last !== d.start) onCommit?.(d.last)
    } else if (d.last !== d.start) change.current(d.start)
  }

  // While dragging: a resize cursor everywhere, no text selection, and Esc cancels.
  useEffect(() => {
    if (!dragging) return
    const root = document.documentElement
    const cls = vertical ? 'ui-resizing-x' : 'ui-resizing-y'
    root.classList.add(cls)
    dragChange.current?.(true)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      root.classList.remove(cls)
      window.removeEventListener('keydown', onKey, true)
      dragChange.current?.(false)
    }
  }, [dragging, vertical])

  return (
    <div
      ref={el}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(Math.max(min, max))}
      aria-valuetext={valueText?.(value)}
      aria-controls={controls}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-dragging={dragging || undefined}
      data-snap-points={snapPoints?.length ? snapPoints.join(' ') : undefined}
      className={cx('ui-seam', `ui-seam--${orientation}`, disabled && 'ui-seam--disabled', className)}
      style={style}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { pointerId: e.pointerId, origin: axis(e), start: value, last: value }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || e.pointerId !== d.pointerId) return
        const next = seamDragValue({ start: d.start, deltaPx: axis(e) - d.origin, pixelsPerUnit, reverse, snap, min, max })
        if (next === d.last) return
        if (snapPoints && onSnap) for (const point of seamSnapCrossings(d.last, next, snapPoints)) onSnap(point)
        d.last = next
        change.current(next)
      }}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => {
        if (disabled || resetTo === undefined) return
        const next = seamResetValue(value, resetTo, { min, max })
        if (next === value) return
        change.current(next)
        onCommit?.(next)
      }}
      onKeyDown={(e) => {
        if (disabled || drag.current) return
        const next = seamKeyValue(e.key, value, { orientation, reverse, step, largeStep, shift: e.shiftKey, min, max })
        if (next === null) return
        e.preventDefault()
        if (next === value) return
        change.current(next)
        onCommit?.(next)
      }}
    />
  )
}
