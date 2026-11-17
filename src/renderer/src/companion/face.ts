/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import { FACE_CANVAS, type CompanionLook, type FaceState, type LookAdjust, type PupilConfig } from '@shared/companion'
import { cheekColor, outlineColor, type Gaze } from '@shared/companionLogic'
import { preloadImages } from './assets'
import { CHEEKS, faceFiles, fallbackLayout, planFace, type FaceDefs, type FacePlan } from './layout'

type Ctx = CanvasRenderingContext2D

function drawCheeks(ctx: Ctx, skin: string, strength: number): void {
  if (strength <= 0) return
  const color = cheekColor(skin)
  ctx.save()
  ctx.globalAlpha = strength
  for (const x of CHEEKS.x) {
    const gradient = ctx.createRadialGradient(x, CHEEKS.y, 0, x, CHEEKS.y, CHEEKS.radius)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, `${color}00`)
    ctx.fillStyle = gradient
    ctx.fillRect(x - CHEEKS.radius, CHEEKS.y - CHEEKS.radius, CHEEKS.radius * 2, CHEEKS.radius * 2)
  }
  ctx.restore()
}

/** Draws a plan into a context whose user space is the 512×256 face canvas. */
function drawPlan(ctx: Ctx, plan: FacePlan, images: ReadonlyMap<string, HTMLImageElement>, skin: string): void {
  const { width, height } = FACE_CANVAS
  drawCheeks(ctx, skin, plan.cheeks)
  for (const draw of plan.draws) {
    const image = images.get(draw.file)
    if (!image) continue
    if (!draw.clip && draw.scale === 1 && draw.dx === 0 && draw.dy === 0 && !draw.rotate) {
      ctx.drawImage(image, 0, 0, width, height)
      continue
    }
    ctx.save()
    if (draw.clip) {
      ctx.beginPath()
      ctx.rect(draw.clip === 'left' ? 0 : width / 2, 0, width / 2, height)
      ctx.clip()
    }
    ctx.translate(draw.cx + draw.dx, draw.cy + draw.dy)
    if (draw.rotate) ctx.rotate(draw.rotate)
    ctx.scale(draw.scale, draw.scale)
    ctx.translate(-draw.cx, -draw.cy)
    ctx.drawImage(image, 0, 0, width, height)
    ctx.restore()
  }
}

export interface FaceSource {
  defs: FaceDefs
  pupils: PupilConfig
}

/**
 * The face texture: a canvas the size of FACE_CANVAS composited from cached
 * SVG layers. `update` redraws only when the plan's key changes.
 */
export class FaceCompositor {
  readonly canvas: HTMLCanvasElement
  readonly texture: THREE.CanvasTexture
  private readonly ctx: Ctx
  private images = new Map<string, HTMLImageElement>()
  private ids: CompanionLook['face'] | null = null
  private skin = '#ffffff'
  private adjust: LookAdjust | undefined
  private key = ''
  private loading = 0

  constructor(private readonly source: FaceSource) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = FACE_CANVAS.width
    this.canvas.height = FACE_CANVAS.height
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
    // Spec UVs run bottom to top, which matches the default flipY upload.
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 4
  }

  /** Loads every variant of these face parts, so later redraws never wait. */
  async setLook(ids: CompanionLook['face'], skin: string, adjust?: LookAdjust): Promise<void> {
    const ticket = ++this.loading
    if (this.skin !== skin) {
      this.skin = skin
      this.key = ''
    }
    // Adjustments only move the layers: a new plan, no new files.
    if (JSON.stringify(this.adjust ?? null) !== JSON.stringify(adjust ?? null)) {
      this.adjust = adjust ? { ...adjust } : undefined
      this.key = ''
    }
    if (this.ids && this.ids.eyes === ids.eyes && this.ids.brows === ids.brows && this.ids.mouth === ids.mouth) return
    const images = await preloadImages(faceFiles(this.source.defs, ids))
    if (ticket !== this.loading) return
    this.images = images
    this.ids = { ...ids }
    this.key = ''
  }

  /** Returns true when it redrew. */
  update(state: FaceState, gaze: Gaze, cheeks: number): boolean {
    if (!this.ids) return false
    const plan = planFace(this.source.defs, this.ids, state, gaze, this.source.pupils, cheeks, this.adjust)
    if (plan.key === this.key) return false
    this.key = plan.key
    this.ctx.clearRect(0, 0, FACE_CANVAS.width, FACE_CANVAS.height)
    drawPlan(this.ctx, plan, this.images, this.skin)
    this.texture.needsUpdate = true
    return true
  }

  dispose(): void {
    this.texture.dispose()
    this.canvas.width = 0
    this.canvas.height = 0
  }
}

