/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import { RIG_NODES } from '@shared/companion'

// Walking and running, as clips. It moves only the nodes every rig has
// (feet, arms, body, head pivot), so one cycle fits all three rigs and every
// look, and it is built once per rig from the rig's rest pose: a few
// kilobytes of keys, nothing to download. It covers all 21 channels the rigs'
// own clips animate (each node's position, rotation and scale), so it
// crossfades with them without leaving a node half-posed.

export const MOTIONS = ['walk', 'run'] as const
export type Motion = (typeof MOTIONS)[number]

interface Gait {
  /** Seconds per cycle: two steps. */
  cycle: number
  /** How far each foot reaches forward and back, in rig units. */
  stride: number
  lift: number
  /** How far the toes roll at push-off and heel strike (radians). */
  toe: number
  bob: number
  lean: number
  twist: number
  roll: number
  arm: number
  nod: number
}

export const GAITS: Readonly<Record<Motion, Gait>> = {
  walk: { cycle: 0.62, stride: 0.16, lift: 0.13, toe: 0.45, bob: 0.055, lean: 0.08, twist: 0.2, roll: 0.1, arm: 0.95, nod: 0.04 },
  run: { cycle: 0.42, stride: 0.22, lift: 0.22, toe: 0.55, bob: 0.1, lean: 0.2, twist: 0.24, roll: 0.08, arm: 1.25, nod: 0.06 },
}

/** Ground a gait covers per second at time scale 1, in rig units: two steps of twice the stride each cycle. */
export function gaitPace(motion: Motion): number {
  const g = GAITS[motion]
  return (4 * g.stride) / g.cycle
}

/**
 * The time scale that keeps the feet with the ground at `speed` rig units a
 * second. Kept between half and a bit over twice the gait's own pace, where it
 * still reads as walking; past that the feet slide a little instead.
 */
export function gaitRate(motion: Motion, speed: number): number {
  return Math.min(2.2, Math.max(0.5, speed / gaitPace(motion)))
}

/** Keys per cycle; the loop's last key repeats the first. */
const KEYS = 16

const built = new WeakMap<THREE.Object3D, ReadonlyMap<Motion, THREE.AnimationClip>>()

/**
 * Walk and run clips for a rig, posed from `template`, the loaded model's
 * scene (characters animate clones of it, so it stays at rest). Empty when the
 * rig lacks one of the nodes.
 */
export function motionClips(template: THREE.Object3D): ReadonlyMap<Motion, THREE.AnimationClip> {
  const hit = built.get(template)
  if (hit) return hit
  const nodes = RIG_NODES.map((name) => template.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)))
  const clips = new Map<Motion, THREE.AnimationClip>()
  if (nodes.every((n): n is THREE.Object3D => n !== undefined)) {
    const byName = new Map(RIG_NODES.map((name, i) => [name, nodes[i] as THREE.Object3D]))
    for (const motion of MOTIONS) clips.set(motion, cycleClip(motion, byName))
  }
  built.set(template, clips)
  return clips
}

const euler = new THREE.Euler()
const turn = new THREE.Quaternion()

function cycleClip(motion: Motion, nodes: ReadonlyMap<string, THREE.Object3D>): THREE.AnimationClip {
  const g = GAITS[motion]
  const times = new Float32Array(KEYS + 1)
  const keys = new Map<string, { position: Float32Array; quaternion: Float32Array; scale: Float32Array }>()
  for (const name of nodes.keys()) keys.set(name, { position: new Float32Array((KEYS + 1) * 3), quaternion: new Float32Array((KEYS + 1) * 4), scale: new Float32Array((KEYS + 1) * 3) })

  const offset = new THREE.Vector3()
  const pose = new THREE.Quaternion()
  for (let k = 0; k <= KEYS; k++) {
    times[k] = (k / KEYS) * g.cycle
    const phi = ((k % KEYS) / KEYS) * Math.PI * 2
    const s = Math.sin(phi)
    const c = Math.cos(phi)
    // The left foot swings forward while c > 0, the right while c < 0; toes roll down leaving the ground and up landing.
    const moves: Record<string, { at: [number, number, number]; rot: [number, number, number] }> = {
      'foot.L': { at: [0, g.lift * Math.max(0, c), g.stride * s], rot: [-g.toe * 1.6 * s * Math.max(0, c), 0, 0] },
      'foot.R': { at: [0, g.lift * Math.max(0, -c), -g.stride * s], rot: [g.toe * 1.6 * s * Math.max(0, -c), 0, 0] },
      body: { at: [0, g.bob * c * c, 0], rot: [g.lean, g.twist * s, g.roll * c] },
      'arm.L': { at: [0, 0, 0], rot: [g.arm * s, 0, 0] },
      'arm.R': { at: [0, 0, 0], rot: [-g.arm * s, 0, 0] },
      'head-pivot': { at: [0, 0, 0], rot: [g.nod * Math.cos(phi * 2), -g.twist * s * 0.6, -g.roll * c * 0.6] },
    }
    for (const [name, node] of nodes) {
      const move = moves[name]
      const out = keys.get(name)!
      offset.set(...(move?.at ?? [0, 0, 0])).add(node.position)
      offset.toArray(out.position, k * 3)
      pose.copy(node.quaternion)
      if (move) pose.multiply(turn.setFromEuler(euler.set(...move.rot)))
      pose.toArray(out.quaternion, k * 4)
      node.scale.toArray(out.scale, k * 3)
    }
  }

  const tracks: THREE.KeyframeTrack[] = []
  for (const [name, values] of keys) {
    const target = nodes.get(name)!.name
    tracks.push(new THREE.VectorKeyframeTrack(`${target}.position`, times, values.position))
    tracks.push(new THREE.QuaternionKeyframeTrack(`${target}.quaternion`, times, values.quaternion))
    tracks.push(new THREE.VectorKeyframeTrack(`${target}.scale`, times, values.scale))
  }
  return new THREE.AnimationClip(motion, g.cycle, tracks)
}
