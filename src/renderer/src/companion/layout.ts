/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure layout maths for the companion renderer: camera framing, outline
// width and the face compositor's draw plan. No DOM and no three.js, so it
// is unit-tested in node.

import { FACE_CANVAS, type CompanionLook, type CompanionMood, type EyeVariant, type FaceLayer, type FacePartDef, type FaceState, type LookAdjust, type LookAdjustKey, type PupilConfig } from '@shared/companion'
import { showsPupils, type Gaze } from '@shared/companionLogic'

// ---- camera ----

export const CAMERA_FOV = 26

export interface Bounds {
  min: readonly [number, number, number]
  max: readonly [number, number, number]
}

export interface Framing {
  /** Height the camera looks at. */
  targetY: number
  /** Camera distance along +Z. */
  distance: number
  /** World units visible across the square view at the target. */
  span: number
}

/**
 * Fits the character in a square view. It stays centred on its own axis
 * (x = 0) even when a prop sticks out on one side, and `margin` leaves room
 * for hops and waves that go past the rest pose.
 */
export function frameBounds(bounds: Bounds, margin = 1.18, fov = CAMERA_FOV): Framing {
  const [minX, minY, minZ] = bounds.min
  const [maxX, maxY, maxZ] = bounds.max
  const valid = [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) && maxY > minY
  if (!valid) return frameBounds({ min: [-0.6, 0, -0.5], max: [0.6, 1.6, 0.5] }, margin, fov)
  const bottom = Math.min(minY, 0)
  const height = maxY - bottom
  const width = 2 * Math.max(Math.abs(minX), Math.abs(maxX))
  const span = Math.max(height, width, 0.1) * margin
  const halfFov = ((fov / 2) * Math.PI) / 180
  // Distance to the front of the bounds, so a deep prop does not clip.
  const distance = span / 2 / Math.tan(halfFov) + Math.max(0, maxZ)
  return { targetY: bottom + height / 2, distance, span }
}

/** Live views smaller than this frame head and shoulders, so the face stays readable. */
export const PORTRAIT_BELOW = 80

/**
 * Head-and-shoulders framing: the head (with hair, hat and ears) plus a
 * little of the body, centred on the character's axis. `margin` leaves room
 * for hops and the head turning.
 */
export function framePortrait(bounds: Bounds, head: Bounds, margin = 1.16, fov = CAMERA_FOV): Framing {
  const valid = [...head.min, ...head.max].every(Number.isFinite) && head.max[1] > head.min[1]
  if (!valid) return frameBounds(bounds, margin, fov)
  const headHeight = head.max[1] - head.min[1]
  const bottom = Math.max(Math.min(bounds.min[1], 0), head.min[1] - headHeight * 0.32)
  const top = head.max[1]
  const height = top - bottom
  const width = 2 * Math.max(Math.abs(head.min[0]), Math.abs(head.max[0]))
  const span = Math.max(height, width, 0.1) * margin
  const halfFov = ((fov / 2) * Math.PI) / 180
  const distance = span / 2 / Math.tan(halfFov) + Math.max(0, head.max[2])
  return { targetY: bottom + height / 2, distance, span }
}

/**
 * How a view frames the character. 'auto' picks the face below
 * PORTRAIT_BELOW and the full body above; 'bust' is head and shoulders.
 */
export type CompanionFraming = 'auto' | 'full' | 'bust' | 'face'

/** Small stills at or under this many CSS pixels show only the face (CO-18). */
export const FACE_BELOW = 80

/** The framing a still of `devicePx` device pixels uses: small ones (under FACE_BELOW CSS px at 2×) are face-only. */
export function stillFraming(mode: CompanionFraming | undefined, devicePx: number): Exclude<CompanionFraming, 'auto'> {
  if (mode && mode !== 'auto') return mode
  return devicePx < FACE_BELOW * 2 ? 'face' : 'full'
}

/** The framing a view of `sizePx` uses for `mode`. */
export function resolveFraming(mode: CompanionFraming, sizePx: number): Exclude<CompanionFraming, 'auto'> {
  if (mode !== 'auto') return mode
  return sizePx < PORTRAIT_BELOW ? 'face' : 'full'
}

/**
 * Farthest point of the ellipse inscribed in `box` (x, y only) from
 * (0, cy): what a round frame centred there must reach to hold it.
 */
export function ellipseReach(box: Bounds, cy: number, samples = 48): number {
  const a = Math.max(Math.abs(box.min[0]), Math.abs(box.max[0]))
  const b = (box.max[1] - box.min[1]) / 2
  const ey = (box.max[1] + box.min[1]) / 2
  let reach = 0
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2
    reach = Math.max(reach, Math.hypot(a * Math.cos(t), ey + b * Math.sin(t) - cy))
  }
  return reach
}

/**
 * Face-only framing for the small floating heads (CO-18, DS-67): the whole
 * head, with its hair, ears and hat, fits inside the square box with nothing
 * clipped, since there is no disc to hide an overflow. Horizontally it is
 * centred on the face; vertically it leans from the middle of the head toward
 * the eye line (between the two) as far as that costs at most `lean` extra
 * span, so a tall hat moves the face down a little rather than shrinking it a
 * lot. The span covers the front of the head under perspective, so a brim or
 * a nose never touches the edge.
 */
