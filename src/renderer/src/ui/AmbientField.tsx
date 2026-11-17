/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactElement } from 'react'
import { useResolvedTheme } from './hooks'
import { buildLattice, edgeMask, fieldColors, fieldMask, fieldPixelRatio, glyphScale, LATTICE_PITCH, rippleAt, RIPPLE, tideAt, type FieldColors, type FieldMask, type LatticeCell } from './logic/ambient'
import { cx } from './logic/format'
import { motionReduced, useMotion } from './motion'

export interface AmbientFieldProps {
  /** The colour the field is washed in (#rrggbb): a companion's colour, or a profile hue. */
  tint: string
  /** Where the swells roll out from, as fractions of the box (a companion's feet). Default: the centre. */
  origin?: { x: number; y: number }
  /** Lattice pitch in px. */
  pitch?: number
  /** The owner pauses it (for example a layer that isn't showing). */
  paused?: boolean
  /** An invisible strip at the top that fades in over this many px. */
  fadeTop?: number
  /** Washed out toward the bottom over this many px. */
  fadeBottom?: number
  /** A soft elliptical edge and clearings behind text (logic/ambient fieldMask). */
  mask?: FieldMask
  /** Draw exactly one frame (thumbnails). Reduce Motion does the same. */
  still?: boolean
  /** Paint the wash under the glyphs (default true); off when the owner paints its own. */
  wash?: boolean
  /** Overall strength, 0–1. */
  intensity?: number
  /** Changes the glyph arrangement (default 1). */
  seed?: number
  className?: string
}

export interface AmbientFieldHandle {
  /** Sends one extra ripple outward (a poke, a greeting, a finished task); `at` in fractions of the box. */
  ripple(at?: { x: number; y: number }): void
}

/** Frame budget: the tide is slow, so about 30 frames a second is plenty and saves power. */
const FRAME_MS = 32
/** The moment a still frame shows: a band of swells mid-roll, not an empty field. */
const STILL_AT_MS = 2600

interface Ripple {
  x: number
  y: number
  start: number
}

function drawGlyph(ctx: CanvasRenderingContext2D, cell: LatticeCell, size: number): void {
  const { x, y } = cell
  switch (cell.glyph) {
    case 'plus': {
      const arm = size * 0.42
      ctx.lineWidth = size * 0.26
      ctx.beginPath()
      ctx.moveTo(x - arm, y)
      ctx.lineTo(x + arm, y)
      ctx.moveTo(x, y - arm)
      ctx.lineTo(x, y + arm)
      ctx.stroke()
      break
    }
    case 'ring':
      ctx.lineWidth = size * 0.2
      ctx.beginPath()
      ctx.arc(x, y, size * 0.36, 0, Math.PI * 2)
      ctx.stroke()
      break
    case 'capsule': {
      const half = size * 0.32
      const dx = Math.cos(cell.angle) * half
      const dy = Math.sin(cell.angle) * half
      ctx.lineWidth = size * 0.34
      ctx.beginPath()
      ctx.moveTo(x - dx, y - dy)
      ctx.lineTo(x + dx, y + dy)
      ctx.stroke()
      break
    }
    case 'sparkle': {
      const r = size * 0.55
      const k = size * 0.1
      ctx.beginPath()
      ctx.moveTo(x, y - r)
      ctx.quadraticCurveTo(x + k, y - k, x + r, y)
      ctx.quadraticCurveTo(x + k, y + k, x, y + r)
      ctx.quadraticCurveTo(x - k, y + k, x - r, y)
      ctx.quadraticCurveTo(x - k, y - k, x, y - r)
      ctx.fill()
      break
    }
  }
}

/**
 * Apex's ambient field, the "tide weave": a canvas lattice of small glyphs
 * whose sizes swell in slow rings from `origin`. It fills its positioned
 * parent and ignores the pointer. It pauses off screen, while the window is
 * hidden and when `paused`, caps its pixel density, draws one still frame
 * under Reduce Motion and re-tints within a frame when the theme or `tint`
 * changes, without remounting.
 */
