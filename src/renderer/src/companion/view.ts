/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import type { AnimationEvent, ClipId, CompanionLook, CompanionMood, FaceState } from '@shared/companion'
import {
  BLINK_SECONDS,
  decayTalk,
  modelKey,
  moodGaze,
  normalizeLook,
  resolveFace,
  type Gaze,
} from '@shared/companionLogic'
import { Animator } from './animator'
import { bobPixels, gazeStep, idleBlinks, listenBlinks, nextGlance } from './cadence'
import { loadCompanionAssets, onCompanionAssetsLoaded, type CompanionAssets } from './assets'
import { buildCharacter, type Character } from './character'
import { drawFallback, FaceCompositor, loadFallbackFace, type FallbackFace } from './face'
import { frameBounds, framePortrait, MOOD_CHEEKS, outlinePixels, resolveFraming, worldPerPixel, type CompanionFraming, type Framing } from './layout'
import type { IdleStage } from './presenceCore'
import { Sparkles, Stage } from './stage'
import { reportCompanionError, reportCompanionReady } from './stats'

export interface ViewInit {
  look: CompanionLook
  mood: CompanionMood
  size: number
  framing?: CompanionFraming
  /** The stage's own soft ground shadow (default on); off where the surface draws its own floor. */
  shadow?: boolean
  /** The first frame is on screen (or the 2D fallback is), so a still shown meanwhile can go. */
  onReady?: () => void
}

/** A point in viewport coordinates the eyes go to (the caret while you type). */
export interface LookTarget {
  x: number
  y: number
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
/** Under Reduce Motion the clips hold still (no bob or sway), so one-shots show only their expression. */
const REDUCED_MOTION_SKIP: readonly ClipId[] = ['wave', 'poke']
const SQUASH_SECONDS = 0.32
const POINTER_REST_MS = 5000
/** Moving the mouse this far hands the gaze back from a look target to the pointer. */
const HAND_BACK_PX = 6
const PAT_SECONDS = 0.9
const CELEBRATE_SECONDS = 1.6
/** After a lost WebGL context: first rebuild delay, doubled per attempt. */
const RESTORE_MS = 1000
const MAX_RESTORES = 3
/** A context that survived this long since its rebuild earns a fresh set of attempts. */
const RESTORE_RESET_MS = 60_000

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 2)
}

/**
 * One live companion: a WebGL canvas (or the 2D fallback) inside `host`.
 * Imperative so React only forwards prop changes; nothing here re-renders.
 */
export class CompanionView {
  private disposed = false
  private size: number
  private mood: CompanionMood
  private requested = ''
  private requestedLook: CompanionLook | null = null
  private lookTicket = 0
  private look: CompanionLook | null = null
  private assets: CompanionAssets | null = null
  /** The assets failed to load; try the look again when a later load succeeds. */
  private retryOnAssets = false

  // 3D
  private canvas: HTMLCanvasElement | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private stage: Stage | null = null
  private shadowOn = true
  private sparkles: Sparkles | null = null
  private compositor: FaceCompositor | null = null
  private character: Character | null = null
  private animator: Animator | null = null
  private framing: Framing | null = null
  private framingTarget: Framing | null = null
  private restHead = new THREE.Quaternion()
  private restBody = new THREE.Vector3(1, 1, 1)
  private reportedReady = false
  private restoreTimer: ReturnType<typeof setTimeout> | null = null
  private restores = 0
  private restoredAt = -Infinity

  // 2D fallback
  private fallbackCanvas: HTMLCanvasElement | null = null
  private fallbackFace: FallbackFace | null = null
  private fallbackLook: CompanionLook | null = null

  // behaviour
  private time = 0
  private talkEnergy = 0
  /** View times of the coming blinks, soonest first. */
  private blinks: number[] = idleBlinks(0, Math.random)
  private blinkUntil = -1
  /** The held sideways glance while nothing else draws the eyes, and when it shifts. */
  private glance: Gaze | null = null
  private glanceUntil = 0
  private expression: { face: Partial<FaceState>; until: number } | null = null
  private squashes: Array<{ start: number; amount: number }> = []
  private pendingGreet = false
  /** Mixer changes wait for the next frame, after rest values are restored. */
  private moodChanged = false
  private pendingOneShot: ClipId | null = null
  private pointer: Gaze = { x: 0, y: 0 }
  private pointerAt = 0
  private pointerClient: { x: number; y: number } | null = null
  private lookTarget: LookTarget | null = null
  /** Where the pointer was when the look target took over. */
  private lookTargetPointer: { x: number; y: number } | null = null
  private gaze: Gaze = { x: 0, y: 0 }
  private reducedMotion = false
  private framingMode: CompanionFraming = 'auto'
  private idle: IdleStage = 'awake'
  private wander: Gaze = { x: 0, y: 0 }
  private nextWander = 0
  private patUntil = -1
  private onReady: (() => void) | null = null
  private readyFired = false

