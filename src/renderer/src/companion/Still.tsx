/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { MOOD_FACE, type CompanionLook, type CompanionMood } from '@shared/companion'
import { canBlink, lookKey, nextBlinkDelay } from '@shared/companionLogic'
import { FaceStandIn } from './FaceStandIn'
import { companionWalk, useCompanionImage } from './images'
import type { CompanionFraming } from './layout'

export interface CompanionStillProps {
  look: CompanionLook
  mood: CompanionMood
  /** CSS pixels (square). */
  size: number
  framing?: Exclude<CompanionFraming, 'auto'>
  /** Gentle breathing and blinks, for stills that stand in for a live figure. */
  alive?: boolean
  /** Hidden stills keep their image ready (so swapping back never flashes) but stop blinking. */
  hidden?: boolean
  className?: string
  style?: CSSProperties
}

/** A cached picture usually arrives within this; only a real wait shows the 2D face. */
const STAND_IN_AFTER_MS = 120
/** The crossfade from the 2D face to the picture. */
const STAND_IN_FADE_MS = 420

/** Rendered at device resolution, capped so a big still stays a reasonable PNG. */
function devicePixels(size: number): number {
  const ratio = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  return Math.max(32, Math.min(1024, Math.round(size * Math.max(2, ratio))))
}

/**
 * A look's walk strip (WALK_FRAMES frames side by side, framed like its
 * full-body still at `size` CSS px), or null. It is asked for only while
 * `enabled`, and then in idle time, so a page shows its stills first and
 * draws the walk when nothing else is waiting.
 */
export function useCompanionWalk(look: CompanionLook, size: number, enabled: boolean): string | null {
  const [strip, setStrip] = useState<{ key: string; url: string } | null>(null)
  const key = `${lookKey(look)}@${devicePixels(size)}`
  const latest = useRef(look)
  latest.current = look
  useEffect(() => {
    if (!enabled || strip?.key === key) return
    let live = true
    const draw = (): void => {
      companionWalk(latest.current, devicePixels(size)).then(
        (url) => live && setStrip({ key, url }),
        () => undefined,
      )
    }
    const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(draw, { timeout: 4000 }) : null
    const timer = idle === null ? setTimeout(draw, 1500) : null
    return () => {
      live = false
      if (idle !== null) cancelIdleCallback(idle)
      if (timer) clearTimeout(timer)
    }
  }, [key, enabled])
  return enabled && strip?.key === key ? strip.url : null
}

/**
 * A pre-rendered companion (DS-71): what a live view shows before its first
 * frame, over the live-view budget or off-screen, and what floor companions
 * are. With `alive` it breathes and swaps to a blink frame now and then.
 */
export function CompanionStill({ look, mood, size, framing = 'full', alive = false, hidden = false, className, style }: CompanionStillProps): ReactElement {
  const px = devicePixels(size)
  // The previous mood's image stays up while the next one renders.
  const open = useCompanionImage(look, px, { mood, framing })
  const blinks = alive && canBlink(MOOD_FACE[mood].eyes)
  const shut = useCompanionImage(look, px, { mood, framing, blink: true, skip: !blinks || !open, exact: true })
  const [blinking, setBlinking] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!blinks || hidden || !shut) return
    let live = true
    const schedule = (): void => {
      timer.current = setTimeout(() => {
        if (!live) return
        setBlinking(true)
        timer.current = setTimeout(() => {
          if (!live) return
          setBlinking(false)
          schedule()
        }, 130)
      }, nextBlinkDelay(Math.random) * 1000)
    }
    schedule()
    return () => {
      live = false
      if (timer.current) clearTimeout(timer.current)
      setBlinking(false)
    }
  }, [blinks, hidden, shut])

  // The 2D face while the first picture of this look renders, then a crossfade.
  const [standIn, setStandIn] = useState<'off' | 'shown' | 'leaving'>('off')
  useEffect(() => {
    if (!open) {
      const wait = setTimeout(() => setStandIn('shown'), STAND_IN_AFTER_MS)
      return () => clearTimeout(wait)
    }
    if (standIn !== 'shown') return
    setStandIn('leaving')
    const fade = setTimeout(() => setStandIn('off'), STAND_IN_FADE_MS)
    return () => clearTimeout(fade)
  }, [Boolean(open)])

  const src = blinking && shut ? shut : open
  return (
    <span
      className={['companion-still', alive && 'companion-still--alive', framing === 'full' && 'companion-still--full', hidden && 'companion-still--hidden', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
    >
      {standIn !== 'off' && !hidden && <FaceStandIn look={look} mood={mood} size={size} framing={framing} leaving={standIn === 'leaving'} />}
      {src && <img src={src} alt="" draggable={false} width={size} height={size} data-arrived={standIn === 'leaving' || undefined} />}
    </span>
  )
}
