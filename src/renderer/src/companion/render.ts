/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import { MOOD_CLIP, type CompanionLook, type CompanionMood } from '@shared/companion'
import { moodGaze, normalizeLook, resolveFace } from '@shared/companionLogic'
import { Animator } from './animator'
import { loadCompanionAssets, type CompanionAssets } from './assets'
import { buildCharacter } from './character'
import { GAITS, type Motion } from './locomotion'
import { drawFallback, FaceCompositor, loadFallbackFace } from './face'
import { frameBounds, frameFace, framePortrait, MOOD_CHEEKS, outlinePixels, worldPerPixel, type CompanionFraming, type Framing } from './layout'
import { Stage } from './stage'
import { reportCompanionError } from './stats'

// Renders run one at a time on one off-screen renderer, so a gallery of
// thumbnails holds a single extra WebGL context and creates it once. The
// renderer is released after a short idle spell.
let queue: Promise<unknown> = Promise.resolve()
const IDLE_MS = 5000
let shared: THREE.WebGLRenderer | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
// The last render's materials stay until the next render has drawn, so the
// shader programs they share carry over: a gallery compiles its shaders once,
// not once per thumbnail (seconds each where WebGL is software, as on a
// machine without a GPU). Geometries are freed at once (character.ts).
let warm: THREE.Material[] = []

function keepWarm(next: THREE.Material[]): void {
  for (const material of warm) material.dispose()
  warm = next
}

function offscreenRenderer(px: number): THREE.WebGLRenderer {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (shared?.getContext().isContextLost()) releaseRenderer()
  if (!shared) {
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' })
    renderer.setPixelRatio(1)
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    shared = renderer
  }
  shared.setSize(px, px, false)
  return shared
}

function releaseRenderer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  keepWarm([])
  if (!shared) return
  const renderer = shared
  shared = null
  renderer.dispose()
  renderer.forceContextLoss()
  renderer.domElement.width = 0
  renderer.domElement.height = 0
}

function releaseWhenIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(releaseRenderer, IDLE_MS)
}

/**
 * Runs `work` once every render queued before it is done. `limitMs` counts from when it starts, not from when
 * it was queued: a gallery queues many renders at once, and where WebGL is slow (software rendering on a
 * machine without a GPU) the last ones would otherwise run out of time while they wait their turn, and never
 * show. A render past its limit rejects; the queue still waits for it, since it holds the shared renderer.
 */
