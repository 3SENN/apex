/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { nativeTheme, type BrowserWindow } from 'electron'

// The macOS window material. DS-03 keeps the chrome a flat profile
// tint, so the chrome always paints its own opaque ground; vibrancy sits
// under it only where that ground lets it through (the moments before the
// first paint and during live resize), and turns off entirely under Reduce
// Transparency. Elsewhere there is no material to apply.

export type WindowMaterial = 'vibrant' | 'opaque'

/** Which material a window gets on this platform and with this setting. */
export function windowMaterial(platform: string, reduceTransparency: boolean): WindowMaterial {
  return platform === 'darwin' && !reduceTransparency ? 'vibrant' : 'opaque'
}

/** Applies the material and keeps it live; `onChange` hears every change (the chrome's data-material). */
export function applyWindowMaterial(window: BrowserWindow, onChange?: (material: WindowMaterial) => void): () => void {
  let last: WindowMaterial | null = null
  const apply = (): void => {
    if (window.isDestroyed()) return
    const next = windowMaterial(process.platform, nativeTheme.prefersReducedTransparency)
    if (next === last) return
    last = next
    if (process.platform === 'darwin') window.setVibrancy(next === 'vibrant' ? 'sidebar' : null)
    onChange?.(next)
  }
  apply()
  nativeTheme.on('updated', apply)
  const off = (): void => {
    nativeTheme.off('updated', apply)
  }
  window.once('closed', off)
  return off
}
