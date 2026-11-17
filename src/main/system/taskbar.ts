/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, app, nativeImage } from 'electron'
import type { AttentionState } from '@shared/notifications'
import type { OsPlatform, TaskbarOverlayKind } from '@shared/system'
import { mainT } from '../i18n/mainT'
import { log } from '../log'

// The taskbar (ST-09). Windows: one overlay icon on the taskbar
// button, by priority (a waiting approval, then the unread dot, then the
// companion chosen in the Dock-icon setting); the chrome draws each image from
// its tokens and hands it over. Windows and Linux flash the frame when an
// approval arrives while Apex is in the background; Linux also shows the
// unread count as the launcher badge.

export interface OverlayImage {
  png: string
  description: string
}

export type OverlayImages = Partial<Record<TaskbarOverlayKind, OverlayImage>>

/** The overlay to show, or null to clear it. Pure. */
export function pickOverlay(state: AttentionState, images: OverlayImages): (OverlayImage & { kind: TaskbarOverlayKind }) | null {
  if (state.needsYou > 0 && images.attention) return { kind: 'attention', ...images.attention }
  if (state.unread > 0 && images.unread) return { kind: 'unread', ...images.unread }
  if (images.companion) return { kind: 'companion', ...images.companion }
  return null
}

/** Flash when a new approval arrives while no Apex window has focus. Pure. */
export function shouldFlash(previous: AttentionState, next: AttentionState, focused: boolean): boolean {
  return !focused && next.needsYou > previous.needsYou
}

export class Taskbar {
  readonly #platform: OsPlatform
  readonly #windows: () => BrowserWindow[]
  #images: OverlayImages = {}
  #state: AttentionState = { unread: 0, needsYou: 0 }
  #shown: string | null = null
  // Bumped on every new image, so a redrawn badge of the same kind is applied again.
  #version = 0

  constructor(o: { platform: OsPlatform; windows(): BrowserWindow[] }) {
    this.#platform = o.platform
    this.#windows = o.windows
  }

  setImage(kind: TaskbarOverlayKind, png: string | null, description: string): void {
    if (png) this.#images = { ...this.#images, [kind]: { png, description } }
    else {
      const { [kind]: _dropped, ...rest } = this.#images
      this.#images = rest
    }
    this.#version++
    this.#apply()
  }

  setAttention(next: AttentionState): void {
    const previous = this.#state
    this.#state = { ...next }
    if (this.#platform === 'win32' || this.#platform === 'linux') {
      const windows = this.#live()
      if (shouldFlash(previous, next, windows.some((w) => w.isFocused()))) for (const w of windows) w.flashFrame(true)
    }
    // The launcher badge counts unread chats, as the Dock badge does (NS-02).
    if (this.#platform === 'linux' && previous.unread !== next.unread) app.setBadgeCount(next.unread)
    this.#apply()
  }

  /** A window got focus: stop flashing. New windows get the current overlay. */
  windowFocused(win: BrowserWindow): void {
    if (this.#platform === 'win32' || this.#platform === 'linux') win.flashFrame(false)
  }

  windowAdded(): void {
    this.#shown = null
    this.#apply()
  }

  #live(): BrowserWindow[] {
    return this.#windows().filter((w) => !w.isDestroyed())
  }

  #apply(): void {
    if (this.#platform !== 'win32') return
    const pick = pickOverlay(this.#state, this.#images)
    // The unread text carries the live count; the chrome's image is the same for any count.
    const description = pick?.kind === 'unread' ? mainT('system.taskbar.unread', { count: this.#state.unread }) : (pick?.description ?? '')
    const key = pick ? `${pick.kind}:${this.#version}:${description}` : ''
    if (key === this.#shown) return
    this.#shown = key
    try {
      const image = pick ? nativeImage.createFromDataURL(pick.png) : null
      for (const w of this.#live()) w.setOverlayIcon(image, description)
    } catch (err) {
      log.warn('system', 'The taskbar overlay could not be set', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}
