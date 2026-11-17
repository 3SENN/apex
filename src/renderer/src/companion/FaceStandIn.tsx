/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactElement } from 'react'
import { MOOD_FACE, type CompanionLook, type CompanionMood } from '@shared/companion'
import { loadCompanionAssets } from './assets'
import { drawFallback, loadFallbackFace, type FallbackFace } from './face'
import { MOOD_CHEEKS, type CompanionFraming } from './layout'

// While the 3D parts load (the first time a look is drawn), the
// still shows the 2D face instead of an empty box: the face layers on the
// head's colour, drawn on a canvas from the small face files only. The still
// crossfades over it once its picture is ready.

export interface FaceStandInProps {
  look: CompanionLook
  mood: CompanionMood
  /** CSS pixels (square). */
  size: number
  framing: Exclude<CompanionFraming, 'auto'>
  /** The still is ready: fade out (the parent unmounts it after the fade). */
  leaving: boolean
}

/** Where the head goes in the box: a full figure's head sits high and smaller; a bust or face fills more of it. */
function headBox(size: number, framing: FaceStandInProps['framing']): { size: number; top: number } {
  if (framing === 'full') return { size: Math.round(size * 0.5), top: Math.round(size * 0.14) }
  if (framing === 'bust') return { size: Math.round(size * 0.78), top: Math.round(size * 0.06) }
  return { size, top: 0 }
}

export function FaceStandIn({ look, mood, size, framing, leaving }: FaceStandInProps): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = headBox(size, framing)
  const lookKey = JSON.stringify(look)

  useEffect(() => {
    let live = true
    const draw = (face: FallbackFace): void => {
      if (!live || !canvas.current) return
      drawFallback(canvas.current, box.size, Math.min(2, window.devicePixelRatio || 1), look, MOOD_FACE[mood], face, MOOD_CHEEKS[mood])
    }
    // The basic drawn face first, then the real face layers once their files are in.
    draw({ source: null, images: new Map() })
    loadCompanionAssets()
      .then((assets) => loadFallbackFace({ defs: assets.manifest.face, pupils: assets.pupils }, look.face))
      .then(draw, () => undefined)
    return () => {
      live = false
    }
  }, [lookKey, mood, box.size])

  return (
    <canvas
      ref={canvas}
      className="companion-standin"
      data-leaving={leaving || undefined}
      aria-hidden="true"
      style={{ width: box.size, height: box.size, top: box.top, left: Math.round((size - box.size) / 2) }}
    />
  )
}
