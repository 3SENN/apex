/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef } from 'react'
import { PROMPT_INPUT_DELAY_MS, inputArmed } from './promptLogic'

/**
 * The input delay for a surface that answers a site (the permission prompt,
 * the quiet chip's popover): it restarts each time the surface comes on screen
 * (placed, back from another tab, its view shown again), and the returned
 * check says whether a press counts yet. Without the frame's `shown` (a
 * chrome-hosted fallback) the surface counts as shown from its mount.
 */
export function useInputGuard(shown: boolean | undefined, delay = PROMPT_INPUT_DELAY_MS): () => boolean {
  const shownAt = useRef<number | null>(null)
  const visible = shown ?? true
  useEffect(() => {
    if (!visible) {
      shownAt.current = null
      return
    }
    const start = (): void => {
      shownAt.current = performance.now()
    }
    start()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [visible])
  return useCallback(() => inputArmed(shownAt.current, performance.now(), delay), [delay])
}