export function frameFace(head: Bounds, skull: Bounds | null, eyeY: number | null, fill = 0.94, lean = 1.06, fov = CAMERA_FOV): Framing {
  const valid = (b: Bounds | null): b is Bounds => !!b && [...b.min, ...b.max].every(Number.isFinite) && b.max[1] > b.min[1]
  if (!valid(head)) return frameBounds(head, 1.1, fov)
  const core = valid(skull) ? skull : head
  const eyes = eyeY !== null && Number.isFinite(eyeY) && eyeY > core.min[1] && eyeY < core.max[1] ? eyeY : core.min[1] + (core.max[1] - core.min[1]) * 0.48
  const mid = (head.min[1] + head.max[1]) / 2
  const halfH = (head.max[1] - head.min[1]) / 2
  const halfW = Math.max(Math.abs(head.min[0]), Math.abs(head.max[0]))
  const tightest = Math.max(halfH, halfW)
  // The face's own centre (between the eye line and the head's middle), held near the bounds' middle.
  const allow = Math.max(0, tightest * lean - halfH)
  const offset = Math.max(-allow, Math.min(allow, (eyes + mid) / 2 - mid))
  const cy = mid + offset
  const reach = Math.max(halfH + Math.abs(offset), halfW)
  const halfFov = ((fov / 2) * Math.PI) / 180
  // Points in front of the target plane draw larger: grow the span until the front of the head fits too.
  const front = Math.max(0, head.max[2])
  let span = Math.max(0.05, (2 * reach) / fill)
  for (let i = 0; i < 3; i++) {
    const distance = span / 2 / Math.tan(halfFov)
    const grow = distance / Math.max(distance * 0.2, distance - front)
    span = Math.max(0.05, (2 * reach * grow) / fill)
  }
  return { targetY: cy, distance: span / 2 / Math.tan(halfFov), span }
}

/** World units per CSS pixel at the framing target. */
export function worldPerPixel(framing: Framing, sizePx: number): number {
  return framing.span / Math.max(1, sizePx)
}

/** Outline width in CSS pixels: never thinner than about a pixel, scales up for big renders. */
export function outlinePixels(sizePx: number): number {
  return Math.max(1.25, sizePx * 0.0085)
}

// ---- face ----

export const EYE_CENTERS = [
  [176, 112],
  [336, 112],
] as const

/** Blush strength per mood, 0..1. */
export const MOOD_CHEEKS: Record<CompanionMood, number> = {
  idle: 0.45,
  listening: 0.5,
  thinking: 0.35,
  working: 0.35,
  talking: 0.5,
  approval: 0.55,
  happy: 0.8,
  sad: 0.25,
  sleeping: 0.4,
}

export const CHEEKS = { y: 166, x: [118, 394], radius: 40 } as const

export interface FaceDraw {
  layer: FaceLayer | 'pupils'
  /** Path under the asset base. */
  file: string
  dx: number
  dy: number
  /** Scale about (cx, cy). */
  scale: number
  cx: number
  cy: number
  /** Pupils are drawn per eye, clipped to that half of the canvas. */
  clip: 'left' | 'right' | null
  /** Radians about (cx, cy), for tilted brows (DS-120). Absent is 0. */
  rotate?: number
}

export interface FacePlan {
  cheeks: number
  draws: FaceDraw[]
  /** Changes whenever the drawn pixels would; the compositor redraws only then. */
  key: string
}

export type FaceDefs = Record<FaceLayer, Record<string, FacePartDef>>

function variantFile(def: FacePartDef | undefined, variant: string): string | null {
  if (!def) return null
  return def.variants[variant] ?? def.variants.neutral ?? null
}

/** Half-pixel steps keep pointer jitter from forcing a redraw every frame. */
function halfPixel(v: number): number {
  return Math.round(v * 2) / 2 || 0
}

export function pupilOffset(gaze: Gaze, config: PupilConfig[string] | undefined): { dx: number; dy: number } {
  const rangeX = config?.rangeX ?? 0.025
  const rangeY = config?.rangeY ?? 0.035
  const gx = Math.max(-1, Math.min(1, gaze.x))
  const gy = Math.max(-1, Math.min(1, gaze.y))
  return { dx: halfPixel(gx * rangeX * FACE_CANVAS.width), dy: halfPixel(-gy * rangeY * FACE_CANVAS.height) }
}

/** What to draw for one face state: eyes, pupils (if the variant shows them), brows, mouth. */
/** Where the brows and mouth sit on the 512×256 face canvas, for scaling them in place. */
export const BROW_CENTERS = [
  [176, 62],
  [336, 62],
] as const
export const MOUTH_CENTER = [256, 190] as const

/**
 * DS-120 face adjustments in canvas units, from the look's -1..1 values:
 * sizes scale a feature about its own centre, heights move it (up is
 * positive), spacing moves the eyes apart, tilt turns the brows (outer ends
 * up for positive values).
 */
