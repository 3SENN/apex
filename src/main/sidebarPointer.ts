/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-14: main's half of the sidebar hover signal. The chrome reports the
// pointer entering the sidebar (with its rect); moving straight from the
// sidebar into a native page view, onto an overlay or out of the window can
// swallow the DOM's pointerleave, so while the pointer is in, main checks the
// cursor about every 100 ms and tells the chrome once it has left. The poll
// runs only while the pointer is in: it stops on the leave, on a blur or hide
// of the window, and when the window goes away. No Electron import, so the
// rule is unit-tested with fake timers.

/** A rect or point in the chrome's CSS px. */
export interface CssRect {
  x: number
  y: number
  width: number
  height: number
}

/** How often main checks the pointer while the chrome says it is in the sidebar. */
export const SIDEBAR_POINTER_POLL_MS = 100

/**
 * Whether the screen cursor is still inside the sidebar's rect. The rect is
 * in the chrome's CSS px, the cursor and content bounds in screen points, so
 * the point is moved into the content and divided by the zoom.
 */
export function pointerWithin(cursor: { x: number; y: number }, content: CssRect, zoom: number, rect: CssRect): boolean {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const x = (cursor.x - content.x) / z
  const y = (cursor.y - content.y) / z
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

/** What the watch reads from (and says to) its window. */
export interface SidebarPointerHost {
  /** False once the window (or its chrome) is destroyed. */
  alive(): boolean
  /** Visible and not minimised. */
  visible(): boolean
  cursor(): { x: number; y: number }
  /** The window's content bounds, in screen points. */
  content(): CssRect
  zoom(): number
  /** Tells the chrome the pointer has left the sidebar. */
  left(): void
}

export interface PollTimers {
  every(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

const NODE_TIMERS: PollTimers = {
  every: (fn, ms) => {
    const timer = setInterval(fn, ms)
    timer.unref?.()
    return timer
  },
  cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

export class SidebarPointerWatch {
  readonly #host: SidebarPointerHost
  readonly #timers: PollTimers
  #rect: CssRect | null = null
  #timer: unknown = null

  constructor(host: SidebarPointerHost, timers: PollTimers = NODE_TIMERS) {
    this.#host = host
    this.#timers = timers
  }

  /** True while main is polling the cursor. */
  get active(): boolean {
    return this.#timer !== null
  }

  /** The chrome says the pointer is in the sidebar (its rect) or has left it (null). */
  track(rect: CssRect | null): void {
    this.stop()
    if (!rect || !this.#host.alive()) return
    this.#rect = rect
    this.#timer = this.#timers.every(() => this.check(), SIDEBAR_POINTER_POLL_MS)
  }

  /** One poll: still inside keeps watching; anything else stops and tells the chrome. */
  check(): void {
    const rect = this.#rect
    if (!rect) return
    if (!this.#host.alive()) return this.stop()
    let inside = false
    try {
      inside = this.#host.visible() && pointerWithin(this.#host.cursor(), this.#host.content(), this.#host.zoom(), rect)
    } catch {
      inside = false
    }
    if (!inside) this.release()
  }

  /**
   * The window blurred or hid, or the pointer was seen leaving: stop polling
   * and, if it was watching, tell the chrome the pointer is out. A later move
   * inside the sidebar re-arms it.
   */
  release(): void {
    if (!this.active) return
    this.stop()
    if (this.#host.alive()) this.#host.left()
  }

  /** Stops polling without telling the chrome (it asked, or the window is closing). */
  stop(): void {
    if (this.#timer !== null) this.#timers.cancel(this.#timer)
    this.#timer = null
    this.#rect = null
  }
}
