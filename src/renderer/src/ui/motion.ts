/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { MOTION, resolveMotion, type ResolvedMotion } from './logic/motion'
import { mergePresence, nextLayerState, nextPresenceChange, settlePresence, type LayerState, type PresenceEntry } from './logic/presence'

// The one Reduce Motion switch. The system setting OR Atelier's own (Settings ›
// Appearance) stills every animation. Both end up as <html data-motion> so
// CSS can follow with one selector: `:root[data-motion='reduced']`.

export { MOTION, SPRING, springAt, springDuration, springEasing, type MotionDurations, type ResolvedMotion, type SpringPreset } from './logic/motion'
export type { PresenceEntry, PresencePhase, LayerState } from './logic/presence'

const QUERY = '(prefers-reduced-motion: reduce)'
const listeners = new Set<() => void>()
let appReduced = false
let systemReduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY).matches : false
let resolved: ResolvedMotion = resolveMotion(systemReduced, appReduced)

function publish(): void {
  const next = resolveMotion(systemReduced, appReduced)
  if (next.reduced === resolved.reduced) return
  resolved = next
  if (typeof document !== 'undefined') document.documentElement.dataset.motion = next.reduced ? 'reduced' : 'full'
  listeners.forEach((l) => l())
}

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia(QUERY).addEventListener('change', (e) => {
    systemReduced = e.matches
    publish()
  })
  // Before the first render: the saved Atelier setting.
  appReduced = Boolean(window.atelier?.initial?.settings?.reduceMotion)
  resolved = resolveMotion(systemReduced, appReduced)
  document.documentElement.dataset.motion = resolved.reduced ? 'reduced' : 'full'
}

/** Call when the Atelier setting changes (App does, from settings events). */
export function applyMotionSetting(reduced: boolean): void {
  appReduced = reduced
  publish()
}

/** True when either Reduce Motion is on; for code outside React (canvas loops, timers). */
export function motionReduced(): boolean {
  return resolved.reduced
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The live motion state: `reduced`, the durations (all 0 when reduced) and the spring. */
export function useMotion(): ResolvedMotion {
  return useSyncExternalStore(subscribe, () => resolved)
}

/**
 * One layer's open/close state: it stays mounted through a short exit, then
 * unmounts. A safety timeout removes it even if no animationend arrives, and
 * Reduce Motion removes it at once.
 */
export function useLayerPresence(open: boolean, exitMs: number = MOTION.exit): LayerState {
  const { reduced } = useMotion()
  const exit = reduced ? 0 : exitMs
  const [state, setState] = useState<LayerState>(open ? 'open' : 'closed')
  const next = nextLayerState(state, open, exit)
  if (next !== state) setState(next)
  useEffect(() => {
    if (state !== 'closing') return
    // The exit animation runs for `exit`; a little slack covers a slow frame.
    const timer = setTimeout(() => setState((s) => (s === 'closing' ? 'closed' : s)), exit + 40)
    return () => clearTimeout(timer)
  }, [state, exit])
  return next
}

/**
 * Rows that animate in and out: new keys enter, removed keys stay mounted as
 * exiting rows for `exitMs`, at their old place. Render each entry with
 * data-phase={entry.phase}; CSS does the motion. The first render, and any
 * render under Reduce Motion, places rows without animating.
 */
export function usePresenceList<T>(items: readonly T[], keyOf: (item: T) => string, options: { enterMs?: number; exitMs?: number; animate?: boolean } = {}): PresenceEntry<T>[] {
  const { reduced } = useMotion()
  const enterMs = options.enterMs ?? MOTION.enter
  const exitMs = options.exitMs ?? MOTION.exit
  const animate = !reduced && options.animate !== false
  const shown = useRef<PresenceEntry<T>[] | null>(null)
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const now = performance.now()
  // Derived during render so a new row never misses a frame; merging is idempotent.
  const merged = mergePresence(shown.current ?? [], items, keyOf, now, animate && shown.current !== null)
  shown.current = merged
  useEffect(() => {
    const wait = nextPresenceChange(merged, performance.now(), enterMs, exitMs)
    if (wait === null) return
    const timer = setTimeout(() => {
      const current = shown.current
      if (!current) return
      const settled = settlePresence(current, performance.now(), enterMs, exitMs)
      if (settled !== current) {
        shown.current = settled
        tick()
      }
    }, wait + 16)
    return () => clearTimeout(timer)
  })
  return merged
}

/**
 * FLIP glides: children marked data-flip="<key>" that moved since the last
 * render slide from their old place to the new one (reorders, drops). Rows
 * entering or leaving animate their own height, so they are skipped.
 */
export function useFlip(container: RefObject<HTMLElement | null>, orderKey: string): void {
  const { reduced, durations } = useMotion()
  const last = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const next = new Map<string, number>()
    const moved: Array<[HTMLElement, number]> = []
    // Relative to the container, so scrolling between renders is not mistaken for a move.
    const origin = root.getBoundingClientRect().top
    for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
      const key = el.dataset.flip ?? ''
      const top = el.getBoundingClientRect().top - origin
      next.set(key, top)
      const before = last.current.get(key)
      if (before === undefined || reduced || el.dataset.phase === 'enter' || el.dataset.phase === 'exit') continue
      const delta = before - top
      if (Math.abs(delta) > 0.5) moved.push([el, delta])
    }
    last.current = next
    if (!moved.length) return
    for (const [el, delta] of moved) {
      el.style.transition = 'none'
      el.style.transform = `translateY(${delta}px)`
    }
    // Next frame: release to the new place on the glide curve.
    const frame = requestAnimationFrame(() => {
      for (const [el] of moved) {
        el.style.transition = `transform ${durations.glide}ms var(--ease-out)`
        el.style.transform = ''
      }
    })
    const cleanup = setTimeout(() => {
      for (const [el] of moved) el.style.transition = ''
    }, durations.glide + 60)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(cleanup)
      for (const [el] of moved) {
        el.style.transform = ''
        el.style.transition = ''
      }
    }
  }, [orderKey, reduced])
}

/**
 * Runs `step` every animation frame for `ms` (plus a frame of slack), for
 * work that must follow a CSS transition frame by frame, such as placing the
 * native page views during a layout change. Under Reduce Motion it runs once.
 */
export function followFrames(ms: number, step: () => void): () => void {
  step()
  if (resolved.reduced || ms <= 0) return () => undefined
  const end = performance.now() + ms + 34
  let frame = requestAnimationFrame(function loop() {
    step()
    if (performance.now() < end) frame = requestAnimationFrame(loop)
  })
  return () => cancelAnimationFrame(frame)
}
