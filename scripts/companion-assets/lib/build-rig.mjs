/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Writes a rig: the node hierarchy from the spec, the body/arm/foot meshes
// and one glTF animation per clip, sampled at 30 fps.

import { CLIP_DEFS } from './animations.mjs'
import { ONE_SHOT_CLIPS, RIG_NODES } from './catalogue.mjs'
import { GltfBuilder } from './gltf.mjs'
import { quatFromEuler } from './math.mjs'
import { restPose, rigMeshes } from './rigs.mjs'

const FPS = 30
const ONE_SHOTS = new Set(ONE_SHOT_CLIPS)

/** Samples a clip into per-node TRS keyframes. */
function sampleClip(rig, clipId) {
  const clip = CLIP_DEFS[clipId]
  const rest = restPose(rig)
  const frames = Math.round(clip.duration * FPS)
  const times = Array.from({ length: frames + 1 }, (_, i) => i / FPS)
  const tracks = {}
  for (const name of RIG_NODES) tracks[name] = { translation: [], rotation: [], scale: [] }
  for (let i = 0; i <= frames; i++) {
    const pose = clip.pose(i / frames, rig)
    for (const name of RIG_NODES) {
      const base = rest[name]
      const d = pose[name] ?? {}
      const t = d.t ? base.t.map((v, k) => v + d.t[k]) : base.t
      const e = d.r ?? base.r
      const s = d.s ? base.s.map((v, k) => v * d.s[k]) : base.s
      let q = quatFromEuler(e[0], e[1], e[2])
      const prev = tracks[name].rotation.slice(-4)
      if (prev.length === 4 && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v)
      tracks[name].translation.push(...t)
      tracks[name].rotation.push(...q)
      tracks[name].scale.push(...s)
    }
  }
  const out = []
  for (const name of RIG_NODES) {
    for (const path of ['translation', 'rotation', 'scale']) {
      const values = tracks[name][path]
      const stride = path === 'rotation' ? 4 : 3
      // Loops end exactly where they start.
      if (!ONE_SHOTS.has(clipId)) for (let k = 0; k < stride; k++) values[frames * stride + k] = values[k]
      const constant = values.every((v, idx) => Math.abs(v - values[idx % stride]) < 1e-6)
      if (constant) out.push({ node: name, path, times: [0, clip.duration], values: [...values.slice(0, stride), ...values.slice(0, stride)] })
      else out.push({ node: name, path, times, values })
    }
  }
  return { duration: clip.duration, tracks: out }
}

export function buildRig(rigId, rig, clipIds) {
  const b = new GltfBuilder(`rig-${rigId}`)
  const rest = restPose(rig)
  const meshes = rigMeshes(rig)
  const quat = (e) => quatFromEuler(e[0], e[1], e[2])
  const nodes = {}
  nodes.root = b.node('root', { t: rest.root.t })
  nodes.body = b.node('body', { t: rest.body.t }, nodes.root)
  nodes['head-pivot'] = b.node('head-pivot', { t: rest['head-pivot'].t }, nodes.body)
  b.node('anchor:head', rig.headScale !== 1 ? { s: rig.headScale } : {}, nodes['head-pivot'])
  for (const side of ['L', 'R']) {
    const arm = `arm.${side}`
    nodes[arm] = b.node(arm, { t: rest[arm].t, r: quat(rest[arm].r) }, nodes.body)
    b.mesh(`${arm}-mesh`, meshes[arm], nodes[arm])
  }
  // The prop anchor sits in the right mitten, counter-rotated so props stand upright at rest.
  b.node('anchor:prop', { t: [-rig.hand[0], rig.hand[1], rig.hand[2]], r: quat([0, 0, rig.armOut]) }, nodes['arm.R'])
  for (const side of ['L', 'R']) {
    const foot = `foot.${side}`
    nodes[foot] = b.node(foot, { t: rest[foot].t }, nodes.root)
    b.mesh(`${foot}-mesh`, meshes[foot], nodes[foot])
  }
  b.mesh('body-mesh', meshes.body, nodes.body)
  for (const clipId of clipIds) {
    const { tracks } = sampleClip(rig, clipId)
    b.animation(clipId, tracks.map((t) => ({ ...t, node: nodes[t.node] })))
  }
  return b
}
