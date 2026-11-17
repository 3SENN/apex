/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The two macOS window calls Electron 45 has no option for:
// a click on a panel must not activate Atelier (the private
// -[NSWindow _setPreventsActivation:]), and the HUD, card and widget must
// survive ⌘H (NSWindow canHide = NO). They need a small native addon in
// Atelier's own process; until it ships this returns null, and floats work
// without it (a click takes focus, which the launcher recovers through the
// helper's frontmost and activate).

export interface FloatNativeShim {
  /** Takes the BrowserWindow's getNativeWindowHandle() buffer. */
  preventActivation(handle: Buffer): void
  setCanHide(handle: Buffer, canHide: boolean): void
}

/** The native shim, or null when it isn't built for this platform. */
export function loadFloatShim(): FloatNativeShim | null {
  return null
}
