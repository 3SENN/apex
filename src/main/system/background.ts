/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BackgroundDecision, BackgroundPolicyInput } from '@shared/system'

// Background mode. backgroundPolicy is pure: what happens
// when the last window closes, or when Atelier starts at login. The lifecycle
// hooks below are what app start-up (index.ts, then app.ts) delegates
// to; until the system feature installs its runtime they keep the plain
// behaviour, so tests and early start-up need nothing.

export function backgroundPolicy(input: BackgroundPolicyInput): BackgroundDecision {
  // ⌘Q (or Quit Atelier) always really quits.
  if (input.quitting) return 'quit'
  if (input.windowCount > 0) return 'none'
  if (input.runInBackground) return input.platform === 'darwin' ? 'hide-dock' : 'stay-in-tray'
  // Without background mode a launch at login opens a window as usual, and
  // closing the last window quits on every platform: that is what the
  // "keep running" setting changes.
  return input.openedAtLogin ? 'none' : 'quit'
}

/** True when a decision keeps Atelier running without a window. */
export function keepsRunning(decision: BackgroundDecision): boolean {
  return decision === 'stay-in-tray' || decision === 'hide-dock'
}

export interface LifecycleHandlers {
  /** The last window closed; true when the runtime handled it (else the caller quits). */
  windowAllClosed(): boolean
  /** Asked once, when the first window is ready: true keeps it hidden (a launch at login in background mode). */
  startHidden(): boolean
}

let handlers: LifecycleHandlers | null = null

/** The hooks start-up calls. Each falls back to the plain behaviour until the runtime is installed. */
export const backgroundMode = {
  install(next: LifecycleHandlers | null): void {
    handlers = next
  },
  windowAllClosed(fallback: () => void): void {
    if (!handlers?.windowAllClosed()) fallback()
  },
  startHidden(): boolean {
    return handlers?.startHidden() ?? false
  },
}
