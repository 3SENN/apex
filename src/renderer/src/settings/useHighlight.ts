/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// ?highlight=<anchor> (ST-05): scrolls the matching row into view and
// marks it for about two seconds. Rows behind a skeleton appear a little
// later, so the search keeps watching the page for a few seconds.
import { useEffect, type RefObject } from 'react'

export const HIGHLIGHT_MS = 2000
const WATCH_MS = 5000

export function useSettingsHighlight(root: RefObject<HTMLElement | null>, anchor: string | null, pageKey: string): void {
  useEffect(() => {
    const el = root.current
    if (!anchor || !el) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let clearTimer = 0
    let found = false
    const find = (): boolean => {
      if (found) return true
      const target = el.querySelector<HTMLElement>(`[data-settings-anchor="${CSS.escape(anchor)}"]`)
      if (!target) return false
      found = true
      target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
      target.classList.add('sp-highlight')
      // Keyboard and screen-reader users land on the row's control too.
      target.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, [role="radio"][tabindex="0"]')?.focus({ preventScroll: true })
      clearTimer = window.setTimeout(() => target.classList.remove('sp-highlight'), HIGHLIGHT_MS)
      return true
    }
    const observer = new MutationObserver(() => {
      if (find()) observer.disconnect()
    })
    // After paint: the page's own scroll-to-top runs first.
    const frame = requestAnimationFrame(() => {
      if (!find()) observer.observe(el, { childList: true, subtree: true })
    })
    const giveUp = window.setTimeout(() => observer.disconnect(), WATCH_MS)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.clearTimeout(giveUp)
      window.clearTimeout(clearTimer)
    }
  }, [anchor, pageKey])
}