export const AmbientField = forwardRef<AmbientFieldHandle, AmbientFieldProps>(function AmbientField(props, ref): ReactElement {
  const { tint, origin, pitch = LATTICE_PITCH, paused = false, fadeTop = 0, fadeBottom = 0, mask, still = false, wash = true, intensity = 1, seed = 1, className } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const mode = useResolvedTheme()
  const { reduced } = useMotion()
  // Everything the loop reads lives in refs, so prop changes never restart it.
  const colors = useRef<FieldColors>(fieldColors(tint, mode))
  const options = useRef({ origin, pitch, fadeTop, fadeBottom, mask, wash, intensity })
  const ripples = useRef<Ripple[]>([])
  const lattice = useRef<{ cells: LatticeCell[]; width: number; height: number }>({ cells: [], width: 0, height: 0 })
  const redraw = useRef<() => void>(() => undefined)
  const started = useRef(performance.now())

  options.current = { origin, pitch, fadeTop, fadeBottom, mask, wash, intensity }

  useImperativeHandle(ref, () => ({
    ripple(at) {
      if (motionReduced()) return
      const { width, height } = lattice.current
      const o = at ?? options.current.origin ?? { x: 0.5, y: 0.5 }
      ripples.current = [...ripples.current.slice(-3), { x: o.x * width, y: o.y * height, start: performance.now() }]
    },
  }))

  // Re-tint in place: new colours, one frame now.
  useEffect(() => {
    colors.current = fieldColors(tint, mode)
    redraw.current()
  }, [tint, mode])
  // A still field shows option changes too.
  useEffect(() => redraw.current(), [origin?.x, origin?.y, fadeTop, fadeBottom, mask, wash, intensity])

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    let frame = 0
    let lastDraw = 0
    let onScreen = true
    let pageHidden = document.hidden
    const animating = (): boolean => !still && !reduced && !paused && onScreen && !pageHidden

    const draw = (now: number): void => {
      const { cells, width, height } = lattice.current
      const opts = options.current
      const ratio = fieldPixelRatio(window.devicePixelRatio)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const c = colors.current
      if (opts.wash) {
        ctx.globalAlpha = 1
        ctx.fillStyle = c.wash
        ctx.fillRect(0, 0, width, height)
      }
      ctx.fillStyle = c.glyph
      ctx.strokeStyle = c.glyph
      ctx.lineCap = 'round'
      const t = still || reduced ? STILL_AT_MS : now - started.current
      const ox = (opts.origin?.x ?? 0.5) * width
      const oy = (opts.origin?.y ?? 0.5) * height
      const live = ripples.current.filter((r) => now - r.start < RIPPLE.life)
      ripples.current = live
      const maxSize = opts.pitch * 0.62
      for (const cell of cells) {
        const mask = edgeMask(cell.y, height, opts.fadeTop, opts.fadeBottom) * fieldMask(cell.x, cell.y, width, height, opts.mask)
        if (mask <= 0.01) continue
        const tide = tideAt(Math.hypot(cell.x - ox, cell.y - oy), t)
        let wave = 0
        for (const r of live) wave += rippleAt(Math.hypot(cell.x - r.x, cell.y - r.y), now - r.start)
        const scale = glyphScale(tide, wave, cell.jitter)
        if (scale === 0) continue
        ctx.globalAlpha = c.alpha * mask * opts.intensity
        drawGlyph(ctx, cell, maxSize * scale)
      }
      ctx.globalAlpha = 1
    }

    const loop = (now: number): void => {
      frame = 0
      if (!animating()) return
      if (now - lastDraw >= FRAME_MS) {
        lastDraw = now
        draw(now)
      }
      frame = requestAnimationFrame(loop)
    }
    const kick = (): void => {
      if (animating() && !frame) frame = requestAnimationFrame(loop)
    }
    redraw.current = () => {
      draw(performance.now())
      kick()
    }

    const resize = (): void => {
      const rect = el.getBoundingClientRect()
      const width = Math.max(0, Math.round(rect.width))
      const height = Math.max(0, Math.round(rect.height))
      const ratio = fieldPixelRatio(window.devicePixelRatio)
      el.width = Math.round(width * ratio)
      el.height = Math.round(height * ratio)
      lattice.current = { cells: buildLattice(width, height, options.current.pitch, seed), width, height }
      draw(performance.now())
    }
    resize()
    kick()

    const sizes = new ResizeObserver(resize)
    sizes.observe(el)
    const seen = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting)
      kick()
    })
    seen.observe(el)
    const onVisibility = (): void => {
      pageHidden = document.hidden
      kick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      sizes.disconnect()
      seen.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      redraw.current = () => undefined
    }
  }, [still, reduced, paused, pitch, seed])

  return <canvas ref={canvas} className={cx('ui-ambient', className)} aria-hidden />
})
