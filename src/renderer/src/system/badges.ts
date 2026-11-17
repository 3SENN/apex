/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Windows taskbar overlay badges (ST-09), drawn on a canvas from the
// chrome's tokens so they follow the theme: an amber "needs you" mark and a
// neutral unread dot. The overlay sits on the taskbar button's corner at
// 16 px; drawing at 32 keeps it crisp at 200% scale.

const SIZE = 32

/** A token's resolved colour (light-dark() and color-mix() included), read through a probe element. */
export function tokenColor(name: string): string {
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`
  document.body.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  const el = document.createElement('canvas')
  el.width = SIZE
  el.height = SIZE
  const ctx = el.getContext('2d')
  return ctx ? [el, ctx] : null
}

/** A filled disc with a thin ring in the ground colour, so it reads on any taskbar. */
function disc(ctx: CanvasRenderingContext2D, fill: string, ring: string): void {
  const r = SIZE / 2
  ctx.beginPath()
  ctx.arc(r, r, r - 1, 0, Math.PI * 2)
  ctx.fillStyle = ring
  ctx.fill()
  ctx.beginPath()
  ctx.arc(r, r, r - 4, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}

/** A waiting approval: the needs-input amber with an exclamation mark. */
export function attentionBadge(): string | null {
  const made = canvas()
  if (!made) return null
  const [el, ctx] = made
  disc(ctx, tokenColor('--status-needs-input'), tokenColor('--bg-raised'))
  ctx.fillStyle = tokenColor('--on-status')
  // The mark: a bar and a dot, drawn as shapes so no font is needed.
  ctx.beginPath()
  ctx.roundRect(SIZE / 2 - 2.5, 8, 5, 11, 2.5)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(SIZE / 2, 23.5, 2.75, 0, Math.PI * 2)
  ctx.fill()
  return el.toDataURL('image/png')
}

/** Unread results: the chrome's neutral unread dot, a little smaller. */
export function unreadBadge(): string | null {
  const made = canvas()
  if (!made) return null
  const [el, ctx] = made
  const r = SIZE / 2
  ctx.beginPath()
  ctx.arc(r, r, 11, 0, Math.PI * 2)
  ctx.fillStyle = tokenColor('--bg-raised')
  ctx.fill()
  ctx.beginPath()
  ctx.arc(r, r, 8, 0, Math.PI * 2)
  ctx.fillStyle = tokenColor('--status-unread-chrome')
  ctx.fill()
  return el.toDataURL('image/png')
}