  // loop
  private frameId = 0
  private last = 0
  private onScreen = true
  private readonly cleanups: Array<() => void> = []

  constructor(
    private readonly host: HTMLElement,
    init: ViewInit,
  ) {
    this.size = init.size
    this.mood = init.mood
    this.framingMode = init.framing ?? 'auto'
    this.onReady = init.onReady ?? null
    this.shadowOn = init.shadow !== false
    this.createRenderer()
    this.watchEnvironment()
    void this.setLook(init.look)
  }

  // ---- public API ----

  async setLook(raw: CompanionLook): Promise<void> {
    const key = JSON.stringify(raw ?? null)
    if (this.disposed || key === this.requested) return
    this.requested = key
    this.requestedLook = raw
    const ticket = ++this.lookTicket
    const stale = (): boolean => this.disposed || ticket !== this.lookTicket

    let assets: CompanionAssets
    try {
      assets = await loadCompanionAssets()
    } catch {
      if (stale()) return
      // Not this look's fault: the same look may be asked for again.
      this.requested = ''
      this.retryOnAssets = true
      await this.showFallback(normalizeLook(raw, {}), null)
      return
    }
    if (stale()) return
    this.retryOnAssets = false
    this.assets = assets
    const look = normalizeLook(raw, assets.compatibility)
    if (!this.renderer || !this.stage) {
      await this.showFallback(look, assets)
      return
    }

    this.compositor ??= new FaceCompositor({ defs: assets.manifest.face, pupils: assets.pupils })
    const faceReady = this.compositor.setLook(look.face, look.colors.skin, look.adjust)

    if (this.character && this.character.modelKey === modelKey(look)) {
      await faceReady
      if (stale()) return
      // The context may have been lost while the face loaded.
      if (!this.character || !this.stage) {
        await this.showFallback(look, assets)
        return
      }
      this.character.setColors(look.colors)
      this.sparkles?.setAccent(look.colors.accent)
      this.look = look
      return
    }

    let character: Character
    try {
      ;[character] = await Promise.all([buildCharacter(look, assets, this.compositor.texture), faceReady])
    } catch (error) {
      reportCompanionError(`assemble ${look.rig}/${look.parts.head}: ${message(error)}`)
      // Keep showing the previous character if there is one. Otherwise fall
      // back, and let a later request for the same look try again.
      if (!stale() && !this.character) {
        this.requested = ''
        await this.showFallback(look, assets)
      }
      return
    }
    if (stale() || !this.stage) {
      character.dispose()
      // The context was lost while this look was building.
      if (!stale()) await this.showFallback(look, assets)
      return
    }
    this.install(character, look, assets)
  }

  setMood(mood: CompanionMood): void {
    if (mood === this.mood) return
    // A quick blink as it starts to listen and a double blink after; one blink a while after it stops.
    if (mood === 'listening' || this.mood === 'listening') this.queueBlinks(listenBlinks(this.time, mood === 'listening'))
    this.mood = mood
    this.moodChanged = true
    if (this.character?.prop) this.character.prop.visible = true
    this.expression = null
    this.redrawFallback()
  }

  setSize(size: number): void {
    if (size === this.size) return
    this.size = size
    this.applySize()
    this.redrawFallback()
  }

  setFraming(mode: CompanionFraming): void {
    if (mode === this.framingMode) return
    this.framingMode = mode
    this.applySize()
  }

  /** Looks at a viewport point until the mouse moves a few pixels; null looks back at the pointer. */
  setLookTarget(target: LookTarget | null): void {
    this.lookTarget = target
    this.lookTargetPointer = target ? this.pointerClient : null
  }

  /** Long idle: 'looking' lets the gaze wander; a nap comes through the mood. */
  setIdle(stage: IdleStage): void {
    this.idle = stage
  }

  /** A streamed chunk of speech. */
  talk(): void {
    this.talkEnergy = 1
  }

