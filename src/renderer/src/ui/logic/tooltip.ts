/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tooltip timing (DS-95): about 500 ms over a control, then at once while
// the pointer moves between controls within a short grace period.

export const TOOLTIP_DELAY_MS = 500
export const TOOLTIP_GRACE_MS = 400

/** How long to wait before showing, given when the last tooltip hid. */
export function nextTooltipDelay(now: number, lastHiddenAt: number, delay = TOOLTIP_DELAY_MS, grace = TOOLTIP_GRACE_MS): number {
  return lastHiddenAt > 0 && now - lastHiddenAt < grace ? 0 : delay
}

/** DS-18: the element a tip is placed against: the given anchor while it is in the page, else the control. */
export function tooltipTarget<E extends { isConnected: boolean }>(control: E, anchor: E | null | undefined): E {
  return anchor && anchor.isConnected ? anchor : control
}
