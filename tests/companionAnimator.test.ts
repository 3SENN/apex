/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { ClipId } from '../src/shared/companion'
import { Animator } from '../src/renderer/src/companion/animator'
import { GAITS, gaitPace, gaitRate, motionClips } from '../src/renderer/src/companion/locomotion'

const FRAME = 1 / 60

// Each clip moves the body along x by `x0 + speed * t`, so the blended x
// shows both the weights and where each clip is in its time.
function setup(): { body: THREE.Object3D; animator: Animator } {
  const root = new THREE.Object3D()
  const body = new THREE.Object3D()
  body.name = 'body'
  root.add(body)
  const clip = (id: ClipId, x0: number, speed = 0, duration = 2): THREE.AnimationClip =>
    new THREE.AnimationClip(id, duration, [new THREE.VectorKeyframeTrack('body.position', [0, duration], [x0, 0, 0, x0 + speed * duration, 0, 0])])
  const clips = new Map([clip('idle', 0, 1), clip('think', 4), clip('work', 8), clip('poke', 12, 0, 1)].map((c) => [c.name, c] as const))
  return { body, animator: new Animator(root, clips, {}) }
}

/** Runs frames and returns the largest jump of the body between two of them. */
function run(animator: Animator, body: THREE.Object3D, seconds: number): number {
  let jump = 0
  for (let t = 0; t < seconds - 1e-9; t += FRAME) {
    const before = body.position.x
    animator.update(FRAME)
    jump = Math.max(jump, Math.abs(body.position.x - before))
  }
  return jump
}

describe('companion animator', () => {
  // A full 0.25 s crossfade between clips 4 apart moves at most 4 / 15 per frame.
  const smooth = 4 / 15 + 0.05

  it('crossfades from the current weights when the mood changes mid-fade', () => {
    const { body, animator } = setup()
    animator.setMood('idle', 0)
    run(animator, body, 0.5)
    animator.setMood('thinking')
    let jump = run(animator, body, 0.1)
    animator.setMood('working')
    jump = Math.max(jump, run(animator, body, 0.6))
    expect(jump).toBeLessThan(smooth * 2)
    expect(body.position.x).toBeCloseTo(8)
  })

  it('lets a clip that is still fading out carry on instead of restarting', () => {
    const { body, animator } = setup()
    animator.setMood('idle', 0)
    run(animator, body, 1)
    animator.setMood('thinking')
    run(animator, body, 0.1)
    animator.setMood('idle')
    // Restarting idle would drop its share of the pose back to x = 0.
    expect(run(animator, body, 0.6)).toBeLessThan(smooth)
    expect(body.position.x).toBeGreaterThan(1.5)
  })

  it('fades a one-shot in over a fade and back to the mood loop when it ends', () => {
    const { body, animator } = setup()
    animator.setMood('thinking', 0)
    run(animator, body, 0.1)
    animator.setMood('working')
    run(animator, body, 0.1)
    expect(animator.playOneShot('poke')).toBe(true)
    expect(run(animator, body, 0.6)).toBeLessThan(smooth * 2)
    expect(animator.playing).toBe('poke')
    run(animator, body, 1)
    expect(animator.playing).toBe('work')
    expect(body.position.x).toBeCloseTo(8)
  })
})

describe('walking and running', () => {
  /** A rig with the seven nodes every companion rig has, posed like rig A's rest. */
  function rig(): THREE.Object3D {
    const root = new THREE.Object3D()
    root.name = THREE.PropertyBinding.sanitizeNodeName('root')
    const node = (name: string, parent: THREE.Object3D, at: [number, number, number]): THREE.Object3D => {
      const n = new THREE.Object3D()
      n.name = THREE.PropertyBinding.sanitizeNodeName(name)
      n.position.set(...at)
      parent.add(n)
      return n
    }
    const body = node('body', root, [0, 0.08, 0])
    node('head-pivot', body, [0, 0.9, 0.02])
    node('arm.L', body, [0.44, 0.6, 0])
    node('arm.R', body, [-0.44, 0.6, 0])
    node('foot.L', root, [0.21, 0.08, 0.06])
    node('foot.R', root, [-0.21, 0.08, 0.06])
    const top = new THREE.Group()
    top.add(root)
    return top
  }

  it('builds a seamless walk and run for any rig, once, over every channel the rigs animate', () => {
    const template = rig()
    const clips = motionClips(template)
    expect([...clips.keys()]).toEqual(['walk', 'run'])
    expect(motionClips(template)).toBe(clips)
    for (const [motion, clip] of clips) {
      expect(clip.duration).toBeCloseTo(GAITS[motion].cycle)
      expect(clip.tracks).toHaveLength(21)
      for (const track of clip.tracks) {
        const size = track.getValueSize()
        const first = Array.from(track.values.slice(0, size))
        const last = Array.from(track.values.slice(-size))
        for (let i = 0; i < size; i++) expect(last[i]).toBeCloseTo(first[i]!, 6)
      }
    }
    // The template itself is never moved.
    expect(template.getObjectByName('footL')!.position.toArray()).toEqual([0.21, 0.08, 0.06])
    // A rig without feet gets no walk.
    expect(motionClips(new THREE.Group()).size).toBe(0)
  })

  it('keeps the feet with the ground, within what still looks like walking', () => {
    expect(gaitRate('walk', gaitPace('walk'))).toBeCloseTo(1)
    expect(gaitRate('run', gaitPace('run') * 1.5)).toBeCloseTo(1.5)
    expect(gaitRate('walk', 100)).toBe(2.2)
    expect(gaitRate('walk', 0)).toBe(0.5)
  })

  it('walks over the mood, keeps a mood change for when it stops, and holds one-shots back', () => {
    const template = rig()
    const character = template.clone(true)
    const idle = new THREE.AnimationClip('idle', 2, [new THREE.VectorKeyframeTrack('body.position', [0, 2], [0, 0.08, 0, 0, 0.08, 0])])
    const think = new THREE.AnimationClip('think', 2, [new THREE.VectorKeyframeTrack('body.position', [0, 2], [0, 0.08, 0, 0, 0.08, 0])])
    const wave = new THREE.AnimationClip('wave', 1, [new THREE.VectorKeyframeTrack('body.position', [0, 1], [0, 0.08, 0, 0, 0.08, 0])])
    const clips = new Map<string, THREE.AnimationClip>([['idle', idle], ['think', think], ['wave', wave], ...motionClips(template)])
    const animator = new Animator(character, clips, {})
    const foot = character.getObjectByName('footL')!
    animator.setMood('idle', 0)
    animator.update(FRAME)
    animator.setMoving('walk')
    expect(animator.playing).toBe('walk')
    for (let i = 0; i < 30; i++) animator.update(FRAME)
    expect(Math.abs(foot.position.z - 0.06)).toBeGreaterThan(0.02)
    expect(animator.playOneShot('wave')).toBe(false)
    animator.setMood('thinking')
    expect(animator.playing).toBe('walk')
    animator.setMoving('run', { rate: 1.5 })
    expect(animator.playing).toBe('run')
    animator.setMoving(null)
    expect(animator.playing).toBe('think')
    for (let i = 0; i < 30; i++) animator.update(FRAME)
    expect(foot.position.z).toBeCloseTo(0.06, 2)
    animator.dispose()
  })
})