  /** Stroked on the head: squinting eyes, a blush and a little shimmy. */
  pat(): void {
    this.expression = { face: { eyes: 'happy', brows: 'raised', mouth: 'happy' }, until: this.time + PAT_SECONDS }
    this.patUntil = this.time + PAT_SECONDS
  }

  /** A companion was added: a wave and a ring of sparkles (wave and sparkles skipped under reduced motion). */
  celebrate(): void {
    if (!this.animator) {
      this.pendingGreet = true
      return
    }
    this.playOneShot('wave', { eyes: 'happy', brows: 'raised', mouth: 'happy' }, CELEBRATE_SECONDS)
    if (this.reducedMotion || !this.sparkles || !this.framingTarget || !this.character) return
    const center = new THREE.Vector3(0, this.framingTarget.targetY, 0)
    this.sparkles.ring(center, this.framingTarget.span * 0.42)
  }

  greet(): void {
    if (!this.animator) {
      this.pendingGreet = true
      return
    }
    this.pendingGreet = false
    this.playOneShot('wave', { eyes: 'happy', brows: 'raised', mouth: 'happy' }, 1.2)
  }

  poke(): void {
    this.playOneShot('poke', { eyes: 'wide', brows: 'raised', mouth: 'o' }, 0.45)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopLoop()
    if (this.restoreTimer) clearTimeout(this.restoreTimer)
    this.restoreTimer = null
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.dispose3d()
    this.fallbackCanvas?.remove()
    this.fallbackCanvas = null
  }

  // ---- setup ----

  private createRenderer(): void {
    const canvas = document.createElement('canvas')
    // Hidden behind a fallback that is showing until a character is installed.
    canvas.style.display = this.fallbackCanvas ? 'none' : 'block'
    try {
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
      renderer.setClearColor(0x000000, 0)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      this.canvas = canvas
      this.renderer = renderer
      this.stage = new Stage()
      if (!this.shadowOn) this.stage.showShadow(false)
      this.host.appendChild(canvas)
      this.applySize()
      const lost = (): void => {
        reportCompanionError('WebGL context lost')
        this.dispose3d(false)
        if (this.disposed) return
        const look = this.look ?? normalizeLook(this.requestedLook, this.assets?.compatibility ?? {})
        void this.showFallback(look, this.assets)
        if (performance.now() - this.restoredAt > RESTORE_RESET_MS) this.restores = 0
        this.scheduleRestore()
      }
      canvas.addEventListener('webglcontextlost', lost)
      this.cleanups.push(() => canvas.removeEventListener('webglcontextlost', lost))
    } catch (error) {
      reportCompanionError(`WebGL unavailable: ${message(error)}`)
      this.renderer = null
    }
  }

