/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The empty chat's start surface (DS-72, DS-80, DS-111): pure helpers for
// where the waiting companion's greeting goes and when each part arrives.

/** Gap kept between the greeting bubble and the edge of the chat. */
export const GREETING_EDGE_PX = 12
/** Below this much room beside the head, the bubble goes to the other side (or wraps on the roomier one). */
export const GREETING_MIN_PX = 200
/** The bubble's own cap (companion.css .companion-bubble). */
export const GREETING_MAX_PX = 260

export interface GreetingPlace {
  /** 'left': the tail is on the left and the bubble reaches right of the head; 'right': the mirror. */
  side: 'left' | 'right'
  /** The widest the bubble may be; it wraps its words inside this. */
  maxWidth: number
}

/**
 * DS-80: the greeting sits beside the figure's head, on the side with room,
 * and wraps rather than running past the edge of the chat (the side panel
 * is narrow). `view` is the chat's box and `figure` the figure's, in the same
 * coordinates; the bubble starts 66% across the figure (or 34% for the left).
 */
export function greetingPlacement(view: { left: number; right: number }, figure: { left: number; width: number }): GreetingPlace {
  const right = Math.floor(view.right - (figure.left + figure.width * 0.66) - GREETING_EDGE_PX)
  const left = Math.floor(figure.left + figure.width * 0.34 - view.left - GREETING_EDGE_PX)
  if (right >= GREETING_MIN_PX || right >= left) return { side: 'left', maxWidth: Math.max(80, Math.min(GREETING_MAX_PX, right)) }
  return { side: 'right', maxWidth: Math.max(80, Math.min(GREETING_MAX_PX, left)) }
}

/**
 * DS-111: a new chat arrives in stages, like the new tab: the composer first,
 * then the figure (from partial opacity), the switcher and the floor, then
 * the tray and ideas, and the corner's last button. Milliseconds after the
 * chat shows; chat.css mirrors them (Reduce Motion shows everything at once).
 */
export const START_STAGES = {
  composer: 200,
  figure: 300,
  floor: 300,
  ideas: 850,
  last: 1050,
} as const

/** Where the figure's arrival starts from: partly there already, never popping in from nothing. */
export const FIGURE_FROM_OPACITY = 0.4