// ---- 2D fallback ----

export interface FallbackFace {
  source: FaceSource | null
  images: ReadonlyMap<string, HTMLImageElement>
}

/** Loads what the fallback needs; tolerates missing assets. */
export async function loadFallbackFace(source: FaceSource | null, ids: CompanionLook['face']): Promise<FallbackFace> {
  if (!source) return { source: null, images: new Map() }
  return { source, images: await preloadImages(faceFiles(source.defs, ids)) }
}

/** Simple drawn face for when even the SVG layers are unavailable. */
function drawBasicFace(ctx: Ctx, state: FaceState): void {
  ctx.fillStyle = '#1d1630'
  ctx.strokeStyle = '#1d1630'
  ctx.lineWidth = 10
  ctx.lineCap = 'round'
  for (const [x, y] of [
    [176, 112],
    [336, 112],
  ] as const) {
    ctx.beginPath()
    if (state.eyes === 'blink' || state.eyes === 'sleepy' || state.eyes === 'happy') {
      ctx.arc(x, y + (state.eyes === 'happy' ? 10 : -6), 22, state.eyes === 'happy' ? Math.PI * 1.15 : Math.PI * 0.15, state.eyes === 'happy' ? Math.PI * 1.85 : Math.PI * 0.85)
      ctx.stroke()
    } else {
      ctx.ellipse(x, y, 20, 26, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.beginPath()
  if (state.mouth === 'sad') ctx.arc(256, 214, 30, Math.PI * 1.2, Math.PI * 1.8)
  else if (state.mouth === 'o' || state.mouth.startsWith('talk')) ctx.ellipse(256, 190, 16, state.mouth === 'talk-wide' ? 22 : 14, 0, 0, Math.PI * 2)
  else ctx.arc(256, 168, 30, Math.PI * 0.2, Math.PI * 0.8)
  if (state.mouth === 'o' || state.mouth.startsWith('talk')) ctx.fill()
  else ctx.stroke()
}

/** The fallback: the face layers in a circle tinted with the skin colour. Never a blank box. */
export function drawFallback(canvas: HTMLCanvasElement, sizePx: number, pixelRatio: number, look: CompanionLook, state: FaceState, face: FallbackFace, cheeks: number): void {
  const px = Math.max(1, Math.round(sizePx * pixelRatio))
  if (canvas.width !== px) canvas.width = px
  if (canvas.height !== px) canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  ctx.clearRect(0, 0, sizePx, sizePx)
  const layout = fallbackLayout(sizePx)
  const skin = look.colors.skin
  ctx.beginPath()
  ctx.arc(layout.cx, layout.cy, layout.radius, 0, Math.PI * 2)
  const fill = ctx.createRadialGradient(layout.cx - layout.radius * 0.35, layout.cy - layout.radius * 0.4, layout.radius * 0.1, layout.cx, layout.cy, layout.radius)
  fill.addColorStop(0, look.colors.accent)
  fill.addColorStop(0.35, skin)
  fill.addColorStop(1, skin)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = layout.stroke
  ctx.strokeStyle = outlineColor(skin)
  ctx.stroke()

  ctx.save()
  ctx.translate(layout.face.x, layout.face.y)
  ctx.scale(layout.face.width / FACE_CANVAS.width, layout.face.height / FACE_CANVAS.height)
  if (face.source && face.images.size > 0) {
    const plan = planFace(face.source.defs, look.face, state, { x: 0, y: 0 }, face.source.pupils, cheeks, look.adjust)
    drawPlan(ctx, plan, face.images, skin)
  } else {
    drawCheeks(ctx, skin, cheeks)
    drawBasicFace(ctx, state)
  }
  ctx.restore()
}
