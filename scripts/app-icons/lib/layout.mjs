/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The sizes every icon set shares, official (art.mjs) and unofficial
// (unofficial.mjs): the app tile's inset and body at each size, the DMG
// window and the NSIS sidebar. Geometry only, no art, so the unofficial set
// is drawn without any of the official art.

/**
 * The tile's inset and body at a size. `style` is 'mac' (Big Sur grid: an
 * 824/1024 body with room for a shadow) or 'flat' (Windows and Linux: the
 * tile nearly fills the canvas).
 */
export function layout(size, style) {
  let inset
  if (style === 'mac') {
    inset = size <= 16 ? 1 : size <= 32 ? 2 : (size * 100) / 1024
  } else {
    inset = size <= 24 ? 1 : size <= 64 ? Math.round(size / 24) : (size * 40) / 1024
  }
  const body = size - inset * 2
  return { inset, body, small: body < 48 }
}

/** The DMG window (540×380 points), with where the app and the Applications link sit. */
export const DMG = { width: 540, height: 380, app: [130, 220], applications: [410, 220] }

/** The NSIS welcome and finish page sidebar, 164×314. */
export const SIDEBAR = { width: 164, height: 314 }