function enqueue<T>(work: () => Promise<T>, limitMs?: number): Promise<T> {
  let expire: ((err: Error) => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const job = queue.then(() => {
    if (limitMs !== undefined) timer = setTimeout(() => expire?.(new Error('The companion took too long to draw.')), limitMs)
    return work()
  })
  queue = job.catch(() => undefined)
  if (limitMs === undefined) return job
  return new Promise<T>((resolve, reject) => {
    expire = reject
    void job.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export interface RenderOptions {
  /** 'face' leaves the body out and centres the head on the eyes (the small floating heads). Default 'full'. */
  framing?: Exclude<CompanionFraming, 'auto'>
  /** The blink frame: the same still with the eyes shut (for breathing stills). */
  blink?: boolean
}

/**
 * Renders a look off-screen at `size`×`size` device pixels with a transparent
 * background and returns a PNG data URL (avatars, Dock icon, thumbnails,
 * the still a live view shows first). Stills look straight ahead. Falls
 * back to the 2D face when WebGL or the assets are unavailable. With
 * `limitMs`, it rejects when the render itself runs longer than that.
 */
export function renderCompanionImage(look: CompanionLook, size: number, mood: CompanionMood = 'idle', options: RenderOptions = {}, limitMs?: number): Promise<string> {
  return enqueue(() => render(look, size, mood, options), limitMs)
}

/** Frames in a walk strip: one cycle, two steps. */
export const WALK_FRAMES = 8
/** A strip's turn toward the right (three-quarter view); a page mirrors it for the left. */
const WALK_YAW = 0.45

/**
 * One walk (or run) cycle as a strip of WALK_FRAMES frames, side by side, each
 * `size`×`size` device pixels and framed exactly like the full-body still, so
 * a page can swap between the two without the feet moving. Turned toward the
 * right. A WebP data URL, drawn once per look on the same queue as stills
 * (`limitMs` as for renderCompanionImage).
 */
export function renderCompanionWalk(look: CompanionLook, size: number, motion: Motion = 'walk', limitMs?: number): Promise<string> {
  return enqueue(() => renderWalk(look, size, motion), limitMs)
}

async function renderWalk(raw: CompanionLook, size: number, motion: Motion): Promise<string> {
  const px = Math.max(16, Math.min(512, Math.round(Number.isFinite(size) ? size : 128)))
  const assets = await loadCompanionAssets()
  const look = normalizeLook(raw, assets.compatibility)
  let compositor: FaceCompositor | null = null
  let stage: Stage | null = null
  let character: Awaited<ReturnType<typeof buildCharacter>> | null = null
  let animator: Animator | null = null
  let ok = false
  const strip = document.createElement('canvas')
  try {
    const renderer = offscreenRenderer(px)
    compositor = new FaceCompositor({ defs: assets.manifest.face, pupils: assets.pupils })
    await compositor.setLook(look.face, look.colors.skin, look.adjust)
    compositor.update(resolveFace({ mood: 'idle', blinking: false }), moodGaze('idle', { x: 0, y: 0 }), MOOD_CHEEKS.idle)
    character = await buildCharacter(look, assets, compositor.texture)
    if (!character.clips.has(motion)) throw new Error(`no ${motion} for rig ${look.rig}`)
    stage = new Stage()
    stage.scene.add(character.root)
    animator = new Animator(character.rig, character.clips, {})
    animator.setMood('idle', 0)
    animator.update(0)
    // Framed at rest, like the still, before the turn and the steps.
    const framing = stillFraming(character, 'full')
    stage.frame(framing)
    stage.fitShadow(character.bounds)
    character.setOutlineThickness(outlinePixels(px) * worldPerPixel(framing, px))
    character.root.rotation.y = WALK_YAW
    animator.setMoving(motion, { fade: 0 })
    strip.width = px * WALK_FRAMES
    strip.height = px
    const ctx = strip.getContext('2d')
    if (!ctx) throw new Error('no 2D context for the walk strip')
    for (let k = 0; k < WALK_FRAMES; k++) {
      animator.update(k === 0 ? 0 : GAITS[motion].cycle / WALK_FRAMES)
      renderer.render(stage.scene, stage.camera)
      ctx.drawImage(renderer.domElement, k * px, 0)
    }
    const url = strip.toDataURL('image/webp', 0.9)
    ok = true
    return url
  } finally {
    strip.width = 0
    strip.height = 0
    const kept: THREE.Material[] = []
    animator?.dispose()
    character?.dispose(ok ? kept : undefined)
    compositor?.dispose()
    stage?.dispose()
    if (ok) {
      keepWarm(kept)
      releaseWhenIdle()
    } else releaseRenderer()
  }
}

function stillFraming(character: Awaited<ReturnType<typeof buildCharacter>>, framing: RenderOptions['framing']): Framing {
  if (framing === 'face') return frameFace(character.headBounds, character.skullBounds, character.eyeY)
  if (framing === 'bust') return framePortrait(character.bounds, character.headBounds)
  return frameBounds(character.bounds, 1.1)
}

async function render(raw: CompanionLook, size: number, mood: CompanionMood, options: RenderOptions): Promise<string> {
  const px = Math.max(16, Math.min(2048, Math.round(Number.isFinite(size) ? size : 512)))
  let assets: CompanionAssets | null = null
  try {
    assets = await loadCompanionAssets()
  } catch {
    // Reported by the loader; draw the fallback below.
  }
  const look = normalizeLook(raw, assets?.compatibility ?? {})
  if (assets) {
    try {
      return await render3d(look, px, mood, assets, options)
    } catch (error) {
      reportCompanionError(`off-screen render: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const canvas = document.createElement('canvas')
  const face = await loadFallbackFace(assets ? { defs: assets.manifest.face, pupils: assets.pupils } : null, look.face)
  drawFallback(canvas, px, 1, look, resolveFace({ mood, blinking: options.blink === true }), face, MOOD_CHEEKS[mood])
  const url = canvas.toDataURL('image/png')
  canvas.width = 0
  canvas.height = 0
  return url
}

async function render3d(look: CompanionLook, px: number, mood: CompanionMood, assets: CompanionAssets, options: RenderOptions): Promise<string> {
  let compositor: FaceCompositor | null = null
  let stage: Stage | null = null
  let character: Awaited<ReturnType<typeof buildCharacter>> | null = null
  let animator: Animator | null = null
  let ok = false
  try {
    const renderer = offscreenRenderer(px)
    compositor = new FaceCompositor({ defs: assets.manifest.face, pupils: assets.pupils })
    await compositor.setLook(look.face, look.colors.skin, look.adjust)
    compositor.update(resolveFace({ mood, blinking: options.blink === true }), moodGaze(mood, { x: 0, y: 0 }), MOOD_CHEEKS[mood])

    character = await buildCharacter(look, assets, compositor.texture)
    stage = new Stage()
    stage.scene.add(character.root)
    animator = new Animator(character.rig, character.clips, {})
    animator.setMood(mood, 0)
    animator.update(0)
    // A still shows the clip's opening pose, so apply its opening prop cue too
    // (thinking and sleeping put the prop away).
    const cue = assets.animationEvents[MOOD_CLIP[mood]]?.find((e) => e.type === 'prop' && e.t < 0.25)
    if (cue?.type === 'prop' && character.prop) character.prop.visible = cue.visible

    const framing = stillFraming(character, options.framing)
    stage.frame(framing)
    stage.fitShadow(character.bounds)
    if (options.framing === 'face') {
      character.setBodyVisible(false)
      stage.showShadow(false)
    }
    character.setOutlineThickness(outlinePixels(px) * worldPerPixel(framing, px))
    renderer.render(stage.scene, stage.camera)
    const url = renderer.domElement.toDataURL('image/png')
    ok = true
    return url
  } finally {
    const kept: THREE.Material[] = []
    animator?.dispose()
    character?.dispose(ok ? kept : undefined)
    compositor?.dispose()
    stage?.dispose()
    // A failed render may have left the context unusable; start afresh next time.
    if (ok) {
      keepWarm(kept)
      releaseWhenIdle()
    } else releaseRenderer()
  }
}