  /**
   * The lost renderer is gone for good (three removes its restore handling
   * on dispose), so a GPU reset gets a new canvas and context after a pause.
   * Attempts are capped, so contexts that keep getting dropped (too many
   * open at once) do not churn forever.
   */
  private scheduleRestore(): void {
    if (this.disposed || this.restoreTimer || this.restores >= MAX_RESTORES) return
    const delay = RESTORE_MS * 2 ** this.restores
    this.restores += 1
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null
      if (this.disposed || this.renderer) return
      this.createRenderer()
      if (!this.renderer) {
        this.scheduleRestore()
        return
      }
      this.restoredAt = performance.now()
      this.retryLook()
    }, delay)
  }

  /** Builds the last requested look again, even if it has not changed. */
  private retryLook(): void {
    const look = this.requestedLook
    this.requested = ''
    if (look) void this.setLook(look)
  }

  private watchEnvironment(): void {
    // The system setting or Atelier's own (ui/motion.ts mirrors both on <html data-motion>).
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    const onMotion = (): void => {
      this.reducedMotion = query.matches || document.documentElement.dataset.motion === 'reduced'
      if (!this.animator) return
      // Clips hold still under Reduce Motion: no bob or sway, and a one-shot in progress ends.
      this.animator.timeScale = this.reducedMotion ? 0 : 1
      if (this.reducedMotion) {
        this.animator.cancelOneShot()
        this.animator.setMood(this.mood, 0)
      }
    }
    onMotion()
    query.addEventListener('change', onMotion)
    const motionSetting = new MutationObserver(onMotion)
    motionSetting.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
    this.cleanups.push(() => {
      query.removeEventListener('change', onMotion)
      motionSetting.disconnect()
    })

    const onPointer = (event: PointerEvent): void => {
      const rect = this.host.getBoundingClientRect()
      const reach = Math.max(rect.width * 2, 240)
      this.pointer = {
        x: Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / reach)),
        y: Math.max(-1, Math.min(1, -(event.clientY - (rect.top + rect.height / 2)) / reach)),
      }
      this.pointerAt = performance.now()
      this.pointerClient = { x: event.clientX, y: event.clientY }
      const from = this.lookTargetPointer
      if (this.lookTarget && (!from || Math.hypot(event.clientX - from.x, event.clientY - from.y) > HAND_BACK_PX)) {
        if (from) this.lookTarget = null
        else this.lookTargetPointer = this.pointerClient
      }
    }
    const onLeave = (): void => {
      this.pointerAt = 0
    }
    window.addEventListener('pointermove', onPointer, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    this.cleanups.push(() => {
      window.removeEventListener('pointermove', onPointer)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    })

    const onVisibility = (): void => this.updateLoop()
    document.addEventListener('visibilitychange', onVisibility)
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))

    // The editor's "Try again" reloads the assets; a view that fell back
    // because they failed then builds its look.
    this.cleanups.push(onCompanionAssetsLoaded(() => {
      if (!this.retryOnAssets) return
      this.retryOnAssets = false
      this.retryLook()
    }))

    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1]
        this.onScreen = entry ? entry.isIntersecting : true
        this.updateLoop()
      })
      observer.observe(this.host)
      this.cleanups.push(() => observer.disconnect())
    }
  }

  private targetFraming(character: Character): Framing {
    // Live views keep the body; 'face' frames head and shoulders, so turns never clip an ear or hat.
    return resolveFraming(this.framingMode, this.size) === 'full' ? frameBounds(character.bounds) : framePortrait(character.bounds, character.headBounds)
  }

  private ready(): void {
    if (this.readyFired) return
    this.readyFired = true
    this.onReady?.()
  }

  private applySize(): void {
    const { size } = this
    // Crossing the portrait size changes the framing; the camera glides there.
    if (this.character) this.framingTarget = this.targetFraming(this.character)
    if (this.canvas) {
      this.canvas.style.width = `${size}px`
      this.canvas.style.height = `${size}px`
    }
    if (this.renderer) {
      this.renderer.setPixelRatio(pixelRatio())
      this.renderer.setSize(size, size, false)
    }
    this.updateOutline()
  }

  private updateOutline(): void {
    if (!this.character || !this.framingTarget) return
    this.character.setOutlineThickness(outlinePixels(this.size) * worldPerPixel(this.framingTarget, this.size))
  }

  private install(character: Character, look: CompanionLook, assets: CompanionAssets): void {
    const stage = this.stage as Stage
    const previous = this.character
    this.animator?.dispose()
    previous?.dispose()

    this.character = character
    this.look = look
    stage.scene.add(character.root)
    if (!this.sparkles) {
      this.sparkles = new Sparkles(look.colors.accent)
      stage.scene.add(this.sparkles.group)
    } else {
      this.sparkles.setAccent(look.colors.accent)
    }

    this.animator = new Animator(character.rig, character.clips, assets.animationEvents)
    this.animator.timeScale = this.reducedMotion ? 0 : 1
    this.animator.setMood(this.mood, 0)
    this.moodChanged = false
    this.pendingOneShot = null
    this.restHead.copy(character.headPivot?.quaternion ?? new THREE.Quaternion())
    this.restBody.copy(character.body?.scale ?? new THREE.Vector3(1, 1, 1))

    const target = this.targetFraming(character)
    this.framingTarget = target
    // A first build snaps the camera; a new look in the editor glides to its framing.
    if (!previous || !this.framing) {
      this.framing = { ...target }
      stage.frame(target)
    }
    stage.fitShadow(character.bounds)
    this.updateOutline()

    this.hideFallback()
    if (this.pendingGreet) this.greet()
    this.updateLoop()
  }

  private dispose3d(loseContext = true): void {
    this.animator?.dispose()
    this.animator = null
    this.character?.dispose()
    this.character = null
    this.sparkles?.dispose()
    this.sparkles = null
    this.compositor?.dispose()
    this.compositor = null
    this.stage?.dispose()
    this.stage = null
    if (this.renderer) {
      this.renderer.dispose()
      if (loseContext) this.renderer.forceContextLoss()
      this.renderer = null
    }
    this.canvas?.remove()
    this.canvas = null
    this.stopLoop()
  }

  // ---- fallback ----

  private async showFallback(look: CompanionLook, assets: CompanionAssets | null): Promise<void> {
    this.fallbackLook = look
    if (!this.fallbackCanvas) {
      const canvas = document.createElement('canvas')
      canvas.style.display = 'block'
      this.fallbackCanvas = canvas
      this.host.appendChild(canvas)
    }
    if (this.canvas) this.canvas.style.display = 'none'
    this.redrawFallback()
    this.ready()
    const face = await loadFallbackFace(assets ? { defs: assets.manifest.face, pupils: assets.pupils } : null, look.face)
    if (this.disposed || this.fallbackLook !== look) return
    this.fallbackFace = face
    this.redrawFallback()
  }

  private hideFallback(): void {
    if (!this.fallbackCanvas) return
    this.fallbackCanvas.remove()
    this.fallbackCanvas = null
    this.fallbackFace = null
    this.fallbackLook = null
    if (this.canvas) this.canvas.style.display = 'block'
  }

  private redrawFallback(): void {
    const canvas = this.fallbackCanvas
    const look = this.fallbackLook
    if (!canvas || !look) return
    canvas.style.width = `${this.size}px`
    canvas.style.height = `${this.size}px`
    const face = this.fallbackFace ?? { source: null, images: new Map() }
    drawFallback(canvas, this.size, pixelRatio(), look, resolveFace({ mood: this.mood }), face, MOOD_CHEEKS[this.mood])
  }

  // ---- behaviour ----

  private queueBlinks(times: number[]): void {
    this.blinks = [...this.blinks, ...times].sort((a, b) => a - b)
  }

  private playOneShot(id: ClipId, face: Partial<FaceState>, seconds: number): void {
    if (!this.animator) return
    this.expression = { face, until: this.time + seconds }
    if (this.reducedMotion && REDUCED_MOTION_SKIP.includes(id)) return
    this.pendingOneShot = id
  }

  private handleEvent(event: AnimationEvent): void {
    switch (event.type) {
      case 'blink':
        this.blinkUntil = this.time + BLINK_SECONDS
        break
      case 'expression':
        this.expression = { face: event.face, until: this.time + event.duration }
        break
      case 'prop':
        if (this.character?.prop) this.character.prop.visible = event.visible
        break
      case 'sparkle': {
        const head = this.character?.headPivot
        if (!head || !this.sparkles || !this.framingTarget) break
        const center = head.getWorldPosition(new THREE.Vector3())
        center.y += this.framingTarget.span * 0.12
        this.sparkles.burst(center, this.framingTarget.span * 0.32)
        break
      }
      case 'squash':
        this.squashes.push({ start: this.time, amount: event.amount * (this.reducedMotion ? 0.3 : 1) })
        break
    }
  }

  // ---- loop ----

  private updateLoop(): void {
    const run = !this.disposed && this.onScreen && !document.hidden && this.renderer !== null && this.character !== null
    if (run && !this.frameId) {
      this.last = performance.now()
      this.frameId = requestAnimationFrame(this.tick)
    } else if (!run) {
      this.stopLoop()
    }
  }

  private stopLoop(): void {
    if (this.frameId) cancelAnimationFrame(this.frameId)
    this.frameId = 0
  }

  private readonly tick = (now: number): void => {
    this.frameId = requestAnimationFrame(this.tick)
    // Small companions do not need 60 fps.
    const interval = this.size < 72 ? 1000 / 30 - 2 : 0
    if (now - this.last < interval) return
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000))
    this.last = now
    try {
      this.step(dt, now)
    } catch (error) {
      reportCompanionError(`frame: ${message(error)}`)
      this.stopLoop()
    }
  }

  private step(dt: number, now: number): void {
    const { renderer, stage, character, animator, compositor } = this
    if (!renderer || !stage || !character || !animator) return
    this.time += dt
    const { time, mood } = this

    // Snap blinks (allowed under Reduce Motion) and talk energy.
    if (this.blinks.length > 0 && time >= (this.blinks[0] as number)) {
      this.blinks.shift()
      this.blinkUntil = time + BLINK_SECONDS
      if (this.blinks.length === 0) this.blinks = idleBlinks(time, Math.random)
    }
    this.talkEnergy = decayTalk(this.talkEnergy, dt)

    // Nodes adjusted after the mixer go back to rest first, so the offsets never accumulate.
    character.headPivot?.quaternion.copy(this.restHead)
    character.body?.scale.copy(this.restBody)
    if (this.moodChanged) {
      this.moodChanged = false
      // Under Reduce Motion the held pose changes at once.
      animator.setMood(mood, this.reducedMotion ? 0 : undefined)
    }
    if (this.pendingOneShot) {
      animator.playOneShot(this.pendingOneShot)
      this.pendingOneShot = null
    }
    for (const event of animator.update(dt)) this.handleEvent(event)

    // Gaze: pupils and a little head turn, after the mixer.
    const target = moodGaze(mood, this.gazeSource(now, time))
    const k = gazeStep(dt, this.reducedMotion)
    this.gaze = { x: this.gaze.x + (target.x - this.gaze.x) * k, y: this.gaze.y + (target.y - this.gaze.y) * k }
    // Under Reduce Motion only the pupils move; the head holds still.
    const turn = this.reducedMotion ? 0 : 1
    if (character.headPivot) {
      // A pat adds a quick side-to-side shimmy that fades out.
      const patLeft = this.patUntil - time
      const shimmy = patLeft > 0 && !this.reducedMotion ? Math.sin(time * 26) * 0.09 * (patLeft / PAT_SECONDS) : 0
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.gaze.y * 0.14 * turn, this.gaze.x * 0.22 * turn, shimmy))
      character.headPivot.quaternion.multiply(q)
    }

    // Squash cues.
    this.squashes = this.squashes.filter((s) => time - s.start < SQUASH_SECONDS)
    if (character.body && this.squashes.length > 0) {
      const amount = this.squashes.reduce((sum, s) => sum + s.amount * Math.sin((Math.PI * (time - s.start)) / SQUASH_SECONDS), 0)
      character.body.scale.multiply(new THREE.Vector3(1 + amount * 0.5, 1 - amount, 1 + amount * 0.5))
    }

    // Face.
    if (compositor) {
      const expression = this.expression && time < this.expression.until ? this.expression.face : null
      if (!expression) this.expression = null
      const face = resolveFace({ mood, expression, talk: this.talkEnergy, time, blinking: time < this.blinkUntil })
      const blush = time < this.patUntil ? 1 : MOOD_CHEEKS[mood]
      compositor.update(face, this.gaze, blush)
    }

    this.sparkles?.update(dt)
    stage.lift(character.rigRoot?.position.y ?? 0)
    // The breathing bob, about a pixel, on top of the clip.
    if (this.framingTarget) character.root.position.y = bobPixels(time, this.reducedMotion) * worldPerPixel(this.framingTarget, this.size)

    // Glide to a new look's framing.
    if (this.framing && this.framingTarget) {
      const f = this.framing
      const t = this.framingTarget
      const g = 1 - Math.exp(-dt * 8)
      f.targetY += (t.targetY - f.targetY) * g
      f.distance += (t.distance - f.distance) * g
      f.span += (t.span - f.span) * g
      stage.frame(f)
    }

    renderer.render(stage.scene, stage.camera)
    if (!this.reportedReady) {
      this.reportedReady = true
      reportCompanionReady()
    }
    this.ready()
  }

  /**
   * What the eyes follow: a look target (the caret), the pointer anywhere in
   * the window, a wandering look when long idle, the pointer's last
   * direction once it rests, or else a held sideways glance that shifts now
   * and then. Reduce Motion drops pointer tracking.
   */
  private gazeSource(now: number, time: number): Gaze {
    if (this.lookTarget) return this.toGaze(this.lookTarget)
    const pointed = this.pointerAt > 0 && !this.reducedMotion
    if (pointed && now - this.pointerAt < POINTER_REST_MS) return this.pointer
    if (this.idle === 'looking' && !this.reducedMotion) {
      if (now >= this.nextWander) {
        this.wander = { x: (Math.random() * 2 - 1) * 0.8, y: Math.random() * 0.8 - 0.3 }
        this.nextWander = now + 1800 + Math.random() * 1700
      }
      return this.wander
    }
    if (pointed) return this.pointer
    if (!this.glance || time >= this.glanceUntil) {
      const next = nextGlance(this.glance, Math.random)
      this.glance = next.gaze
      this.glanceUntil = time + next.holdFor
    }
    return this.glance
  }

  private toGaze(point: LookTarget): Gaze {
    const rect = this.host.getBoundingClientRect()
    const reach = Math.max(rect.width * 2, 240)
    return {
      x: Math.max(-1, Math.min(1, (point.x - (rect.left + rect.width / 2)) / reach)),
      y: Math.max(-1, Math.min(1, -(point.y - (rect.top + rect.height / 2)) / reach)),
    }
  }
}
