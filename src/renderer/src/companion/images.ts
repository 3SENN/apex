/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import type { CompanionLook, CompanionMood } from '@shared/companion'
import { lookKey } from '@shared/companionLogic'
import { stillFraming, type CompanionFraming } from './layout'
import type { Motion } from './locomotion'
import { renderCompanionImage, renderCompanionWalk, type RenderOptions } from './render'

// Each look is drawn off-screen once per size, so galleries and the Dock icon
// reuse renders instead of repeating them (the runtime runs them one by one).
// Moods, face crops and blink frames are separate entries, so the cache is roomy; small PNGs are tiny.
const MAX_IMAGES = 160
const images = new Map<string, Promise<string>>()

// Renders queue one at a time; the timeout is a render's own time, counted
// from its turn (render.ts › enqueue), so a long queue never runs it out. A
// stuck or failed render (a lost context, a slow first load) gets one more try.
const RENDER_TIMEOUT_MS = 20_000
const RENDER_ATTEMPTS = 2

async function renderWithRetry(look: CompanionLook, size: number, mood: CompanionMood | undefined, options: RenderOptions): Promise<string> {
  let failure: unknown
  for (let attempt = 0; attempt < RENDER_ATTEMPTS; attempt++) {
    try {
      return await renderCompanionImage(look, size, mood, options, RENDER_TIMEOUT_MS)
    } catch (err) {
      failure = err
    }
  }
  throw failure
}

/** An off-screen PNG of a look at `size` device pixels, cached per look, size, mood and framing. */
export function companionImage(look: CompanionLook, size: number, mood?: CompanionMood, options: RenderOptions = {}): Promise<string> {
  const key = `${lookKey(look)}@${size}/${mood ?? ''}/${options.framing ?? 'full'}${options.blink ? '/blink' : ''}`
  const hit = images.get(key)
  if (hit) {
    images.delete(key)
    images.set(key, hit)
    return hit
  }
  const promise = renderWithRetry(look, size, mood, options)
  images.set(key, promise)
  promise.catch(() => {
    if (images.get(key) === promise) images.delete(key)
  })
  while (images.size > MAX_IMAGES) {
    const oldest = images.keys().next().value
    if (oldest === undefined) break
    images.delete(oldest)
  }
  return promise
}

/** Walk strips (render.ts › renderCompanionWalk): a few looks on a floor at most. */
const MAX_WALKS = 12
const walks = new Map<string, Promise<string>>()

/**
 * A look's walk (or run) strip at `size` device pixels, drawn once and cached.
 * It never retries: a page that can't get one keeps its still.
 */
export function companionWalk(look: CompanionLook, size: number, motion: Motion = 'walk'): Promise<string> {
  const key = `${lookKey(look)}@${size}/${motion}`
  const hit = walks.get(key)
  if (hit) return hit
  const promise = renderCompanionWalk(look, size, motion, RENDER_TIMEOUT_MS)
  walks.set(key, promise)
  promise.catch(() => undefined)
  while (walks.size > MAX_WALKS) {
    const oldest = walks.keys().next().value
    if (oldest === undefined) break
    walks.delete(oldest)
  }
  return promise
}

export interface ImageOptions {
  mood?: CompanionMood
  /** 'auto' (the default) shows only the face for small images (under FACE_BELOW CSS px at 2×) and the full body otherwise. */
  framing?: CompanionFraming
  blink?: boolean
  /** Renders nothing yet (a blink frame waits for its open-eyed still). */
  skip?: boolean
  /** Only this exact variant: no stand-in from a previous mood (blink frames). */
  exact?: boolean
}

export { stillFraming }

/**
 * A cached off-screen PNG of a look at `size` device pixels, or null until it
 * is ready. While a new mood renders, the previous image of the same look
 * stays, so a face never blinks out.
 */
export function useCompanionImage(look: CompanionLook, size: number, options: ImageOptions = {}): string | null {
  const key = lookKey(look)
  const framing = stillFraming(options.framing, size)
  const variant = `${options.mood ?? ''}/${framing}/${options.blink ? 1 : 0}`
  const [image, setImage] = useState<{ key: string; variant: string; url: string } | null>(null)
  useEffect(() => {
    if (options.skip) return
    let live = true
    companionImage(look, size, options.mood, { framing, blink: options.blink }).then((url) => live && setImage({ key, variant, url }), () => undefined)
    return () => {
      live = false
    }
    // The key covers every field of the look; the variant covers the options.
  }, [key, size, variant, options.skip === true])
  if (image?.key !== key || (options.exact && image.variant !== variant)) return null
  return image.url
}
