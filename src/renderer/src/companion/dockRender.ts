/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Draws the Dock icon a design describes (ST-10): a rounded square in the
// background colour and the companion's floating head, moved, rotated,
// turned and scaled, with the gaze nudging the face and the smile choosing
// the happy expression. The designer redraws it live; the saved PNG goes to
// dockIcon.apply. The head comes from the still renderer (images.ts), so a
// redraw after the first is instant.
import type { CompanionLook } from '@shared/companion'
import { dockBackgroundHex, type DockIconDesign } from '@shared/onboarding'
import { companionImage } from './images'

export const DOCK_RENDER_SIZE = 512
/** macOS icons sit inside a margin; this keeps ours the same size as the system's. */
const INSET = 0.1
const CORNER = 0.225
/** The head's radius at scale 1, of the tile's side. */
const HEAD = 0.36

const heads = new Map<string, Promise<HTMLImageElement>>()

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The companion image could not be read.'))
    img.src = src
  })
}

/** The companion's head image for a look and expression (cached). */
export function dockHead(look: CompanionLook, smile: boolean, size = DOCK_RENDER_SIZE): Promise<HTMLImageElement> {
  const key = `${JSON.stringify(look)}|${smile ? 1 : 0}|${size}`
  let hit = heads.get(key)
  if (!hit) {
    hit = companionImage(look, size, smile ? 'happy' : 'idle', { framing: 'face' }).then(loadImage)
    heads.set(key, hit)
    hit.catch(() => heads.delete(key))
    if (heads.size > 24) heads.delete(heads.keys().next().value as string)
  }
  return hit
}

export interface DockGeometry {
  tile: { x: number; y: number; size: number; radius: number }
  head: { cx: number; cy: number; r: number }
  /** Where the eyes and the mouth sit, for the designer's hit tests and handles. */
  eyes: { cx: number; cy: number; r: number }
  mouth: { cx: number; cy: number; r: number }
  handles: { rotate: { x: number; y: number }; scale: { x: number; y: number }; turn: { x: number; y: number } }
}

/** Where everything sits for a design at `size` pixels. */
export function dockGeometry(design: DockIconDesign, size: number): DockGeometry {
  const pad = size * INSET
  const tileSize = size - pad * 2
  const r = tileSize * HEAD * design.scale
  const cx = size / 2 + design.offset.x * tileSize
  const cy = size / 2 + design.offset.y * tileSize
  const a = (design.rotate * Math.PI) / 180
  const at = (dx: number, dy: number): { x: number; y: number } => ({ x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) })
  const eyes = at(design.gaze.x * r * 0.08, -r * 0.08 + design.gaze.y * r * 0.06)
  const mouth = at(0, r * 0.42)
  return {
    tile: { x: pad, y: pad, size: tileSize, radius: tileSize * CORNER },
    head: { cx, cy, r },
    eyes: { cx: eyes.x, cy: eyes.y, r: r * 0.42 },
    mouth: { cx: mouth.x, cy: mouth.y, r: r * 0.2 },
    handles: { rotate: at(0, -r * 1.12), scale: at(r * 0.82, r * 0.82), turn: at(r * 1.12, 0) },
  }
}

/** Draws the icon onto a 2D context `size` pixels square. */
export function drawDockIcon(ctx: CanvasRenderingContext2D, size: number, design: DockIconDesign, head: CanvasImageSource | null, accent: string): void {
  const g = dockGeometry(design, size)
  ctx.clearRect(0, 0, size, size)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(g.tile.x, g.tile.y, g.tile.size, g.tile.size, g.tile.radius)
  const bg = dockBackgroundHex(design, accent)
  const fill = ctx.createLinearGradient(0, g.tile.y, 0, g.tile.y + g.tile.size)
  fill.addColorStop(0, bg)
  fill.addColorStop(1, shade(bg, -0.12))
  ctx.fillStyle = fill
  ctx.fill()
  ctx.clip()
  if (head) {
    const turn = (design.turn * Math.PI) / 180
    ctx.translate(g.head.cx, g.head.cy)
    ctx.rotate((design.rotate * Math.PI) / 180)
    // A turn narrows the head and leans it, a flat stand-in for a yaw.
    ctx.transform(Math.max(0.55, Math.cos(turn)), 0, Math.sin(turn) * 0.12, 1, 0, 0)
    // The gaze nudges the face toward where it looks.
    ctx.translate(design.gaze.x * g.head.r * 0.06, design.gaze.y * g.head.r * 0.05)
    const d = g.head.r * 2
    ctx.drawImage(head, -d / 2, -d / 2, d, d)
  }
  ctx.restore()
}

/** The icon as a PNG data URL. */
export async function renderDockIcon(design: DockIconDesign, look: CompanionLook, size = DOCK_RENDER_SIZE): Promise<string> {
  const head = await dockHead(look, design.smile).catch(() => null)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The Dock icon could not be drawn.')
  drawDockIcon(ctx, size, design, head, look.colors.accent)
  const url = canvas.toDataURL('image/png')
  canvas.width = 0
  canvas.height = 0
  return url
}

/** Lightens (amount > 0) or darkens a #rrggbb colour. */
export function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  if (!Number.isFinite(n)) return hex
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount))
  return `#${ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`
}
