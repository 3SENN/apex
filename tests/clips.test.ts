/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK } from '@shared/companion'
import { lookKey } from '@shared/companionLogic'
import { CLIP_FRAMES, SETUP_CLIPS, SHOWCASE_SLIDES, SHOWCASE_SLIDE_MS, clipCacheKey, clipDuration, clipFrameAt, showcaseReducer } from '@shared/onboarding'

describe('clip cache keys', () => {
  it('differ by look, clip, size and framing, and round the size', () => {
    const key = lookKey(DEFAULT_LOOK)
    const other = lookKey({ ...DEFAULT_LOOK, colors: { ...DEFAULT_LOOK.colors, accent: '#010203' } })
    expect(clipCacheKey(key, 'wave', 128)).toBe(clipCacheKey(key, 'wave', 128.2))
    const keys = new Set([clipCacheKey(key, 'wave', 128), clipCacheKey(other, 'wave', 128), clipCacheKey(key, 'intro', 128), clipCacheKey(key, 'wave', 256), clipCacheKey(key, 'wave', 128, 'face')])
    expect(keys.size).toBe(5)
  })

  it('has short clips with frames that hold', () => {
    for (const clip of SETUP_CLIPS) {
      expect(CLIP_FRAMES[clip].length).toBeGreaterThan(2)
      expect(clipDuration(CLIP_FRAMES[clip])).toBeLessThan(3_000)
    }
  })

  it('finds the frame for a time, holding or looping', () => {
    const frames = [{ holdMs: 100 }, { holdMs: 100 }, { holdMs: 100 }]
    expect(clipFrameAt(frames, 0)).toBe(0)
    expect(clipFrameAt(frames, 150)).toBe(1)
    expect(clipFrameAt(frames, 900)).toBe(2)
    expect(clipFrameAt(frames, 350, true)).toBe(0)
    expect(clipFrameAt([], 10)).toBe(0)
  })
})

describe('the showcase carousel', () => {
  const reduce = showcaseReducer()
  it('advances on its own, pauses on hover, and wraps with the arrows', () => {
    let s = { index: 0, paused: false, elapsed: 0 }
    s = reduce(s, { type: 'tick', ms: SHOWCASE_SLIDE_MS - 1 })
    expect(s.index).toBe(0)
    s = reduce(s, { type: 'tick', ms: 1 })
    expect(s.index).toBe(1)
    s = reduce(s, { type: 'pause', on: true })
    s = reduce(s, { type: 'tick', ms: SHOWCASE_SLIDE_MS * 3 })
    expect(s.index).toBe(1)
    s = reduce(s, { type: 'prev' })
    s = reduce(s, { type: 'prev' })
    expect(s.index).toBe(SHOWCASE_SLIDES.length - 1)
    s = reduce(s, { type: 'next' })
    expect(s.index).toBe(0)
    expect(reduce(s, { type: 'go', index: 3 }).index).toBe(3)
  })
})
