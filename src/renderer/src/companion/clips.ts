/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// CO-16's clips: short transparent frame sequences of a companion (typing,
// wave, intro), drawn off-screen through the still renderer's queue
// (images.ts, which retries each frame on a timeout) and cached per look
// hash, clip, size and framing. A clip whose frames don't all arrive in time
// gets one more try. The setup intro, the preset detail sheet and breathing
// stills play them with useCompanionClip.
import { useEffect, useState } from 'react'
import type { CompanionLook } from '@shared/companion'
import { lookKey } from '@shared/companionLogic'
import { CLIP_FRAMES, clipCacheKey, clipFrameAt, type SetupClipId } from '@shared/onboarding'
import { companionImage } from './images'

export interface CompanionClip {
  key: string
  frames: Array<{ src: string; holdMs: number }>
}

type Framing = 'full' | 'bust' | 'face'

const MAX_CLIPS = 24
const CLIP_TIMEOUT_MS = 60_000
const CLIP_ATTEMPTS = 2
const clips = new Map<string, Promise<CompanionClip>>()

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The companion clip took too long to draw.')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function draw(look: CompanionLook, clip: SetupClipId, size: number, framing: Framing, key: string): Promise<CompanionClip> {
  let failure: unknown
  for (let attempt = 0; attempt < CLIP_ATTEMPTS; attempt++) {
    try {
      const frames = await timeout(
        Promise.all(CLIP_FRAMES[clip].map(async (f) => ({ src: await companionImage(look, size, f.mood, { framing, blink: f.blink === true }), holdMs: f.holdMs }))),
        CLIP_TIMEOUT_MS,
      )
      return { key, frames }
    } catch (err) {
      failure = err
    }
  }
  throw failure
}

/** A clip's frames, drawn once per look, clip, size and framing. */
export function companionClip(look: CompanionLook, clip: SetupClipId, size: number, framing: Framing = 'full'): Promise<CompanionClip> {
  const key = clipCacheKey(lookKey(look), clip, size, framing)
  const hit = clips.get(key)
  if (hit) {
    clips.delete(key)
    clips.set(key, hit)
    return hit
  }
  const promise = draw(look, clip, size, framing, key)
  clips.set(key, promise)
  promise.catch(() => {
    if (clips.get(key) === promise) clips.delete(key)
  })
  while (clips.size > MAX_CLIPS) {
    const oldest = clips.keys().next().value
    if (oldest === undefined) break
    clips.delete(oldest)
  }
  return promise
}

/**
 * Plays a clip: the src of the frame to show now, or null while it draws
 * (show a still or the live figure meanwhile). Under reduced motion it holds
 * the last frame. `loop` repeats it; otherwise it plays once per `playKey`.
 */
export function useCompanionClip(look: CompanionLook, clip: SetupClipId, size: number, options: { framing?: Framing; loop?: boolean; reduced?: boolean; playKey?: unknown } = {}): string | null {
  const [data, setData] = useState<CompanionClip | null>(null)
  const [frame, setFrame] = useState(0)
  const key = clipCacheKey(lookKey(look), clip, size, options.framing ?? 'full')
  useEffect(() => {
    let live = true
    setData(null)
    companionClip(look, clip, size, options.framing).then((c) => live && setData(c), () => undefined)
    return () => {
      live = false
    }
  }, [key])
  useEffect(() => {
    if (!data) return
    if (options.reduced) {
      setFrame(data.frames.length - 1)
      return
    }
    const started = performance.now()
    let raf = 0
    const tick = (): void => {
      const i = clipFrameAt(data.frames, performance.now() - started, options.loop === true)
      setFrame(i)
      if (options.loop || i < data.frames.length - 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [data, options.reduced, options.loop, options.playKey])
  return data?.frames[Math.min(frame, data.frames.length - 1)]?.src ?? null
}