export function faceTweaks(adjust: LookAdjust | undefined): {
  eye: { scale: number; spread: number; lift: number }
  brow: { scale: number; lift: number; tilt: number }
  mouth: { scale: number; lift: number }
} {
  const v = (key: LookAdjustKey): number => adjust?.[key] ?? 0
  return {
    eye: { scale: 1 + v('eyeSize') * 0.25, spread: v('eyeSpacing') * 18, lift: v('eyeHeight') * 16 },
    brow: { scale: 1 + v('browSize') * 0.25, lift: v('browHeight') * 14, tilt: v('browTilt') * 0.3 },
    mouth: { scale: 1 + v('mouthSize') * 0.3, lift: v('mouthHeight') * 14 },
  }
}

export function planFace(defs: FaceDefs, ids: CompanionLook['face'], state: FaceState, gaze: Gaze, pupils: PupilConfig, cheeks: number, adjust?: LookAdjust): FacePlan {
  const draws: FaceDraw[] = []
  const tweak = faceTweaks(adjust)
  const plain = (layer: FaceLayer, file: string | null): void => {
    if (file) draws.push({ layer, file, dx: 0, dy: 0, scale: 1, cx: 0, cy: 0, clip: null })
  }
  // A pair drawn per side, so each half can move, scale and turn about its own centre.
  const paired = (layer: FaceLayer, file: string | null, centres: ReadonlyArray<readonly [number, number]>, t: { scale: number; spread: number; lift: number; tilt: number }): void => {
    if (!file) return
    if (t.scale === 1 && t.spread === 0 && t.lift === 0 && t.tilt === 0) return plain(layer, file)
    centres.forEach(([cx, cy], i) => {
      const side = i === 0 ? -1 : 1
      draws.push({ layer, file, dx: side * t.spread, dy: -t.lift, scale: t.scale, cx, cy, clip: i === 0 ? 'left' : 'right', ...(t.tilt ? { rotate: -side * t.tilt } : {}) })
    })
  }
  const eyesDef = defs.eyes[ids.eyes]
  paired('eyes', variantFile(eyesDef, state.eyes), EYE_CENTERS, { ...tweak.eye, tilt: 0 })
  if (eyesDef?.pupils && showsPupils(eyesDef, state.eyes as EyeVariant)) {
    const config = pupils[ids.eyes]
    const { dx, dy } = pupilOffset(gaze, config)
    const scale = (config?.scale ?? 1) * tweak.eye.scale
    EYE_CENTERS.forEach(([cx, cy], i) => {
      const side = i === 0 ? -1 : 1
      draws.push({ layer: 'pupils', file: eyesDef.pupils as string, dx: dx * tweak.eye.scale + side * tweak.eye.spread, dy: dy * tweak.eye.scale - tweak.eye.lift, scale, cx, cy, clip: i === 0 ? 'left' : 'right' })
    })
  }
  paired('brows', variantFile(defs.brows[ids.brows], state.brows), BROW_CENTERS, { ...tweak.brow, spread: tweak.eye.spread })
  const mouthFile = variantFile(defs.mouth[ids.mouth], state.mouth)
  if (mouthFile && (tweak.mouth.scale !== 1 || tweak.mouth.lift !== 0)) {
    draws.push({ layer: 'mouth', file: mouthFile, dx: 0, dy: -tweak.mouth.lift, scale: tweak.mouth.scale, cx: MOUTH_CENTER[0], cy: MOUTH_CENTER[1], clip: null })
  } else plain('mouth', mouthFile)
  const strength = Math.round(Math.max(0, Math.min(1, cheeks)) * 100) / 100
  const key = `${strength};${draws.map((d) => `${d.file}@${d.dx},${d.dy},${d.scale}${d.rotate ? `r${d.rotate}` : ''}${d.clip ? d.clip[0] : ''}`).join(';')}`
  return { cheeks: strength, draws, key }
}

/** Every file a face may need across all variants, for preloading. */
export function faceFiles(defs: FaceDefs, ids: CompanionLook['face']): string[] {
  const files = new Set<string>()
  const eyes = defs.eyes[ids.eyes]
  for (const def of [eyes, defs.brows[ids.brows], defs.mouth[ids.mouth]]) {
    if (!def) continue
    for (const file of Object.values(def.variants)) files.add(file)
  }
  if (eyes?.pupils) files.add(eyes.pupils)
  return [...files]
}

// ---- 2D fallback ----

export interface FallbackLayout {
  cx: number
  cy: number
  radius: number
  stroke: number
  /** Where the 512×256 face layer lands. */
  face: { x: number; y: number; width: number; height: number }
}

/** A tinted circle with the face across its middle. */
export function fallbackLayout(sizePx: number): FallbackLayout {
  const radius = sizePx * 0.42
  const width = radius * 1.75
  const height = width * (FACE_CANVAS.height / FACE_CANVAS.width)
  const cx = sizePx / 2
  const cy = sizePx / 2
  return { cx, cy, radius, stroke: Math.max(1, sizePx * 0.03), face: { x: cx - width / 2, y: cy - height * 0.52, width, height } }
}
