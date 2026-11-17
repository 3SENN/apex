/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { apex } from '../api'
import { useMotion } from './motion'

// The floats' page has no window.apex (it shares this module with the chrome), so it reads the user agent.
export const isMac = (apex.platform ?? (/Mac/.test(navigator.userAgent) ? 'darwin' : '')) === 'darwin'

/** A ref that always holds the latest value, for callbacks used in effects. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  ref.current = value
  return ref
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const update = (): void => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}

/** True when the system's or Apex's own Reduce Motion is on (see ui/motion.ts). */
export function useReducedMotion(): boolean {
  return useMotion().reduced
}

export type ResolvedTheme = 'light' | 'dark'

function readTheme(): ResolvedTheme {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', onChange)
  }
}

/** The mode the chrome is drawn in, from <html data-theme>, kept live. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, readTheme)
}

// One shared clock for every relative time on screen.
const clockListeners = new Set<() => void>()
let clockNow = Date.now()
let clockTimer: ReturnType<typeof setInterval> | null = null

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener)
  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      clockListeners.forEach((l) => l())
    }, 30_000)
  }
  return () => {
    clockListeners.delete(listener)
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

/** The current time, updated every 30 s while anything is listening. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow)
}
