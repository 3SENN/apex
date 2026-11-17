/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Interface zoom (ST-27). On Atelier's own pages ⌘+, ⌘− and ⌘0 scale the
// whole chrome (its own zoom factor, saved app-wide as settings.uiZoom, 30 to
// 100%); on a chat page they scale the chat text instead (settings.chatZoom,
// 30 to 200%), which the chrome applies as a CSS zoom on the chat column.
// The window routes the keys here on chrome-drawn pages; websites keep the page zoom (zoom.ts).

/** The steps the keys move through; the setting can hold any value in range. */
export const UI_ZOOM_STEPS: readonly number[] = [0.3, 0.5, 0.67, 0.75, 0.8, 0.9, 1]
export const CHAT_ZOOM_STEPS: readonly number[] = [0.3, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

export type ZoomTarget = 'ui' | 'chat'

/** Which zoom an Atelier page's keys change: the chat text on chat pages, the interface elsewhere. */
export function zoomTarget(url: string | null | undefined): ZoomTarget {
  return url && /^atelier:\/\/chat\/[A-Za-z0-9_-]+/.test(url) ? 'chat' : 'ui'
}

/** The next step up or down from `current` (which may sit between steps), clamped to the ends. */
export function stepZoom(current: number, delta: 1 | -1, steps: readonly number[]): number {
  const first = steps[0] ?? 1
  const last = steps[steps.length - 1] ?? 1
  if (!Number.isFinite(current)) return 1
  if (delta > 0) return steps.find((s) => s > current + 0.001) ?? last
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (s !== undefined && s < current - 0.001) return s
  }
  return first
}

/** Keeps a stored value inside its range. */
export function clampZoom(value: number, target: ZoomTarget): number {
  const steps = target === 'chat' ? CHAT_ZOOM_STEPS : UI_ZOOM_STEPS
  const min = steps[0] ?? 1
  const max = steps[steps.length - 1] ?? 1
  if (!Number.isFinite(value)) return 1
  return Math.min(max, Math.max(min, value))
}

/** The settings patch for one key press, and the value it lands on. */
export function zoomPatch(url: string | null | undefined, settings: { uiZoom: number; chatZoom: number }, delta: 1 | -1 | 0): { patch: { uiZoom: number } | { chatZoom: number }; value: number } {
  const target = zoomTarget(url)
  const current = target === 'chat' ? settings.chatZoom : settings.uiZoom
  const value = delta === 0 ? 1 : stepZoom(current, delta, target === 'chat' ? CHAT_ZOOM_STEPS : UI_ZOOM_STEPS)
  return { patch: target === 'chat' ? { chatZoom: value } : { uiZoom: value }, value }
}
