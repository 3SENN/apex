/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { TabCardPage } from '@shared/overlay/tabs'
import { Globe } from 'lucide-react'
import { Skeleton, cx, useReducedMotion } from '../../../ui'

// Pieces the tab cards share: a 16:9 thumbnail with a skeleton while it
// loads, a favicon, and the short glide a card makes when it moves rows.

export function PageFavicon({ src, size = 14 }: { src: string | null; size?: number }): ReactElement {
  const [broken, setBroken] = useState(false)
  if (src && !broken) return <img className="tab-card__favicon" src={src} alt="" width={size} height={size} draggable={false} onError={() => setBroken(true)} />
  return <Globe className="tab-card__favicon" size={size} aria-hidden />
}

/** The page's frame, or a skeleton while none was captured yet. */
export function PageThumb({ page, className }: { page: Pick<TabCardPage, 'thumbnail' | 'title'>; className?: string }): ReactElement {
  return (
    <div className={cx('tab-card__thumb', className)}>
      {page.thumbnail ? <img src={page.thumbnail} alt="" draggable={false} /> : <Skeleton className="tab-card__thumb-skeleton" />}
    </div>
  )
}

/**
 * A card that replaced the one on the row before slides in from there
 * (DS-92: it glides between rows rather than reopening). Reduced motion: no slide.
 */
export function useGlide(from: { dx: number; dy: number } | null | undefined): CSSProperties | undefined {
  const reduced = useReducedMotion()
  const [settled, setSettled] = useState(!from || reduced)
  const frame = useRef(0)
  useEffect(() => {
    if (settled) return
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => setSettled(true))
    })
    return () => cancelAnimationFrame(frame.current)
  }, [settled])
  if (!from || reduced) return undefined
  return settled ? { transform: 'none', transition: 'transform var(--motion-glide) var(--ease-out)' } : { transform: `translate(${from.dx}px, ${from.dy}px)`, transition: 'none' }
}

/**
 * The card's lifetime once the pointer left its row (`leaving`): it goes
 * shortly after, unless the pointer is on the card itself, and then as soon
 * as the pointer leaves the card.
 */
export function useCardLifetime(leaving: boolean, close: () => void, graceMs = 140): { onPointerEnter(): void; onPointerLeave(): void } {
  const inside = useRef(false)
  const leavingRef = useRef(leaving)
  leavingRef.current = leaving
  useEffect(() => {
    if (!leaving || inside.current) return
    const timer = setTimeout(close, graceMs)
    return () => clearTimeout(timer)
  }, [leaving, close, graceMs])
  return {
    onPointerEnter: () => {
      inside.current = true
    },
    onPointerLeave: () => {
      inside.current = false
      if (leavingRef.current) close()
    },
  }
}
