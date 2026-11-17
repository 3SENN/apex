/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex-kit/character.js (docs/apps.md › The kit): a companion in an app's own
// three.js scene, built by the same runtime that draws companions in the
// chrome (src/renderer/src/companion), so a companion looks the same in
// every app. The app adds `object3d` to its scene, calls `update(dt)` each
// frame, `setMood` when the moment changes and `move` while it walks or runs
// the companion around; `dispose` frees it.
import type * as THREE from 'three'
import { CLIPS, type CompanionLook, type CompanionMood } from '@shared/companion'
import { moodGaze, normalizeLook, resolveFace } from '@shared/companionLogic'
import { Animator } from '../renderer/src/companion/animator'
import { loadCompanionAssets } from '../renderer/src/companion/assets'
import { buildCharacter } from '../renderer/src/companion/character'
import { FaceCompositor } from '../renderer/src/companion/face'
import { MOOD_CHEEKS, type Bounds } from '../renderer/src/companion/layout'
import { MOTIONS, gaitRate, type Motion } from '../renderer/src/companion/locomotion'

export interface KitCharacter {
  /** Add this to the scene; +Y is up and 1 unit is about the height of rig A's body. */
  object3d: THREE.Group
  /** Rest-pose bounds, for placing and framing: min and max as [x, y, z]. */
  bounds: Bounds
  /** The clip and face for a mood: idle, listening, thinking, working, talking, happy, sad, sleeping and more. */
  setMood(mood: CompanionMood, fade?: number): void
  /**
   * Walks or runs while the app moves `object3d` (the face keeps the mood), or
   * with null stands again. `speed` is how fast it moves, in scene units a
   * second, so the steps keep up with the ground; turn `object3d` to face the
   * way it goes.
   */
  move(motion: Motion | null, speed?: number): void
  /** Advance the animation; call it every frame with the seconds since the last. */
  update(dt: number): void
  /** Blink once (the app decides when; every few seconds looks alive). */
  blink(): void
  dispose(): void
}

/** The clips a companion's rigs carry (docs/companion-system.md), and the walk and run every companion has. */
export const clips: readonly string[] = [...CLIPS, ...MOTIONS]

/** Builds a companion from a look (what apex.cast gives an app, or a look a friend's game sent). */
export async function character(look: CompanionLook, options: { mood?: CompanionMood } = {}): Promise<KitCharacter> {
  const assets = await loadCompanionAssets()
  const normal = normalizeLook(look, assets.compatibility)
  const face = new FaceCompositor({ defs: assets.manifest.face, pupils: assets.pupils })
  await face.setLook(normal.face, normal.colors.skin, normal.adjust)
  let mood: CompanionMood = options.mood ?? 'idle'
  let blinkUntil = 0
  let clock = 0
  const paint = (): void => {
    face.update(resolveFace({ mood, blinking: clock < blinkUntil }), moodGaze(mood, { x: 0, y: 0 }), MOOD_CHEEKS[mood])
  }
  paint()
  const built = await buildCharacter(normal, assets, face.texture)
  const animator = new Animator(built.rig, built.clips, assets.animationEvents)
  animator.setMood(mood, 0)
  animator.update(0)
  return {
    object3d: built.root,
    bounds: built.bounds,
    setMood(next, fade) {
      mood = next
      animator.setMood(next, fade)
      paint()
    },
    move(motion, speed) {
      // Rig units are the companion's own size, so a scaled companion takes longer steps.
      const scale = built.root.scale.x || 1
      animator.setMoving(motion, { rate: motion ? gaitRate(motion, (speed ?? 0) / scale || 0.0001) : 1 })
    },
    update(dt) {
      const wasBlinking = clock < blinkUntil
      clock += dt
      animator.update(dt)
      if (wasBlinking && clock >= blinkUntil) paint()
    },
    blink() {
      blinkUntil = clock + 0.15
      paint()
    },
    dispose() {
      animator.dispose()
      built.dispose()
      face.dispose()
    },
  }
}
