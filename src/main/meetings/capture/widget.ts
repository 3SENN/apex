/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CaptureState } from '@shared/meetingCapture'

// When the recording widget shows (MV-10): only while a recording runs and
// the place it started from is out of view (its tab inactive or hidden, its
// window minimised or unfocused, Apex hidden), after a short debounce so a
// quick look at another tab doesn't flash it. The wrap-up (MV-11) stays
// until it is dismissed.

export const WIDGET_DEBOUNCE_MS = 600

const RUNNING: readonly CaptureState[] = ['starting', 'recording', 'paused', 'stopping']

/** Pure: whether the widget should be on screen. */
export function widgetWanted(s: { state: CaptureState; originInView: boolean; wrapUp: boolean }): boolean {
  if (s.wrapUp) return true
  return RUNNING.includes(s.state) && !s.originInView
}

/** The window state that decides whether a recording's origin is in view. */
export interface OriginView {
  appHidden: boolean
  /** The focused, visible, unminimised Apex window, if any. */
  window: {
    activeTabId: string | null
    /** The tabs on screen in a split, both sides. */
    splitTabIds: readonly string[]
    /** A destination shown over the active tab (DS-99), or null. */
    railUrl: string | null
    /** The active tab's apex:// page, when it shows one. */
    activeInternalUrl: string | null
    hasTab(id: string): boolean
  } | null
}

/**
 * Pure: whether the origin is in view. A recording started from a tab needs
 * that tab on screen in the focused window; one started elsewhere (the
 * Meetings page, the launcher) counts as in view while Meetings is on screen.
 */
export function originInView(origin: { tabId: string | null }, view: OriginView, isMeetingsUrl: (url: string) => boolean): boolean {
  const win = view.window
  if (view.appHidden || !win) return false
  if (origin.tabId) {
    if (!win.hasTab(origin.tabId) || win.railUrl) return false
    return win.activeTabId === origin.tabId || win.splitTabIds.includes(origin.tabId)
  }
  const shown = win.railUrl ?? win.activeInternalUrl
  return shown !== null && isMeetingsUrl(shown)
}

/** Applies show and hide after the debounce; a flip back within it cancels the change. */
export class WidgetVisibility {
  readonly #apply: (show: boolean) => void
  readonly #debounceMs: number
  #shown = false
  #pending: { show: boolean; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(apply: (show: boolean) => void, debounceMs = WIDGET_DEBOUNCE_MS) {
    this.#apply = apply
    this.#debounceMs = debounceMs
  }

  shown(): boolean {
    return this.#shown
  }

  /** `immediate` skips the debounce (the wrap-up appearing, the recording ending). */
  update(wanted: boolean, immediate = false): void {
    if (this.#pending && this.#pending.show === wanted && !immediate) return
    this.#cancel()
    if (wanted === this.#shown) return
    if (immediate) {
      this.#set(wanted)
      return
    }
    const timer = setTimeout(() => {
      this.#pending = null
      this.#set(wanted)
    }, this.#debounceMs)
    this.#pending = { show: wanted, timer }
  }

  dispose(): void {
    this.#cancel()
  }

  #cancel(): void {
    if (this.#pending) clearTimeout(this.#pending.timer)
    this.#pending = null
  }

  #set(show: boolean): void {
    this.#shown = show
    this.#apply(show)
  }
}
