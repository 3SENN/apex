/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import { MOOD_CLIP, type AnimationEvent, type AnimationEventsConfig, type ClipId, type CompanionMood } from '@shared/companion'
import { dueEvents } from '@shared/companionLogic'
import type { Motion } from './locomotion'

export const MOOD_FADE = 0.25
const ONE_SHOT_FADE = 0.2
/** Into and out of a walk or run: quick, so the feet start as the companion does. */
export const MOVE_FADE = 0.15

interface Playing {
  id: ClipId | Motion
  action: THREE.AnimationAction
}

interface Ramp {
  from: number
  to: number
  elapsed: number
  duration: number
}

/**
 * Loops the mood's clip with crossfades, plays one-shots over it and reports
 * the animation events the playing clip crossed each frame. While the
 * companion moves, a walk or run (locomotion.ts) takes the mood clip's place;
 * the face keeps the mood.
 */
export class Animator {
  readonly mixer: THREE.AnimationMixer
  private base: Playing | null = null
  private moving: Playing | null = null
  private oneShot: Playing | null = null
  private oneShotDone = false
  /** Clip time of the clip whose events we track; negative right after it starts. */
  private prevTime = -1
  /**
   * Crossfades run here rather than with three's fadeIn/fadeOut, which always
   * ramp between 0 and 1: a mood change in the middle of a fade must start
   * from each action's current weight, or the pose jumps.
   */
  private readonly ramps = new Map<THREE.AnimationAction, Ramp>()
  /** Actions started here that may still contribute to the pose. */
  private readonly active = new Set<THREE.AnimationAction>()

  constructor(
    private readonly root: THREE.Object3D,
    private readonly clips: ReadonlyMap<string, THREE.AnimationClip>,
    private readonly events: Partial<AnimationEventsConfig>,
  ) {
    this.mixer = new THREE.AnimationMixer(root)
    this.mixer.addEventListener('finished', (event) => {
      // Switching actions inside the mixer's own update loop is unsafe; finish after it.
      if (this.oneShot && event.action === this.oneShot.action) this.oneShotDone = true
    })
  }

  set timeScale(value: number) {
    this.mixer.timeScale = value
  }

  get playing(): ClipId | Motion | null {
    return (this.oneShot ?? this.moving ?? this.base)?.id ?? null
  }

  private action(id: ClipId | Motion, loop: boolean): Playing | null {
    const clip = this.clips.get(id)
    if (!clip) return null
    const action = this.mixer.clipAction(clip)
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    action.clampWhenFinished = !loop
    return { id, action }
  }

  private weightOf(action: THREE.AnimationAction): number {
    return this.active.has(action) && action.enabled ? action.getEffectiveWeight() : 0
  }

  private setWeight(action: THREE.AnimationAction, weight: number): void {
    if (weight > 0) {
      action.setEffectiveWeight(weight)
      return
    }
    this.ramps.delete(action)
    action.stop()
    this.active.delete(action)
  }

  /** Moves an action's weight from where it is now to `to` over `duration` seconds of clip time. */
  private ramp(action: THREE.AnimationAction, to: number, duration: number): void {
    const from = this.weightOf(action)
    if (duration <= 0 || from === to) {
      this.ramps.delete(action)
      this.setWeight(action, to)
    } else {
      this.ramps.set(action, { from, to, elapsed: 0, duration })
    }
  }

  /** Fades `next` in and everything else out. */
  private start(next: Playing, fade: number): void {
    const { action } = next
    // A clip that is still fading out carries on from where it is instead of restarting.
    const carryOn = this.weightOf(action) > 0
    if (!carryOn) {
      action.reset()
      action.setEffectiveWeight(0)
    }
    action.play()
    this.active.add(action)
    this.prevTime = carryOn ? action.time : -1
    this.ramp(action, 1, fade)
    for (const other of this.active) if (other !== action) this.ramp(other, 0, fade)
  }

  setMood(mood: CompanionMood, fade = MOOD_FADE): void {
    const id = MOOD_CLIP[mood]
    if (this.base?.id === id) return
    const next = this.action(id, true) ?? this.action('idle', true)
    if (!next || next.id === this.base?.id) return
    this.base = next
    // During a one-shot the new loop starts when it ends; while moving, when the companion stops.
    if (!this.oneShot && !this.moving) this.start(next, fade)
  }

  /**
   * Walks or runs (the face keeps the mood), or with null stops and goes back
   * to the mood's loop. `rate` is the clip's time scale, from gaitRate, so the
   * feet keep up with the ground; calling again with a new rate only changes it.
   */
  setMoving(motion: Motion | null, { fade = MOVE_FADE, rate = 1 }: { fade?: number; rate?: number } = {}): void {
    if (motion === null) {
      const stopping = this.moving
      if (!stopping) return
      this.moving = null
      if (this.base) this.start(this.base, fade)
      else this.ramp(stopping.action, 0, fade)
      return
    }
    if (this.moving?.id === motion) {
      this.moving.action.setEffectiveTimeScale(rate)
      return
    }
    const next = this.action(motion, true)
    if (!next) return
    // Setting off ends a wave or a poke: a one-shot doesn't walk.
    this.oneShot = null
    this.oneShotDone = false
    this.moving = next
    next.action.setEffectiveTimeScale(rate)
    this.start(next, fade)
  }

  /** Plays a clip once over the mood loop. Returns false when the rig lacks it, or while the companion walks or runs. */
  playOneShot(id: ClipId): boolean {
    if (this.moving) return false
    const next = this.action(id, false)
    if (!next) return false
    if (this.oneShot?.action === next.action) {
      next.action.reset()
      next.action.play()
      this.prevTime = -1
    } else {
      this.start(next, ONE_SHOT_FADE)
    }
    this.oneShot = next
    this.oneShotDone = false
    return true
  }

  /** Ends a playing one-shot at once and goes back to the mood loop (Reduce Motion turned on mid-wave). */
  cancelOneShot(): void {
    if (!this.oneShot) return
    this.oneShot = null
    this.oneShotDone = false
    const back = this.moving ?? this.base
    if (back) this.start(back, 0)
  }

  /** Advances the mixer and returns the events the tracked clip crossed. */
  update(dt: number): AnimationEvent[] {
    // Ramps follow the mixer's time scale, as clip time does.
    const step = dt * this.mixer.timeScale
    for (const [action, ramp] of this.ramps) {
      ramp.elapsed += step
      if (ramp.elapsed >= ramp.duration) {
        this.ramps.delete(action)
        this.setWeight(action, ramp.to)
      } else {
        action.setEffectiveWeight(ramp.from + ((ramp.to - ramp.from) * ramp.elapsed) / ramp.duration)
      }
    }
    const tracked = this.oneShot ?? this.moving ?? this.base
    this.mixer.update(dt)
    let due: AnimationEvent[] = []
    if (tracked) {
      const time = tracked.action.time
      // Walks and runs carry no events (props, sounds): those belong to the rigs' own clips.
      due = dueEvents(this.events[tracked.id as ClipId] ?? [], this.prevTime, time, tracked.action.getClip().duration)
      this.prevTime = time
    }
    if (this.oneShotDone && this.oneShot) {
      const finished = this.oneShot
      this.oneShot = null
      this.oneShotDone = false
      const back = this.moving ?? this.base
      if (back) this.start(back, MOOD_FADE)
      else this.ramp(finished.action, 0, MOOD_FADE)
    }
    return due
  }

  dispose(): void {
    this.ramps.clear()
    this.active.clear()
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.root)
  }
}
