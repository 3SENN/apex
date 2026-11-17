/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ToastWire } from './dialogs'

// How long a toast stays (OV-05): about two seconds; longer when it
// has something to press (Undo, an action), an error to read, or a second
// line. 0 keeps it until it is closed. Shared by main, the overlay's toast
// surface and the chrome's fallback so all three agree.

export const TOAST_MS = 2000
export const TOAST_TWO_LINE_MS = 3200
export const TOAST_ERROR_MS = 4500
export const TOAST_ACTION_MS = 6000

export function toastTiming(t: Pick<ToastWire, 'kind' | 'undo' | 'action' | 'durationMs' | 'detail'>): number {
  if (t.durationMs !== undefined) return t.durationMs
  if (t.undo || t.action) return TOAST_ACTION_MS
  if (t.kind === 'error') return TOAST_ERROR_MS
  return t.detail ? TOAST_TWO_LINE_MS : TOAST_MS
}
