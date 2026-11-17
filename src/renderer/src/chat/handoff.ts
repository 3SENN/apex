/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motionReduced } from '../ui'

// DS-73: on the first send, the companion standing in the empty chat shrinks
// and travels along an arc into the first reply's gutter face. The standing
// view notes where it was as it leaves; the face, as it mounts, takes that
// note and flies a still of the figure from there to itself.

interface Standing {
  chatId: string
  rect: DOMRect
  /** A full-body still of the companion, drawn while it travels. */
  image: string | null
  at: number
  /** How long the note waits for its face (longer when the chat still has to open, DS-73). */
  window: number
}

let standing: Standing | null = null
/** A face that mounts later than this after the figure left doesn't fly. */
const HANDOFF_WINDOW_MS = 1500
const FLIGHT_MS = 560

export function noteStanding(chatId: string, rect: DOMRect, image: string | null, windowMs = HANDOFF_WINDOW_MS): void {
  standing = { chatId, rect, image, at: performance.now(), window: windowMs }
}

export function takeHandoff(chatId: string): Standing | null {
  const note = standing
  if (!note || note.chatId !== chatId || performance.now() - note.at > note.window) return null
  standing = null
  return note
}

/**
 * Flies the still from the standing place into `face`, along a gentle arc,
 * while the face itself fades in at the end. Under Reduce Motion the face
 * simply crossfades in.
 */
export function flyInto(face: HTMLElement, from: Standing): void {
  const to = face.getBoundingClientRect()
  if (motionReduced() || !from.image || to.width === 0) {
    face.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionReduced() ? 0 : 200, easing: 'ease-out' })
    return
  }
  const ghost = document.createElement('img')
  ghost.src = from.image
  ghost.alt = ''
  ghost.setAttribute('aria-hidden', 'true')
  ghost.className = 'chat-handoff'
  const size = Math.max(from.rect.width, from.rect.height)
  Object.assign(ghost.style, {
    left: `${from.rect.left + (from.rect.width - size) / 2}px`,
    top: `${from.rect.top + (from.rect.height - size) / 2}px`,
    width: `${size}px`,
    height: `${size}px`,
  })
  document.body.append(ghost)
  // The face sits in the upper part of the figure's square; aim that part at the gutter face.
  const scale = (to.width * 2.6) / size
  const startX = from.rect.left + from.rect.width / 2
  const startY = from.rect.top + from.rect.height / 2
  const endX = to.left + to.width / 2
  const endY = to.top + to.height / 2 + to.height * 0.55
  const dx = endX - startX
  const dy = endY - startY
  const lift = Math.min(120, Math.abs(dx) * 0.25 + 40)
  const flight = ghost.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - lift}px) scale(${(1 + scale) / 2})`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
    ],
    { duration: FLIGHT_MS, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' },
  )
  face.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: FLIGHT_MS, easing: 'ease-out' })
  const done = (): void => ghost.remove()
  flight.onfinish = done
  flight.oncancel = done
  setTimeout(done, FLIGHT_MS + 200)
}

// DS-74: a chat started from the new tab's ask field. The field notes where it
// was; the chat page's composer, as it mounts, glides from there to its own
// place as one shared element (a crossfade under Reduce Motion).

let composerOrigin: { chatId: string; rect: DOMRect; at: number } | null = null
const GLIDE_MS = 320

/** Called by the new tab's ask field when it sends into a chat that opens as a page. */
export function noteComposerOrigin(chatId: string, rect: DOMRect): void {
  composerOrigin = { chatId, rect, at: performance.now() }
}

/** Glides `box` (the chat composer) in from the noted ask field, once. */
export function glideComposerIn(chatId: string, box: HTMLElement): void {
  const note = composerOrigin
  if (!note || note.chatId !== chatId || performance.now() - note.at > HANDOFF_WINDOW_MS * 2) return
  composerOrigin = null
  const to = box.getBoundingClientRect()
  if (motionReduced() || to.width === 0) {
    box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionReduced() ? 0 : 160 })
    return
  }
  const dx = note.rect.left - to.left
  const dy = note.rect.top - to.top
  const sx = note.rect.width / to.width
  const sy = note.rect.height / to.height
  box.animate(
    [
      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: 'top left', transform: 'none' },
    ],
    { duration: GLIDE_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  )
}
