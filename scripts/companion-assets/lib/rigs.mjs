/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// The three base rigs. Each body is a surface of revolution (squashed in
// depth) dressed with an outfit, an accent detail, nubby mitten arms and
// little feet. The character faces +Z; its left (arm.L) is +X.

import {
  capsule,
  ellipsoid,
  lathe,
  merge,
  mirrorX,
  pillow,
  profile,
  roundedBox,
  roundedRectOutline,
  sphere,
  spline,
  torus,
  transform,
  tube,
  warp,
} from './geometry.mjs'
import { normalize, quatFromEuler } from './math.mjs'

/** A body of revolution: `shape(θ)` gives [radius, y] for θ from -π/2 (bottom) to π/2 (top). */
function bodyOfRevolution(shape, zScale) {
  const at = (az, th) => {
    const [r, y] = shape(th)
    const e = 1e-4
    const [r1, y1] = shape(th + e)
    const [r0, y0] = shape(th - e)
    const dr = (r1 - r0) / (2 * e), dy = (y1 - y0) / (2 * e)
    const nr = dy, ny = -dr
    const p = [r * Math.sin(az), y, r * Math.cos(az) * zScale]
    const n = normalize([nr * Math.sin(az), ny, (nr * Math.cos(az)) / zScale])
    return { p, n }
  }
  const radiusAtY = (y) => {
    let lo = -Math.PI / 2, hi = Math.PI / 2
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (shape(mid)[1] < y) lo = mid
      else hi = mid
    }
    return shape((lo + hi) / 2)[0]
  }
  const thetaAtY = (y) => {
    let lo = -Math.PI / 2, hi = Math.PI / 2
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (shape(mid)[1] < y) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  const mesh = (th0, th1, steps) => {
    const pts = profile((t) => shape(th0 + (th1 - th0) * t), steps)
    if (th0 <= -Math.PI / 2 + 1e-9) pts[0][0] = 0
    if (th1 >= Math.PI / 2 - 1e-9) pts[pts.length - 1][0] = 0
    return transform(lathe([pts], 48), { s: [1, 1, zScale] })
  }
  return { at, radiusAtY, thetaAtY, mesh, zScale }
}

/** Ribbed band hugging the body at height y. */
function band(body, y, tube, { ribs = 0, rib = 0 } = {}) {
  const R = body.radiusAtY(y)
  const t = torus({ R: R * 0.98, r: tube, c: [0, y, 0], seg: [56, 10] })
  const ribbed = ribs ? warp(t, (p) => {
    const a = Math.atan2(p[0], p[2])
    const k = 1 + rib * Math.cos(a * ribs)
    const d = Math.hypot(p[0], p[2])
    const dr = (d - R * 0.98) * k + R * 0.98
    return [(p[0] / d) * dr, p[1], (p[2] / d) * dr]
  }) : t
  return transform(ribbed, { s: [1, 1, body.zScale] })
}

/** Mitten arm hanging along -Y from the shoulder pivot. Built for the left arm. */
function mittenArm({ sleeveR, sleeveLen, handR, cuff }) {
  const sleeve = capsule({ radius: sleeveR, height: sleeveLen, c: [0, -sleeveLen / 2 + 0.02, 0], seg: [20, 6] })
  const handY = -sleeveLen - handR * 0.55
  const hand = merge(
    ellipsoid({ r: [handR, handR * 1.05, handR * 0.88], c: [0, handY, 0.01], seg: [20, 14] }),
    // Thumb nub, forward and toward the body.
    ellipsoid({ r: [handR * 0.42, handR * 0.5, handR * 0.42], c: [-handR * 0.6, handY + handR * 0.25, handR * 0.45], seg: [12, 8] }),
  )
  const cuffMesh = cuff ? torus({ R: sleeveR * 0.92, r: sleeveR * 0.32, c: [0, -sleeveLen + 0.01, 0], seg: [24, 8] }) : null
  return { sleeve, hand, cuff: cuffMesh, handY }
}

function footShape(r, c = [0, 0, 0]) {
  // Soft round top with a flatter sole.
  return warp(ellipsoid({ r, c: [0, 0, 0], seg: [22, 14] }), (p) => [p[0] + c[0], (p[1] < 0 ? p[1] * 0.55 : p[1]) + c[1], p[2] + c[2] + (p[1] < 0 ? 0 : -p[1] * 0.25)])
}

// ---- rig A: Bean, a round creature in a hoodie ----

function rigA() {
  const zs = 0.9
  const body = bodyOfRevolution((th) => {
    const s = Math.sin(th), c = Math.cos(th)
    return [0.5 * Math.max(0, c) * (1 - 0.07 * s), 0.44 + 0.5 * s * (s < 0 ? 0.9 : 1)]
  }, zs)
  const outfit = [body.mesh(-Math.PI / 2, Math.PI / 2, 28), band(body, 0.07, 0.05, { ribs: 26, rib: 0.18 })]
  // Kangaroo pocket.
  const pocket = pillow(body.at, roundedRectOutline(0, body.thetaAtY(0.3), 1.1, 0.42, 0.14), [0, body.thetaAtY(0.3)], { thick: 0.028, under: 0.04 })
  // Drawstrings with bead tips, hanging from the neckline.
  const strings = []
  for (const sx of [-1, 1]) {
    const top = body.at(sx * 0.2, body.thetaAtY(0.86)).p
    const mid = body.at(sx * 0.23, body.thetaAtY(0.74)).p
    const end = body.at(sx * 0.24, body.thetaAtY(0.64)).p
    const lift = (p, k) => [p[0], p[1], p[2] + k]
    strings.push(tube(spline([lift(top, 0.0), lift(mid, 0.03), lift(end, 0.035)]), 0.018, { seg: [10, 8] }))
    strings.push(sphere(0.034, lift(end, 0.04), [12, 8]))
  }
  const arm = mittenArm({ sleeveR: 0.115, sleeveLen: 0.26, handR: 0.125, cuff: true })
  const foot = footShape([0.15, 0.09, 0.19], [0, 0, 0.02])
  return {
    label: 'Bean',
    bodyY: 0.08,
    neck: [0, 0.9, 0.02],
    headScale: 1,
    shoulder: [0.44, 0.6, 0],
    armOut: 0.32,
    hand: [0, arm.handY, 0.04],
    foot: [0.21, 0.08, 0.06],
    hop: 1,
    think: { t: [0.14, 0.12, 0.2], r: [-2.44, 0, 0.42] },
    hug: { t: [-0.04, 0, 0.06], r: [-0.8, 0, -0.35] },
    meshes: {
      body: { 'tint:outfit': merge(outfit), 'tint:accent': merge(pocket, ...strings) },
      arm: { 'tint:outfit': arm.sleeve, 'tint:accent': arm.cuff, 'tint:skin': arm.hand },
      foot: { 'tint:skin': foot },
    },
    body,
  }
}

// ---- rig B: Sprout, tall and slim in overalls ----

function rigB() {
  const zs = 0.88
  const body = bodyOfRevolution((th) => {
    const s = Math.sin(th), c = Math.cos(th)
    return [0.37 * Math.max(0, c) ** 0.85 * (1 - 0.12 * s), 0.58 + 0.62 * s * (s < 0 ? 0.92 : 1)]
  }, zs)
  const waist = body.thetaAtY(0.46)
  const pants = body.mesh(-Math.PI / 2, waist, 14)
  const shirt = body.mesh(waist, Math.PI / 2, 18)
  const bibTop = body.thetaAtY(0.86)
  const bib = pillow(body.at, roundedRectOutline(0, (waist + bibTop) / 2 + 0.02, 0.98, bibTop - waist + 0.06, 0.08), [0, (waist + bibTop) / 2], {
    thick: 0.022,
    under: 0.03,
  })
  const cuffs = band(body, 0.47, 0.035)
  const straps = []
  const buttons = []
  for (const sx of [-1, 1]) {
    const pts = []
    for (let i = 0; i <= 8; i++) {
      const t = i / 8
      const az = sx * (0.36 + (Math.PI - 0.9) * t)
      const y = 0.86 + 0.24 * Math.sin(Math.PI * Math.min(1, t * 1.15)) - 0.12 * t
      const { p, n } = body.at(az, body.thetaAtY(Math.min(1.13, y)))
      pts.push(p.map((v, k) => v + n[k] * 0.02))
    }
    straps.push(tube(spline(pts), () => [0.05, 0.016], { seg: [28, 10], caps: 'round' }))
    const { p, n } = body.at(sx * 0.36, bibTop)
    buttons.push(transform(ellipsoid({ r: [0.04, 0.04, 0.018], seg: [14, 8] }), { t: p.map((v, k) => v + n[k] * 0.03), r: quatFromEuler(-0.25, sx * 0.36, 0) }))
  }
  const arm = mittenArm({ sleeveR: 0.1, sleeveLen: 0.3, handR: 0.115, cuff: false })
  const boot = merge(footShape([0.14, 0.11, 0.19], [0, 0.005, 0.02]), torus({ R: 0.1, r: 0.035, c: [0, 0.06, 0.0], seg: [20, 8] }))
  return {
    label: 'Sprout',
    bodyY: 0.1,
    neck: [0, 1.14, 0.02],
    headScale: 0.96,
    shoulder: [0.33, 0.96, 0],
    armOut: 0.26,
    hand: [0, arm.handY, 0.04],
    foot: [0.17, 0.09, 0.05],
    hop: 1.1,
    think: { t: [0.11, 0.02, 0.1], r: [-2.21, 0, 0.2] },
    hug: { t: [-0.03, 0, 0.05], r: [-0.7, 0, -0.3] },
    meshes: {
      body: { 'tint:outfit': merge(pants, bib, ...straps, cuffs), 'tint:accent': shirt, 'paint:gold': merge(buttons) },
      arm: { 'tint:accent': arm.sleeve, 'tint:skin': arm.hand },
      foot: { 'paint:boot': boot },
    },
    body,
  }
}

// ---- rig C: Pebble, small and stubby in a puffer ----

function rigC() {
  const zs = 0.9
  const body = bodyOfRevolution((th) => {
    const s = Math.sin(th), c = Math.cos(th)
    return [0.43 * Math.max(0, c) ** 0.7, 0.3 + 0.34 * s * (s < 0 ? 0.85 : 1)]
  }, zs)
  const puffs = [band(body, 0.13, 0.065), band(body, 0.33, 0.07)]
  const zipper = []
  {
    const pts = []
    for (let i = 0; i <= 6; i++) {
      const y = 0.02 + (0.58 * i) / 6
      const { p, n } = body.at(0, body.thetaAtY(y))
      pts.push(p.map((v, k) => v + n[k] * 0.012))
    }
    zipper.push(tube(spline(pts), 0.016, { seg: [16, 6] }))
    const { p, n } = body.at(0, body.thetaAtY(0.5))
    zipper.push(transform(roundedBox({ size: [0.05, 0.09, 0.025], radius: 0.012, seg: 2 }), { t: p.map((v, k) => v + n[k] * 0.035), r: quatFromEuler(-0.35, 0, 0) }))
  }
  const arm = mittenArm({ sleeveR: 0.12, sleeveLen: 0.2, handR: 0.11, cuff: true })
  const foot = footShape([0.13, 0.08, 0.16], [0, 0, 0.02])
  return {
    label: 'Pebble',
    bodyY: 0.06,
    neck: [0, 0.58, 0.02],
    headScale: 1.1,
    shoulder: [0.38, 0.42, 0],
    armOut: 0.42,
    hand: [0, arm.handY, 0.035],
    foot: [0.19, 0.075, 0.05],
    hop: 0.85,
    think: { t: [0.08, 0.06, 0.14], r: [-2.08, 0, 0.455] },
    hug: { t: [-0.04, 0, 0.06], r: [-0.8, 0, -0.4] },
    meshes: {
      body: { 'tint:outfit': merge(body.mesh(-Math.PI / 2, Math.PI / 2, 24), ...puffs), 'tint:accent': merge(zipper) },
      arm: { 'tint:outfit': arm.sleeve, 'tint:accent': arm.cuff, 'tint:skin': arm.hand },
      foot: { 'tint:skin': foot },
    },
    body,
  }
}

export const RIG_DEFS = { A: rigA, B: rigB, C: rigC }
export const RIG_LABELS = { A: 'Bean', B: 'Sprout', C: 'Pebble' }

/** Rest transforms of the rig nodes, shared by the rig writer and the animator. */
export function restPose(rig) {
  const [sx, sy, sz] = rig.shoulder
  const [fx, fy, fz] = rig.foot
  return {
    root: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
    body: { t: [0, rig.bodyY, 0], r: [0, 0, 0], s: [1, 1, 1] },
    'head-pivot': { t: rig.neck, r: [0, 0, 0], s: [1, 1, 1] },
    'arm.L': { t: [sx, sy, sz], r: [0, 0, rig.armOut], s: [1, 1, 1] },
    'arm.R': { t: [-sx, sy, sz], r: [0, 0, -rig.armOut], s: [1, 1, 1] },
    'foot.L': { t: [fx, fy, fz], r: [0, 0, 0], s: [1, 1, 1] },
    'foot.R': { t: [-fx, fy, fz], r: [0, 0, 0], s: [1, 1, 1] },
  }
}

/** Builds the left/right mesh sets for a rig. */
export function rigMeshes(rig) {
  const mirror = (parts) => Object.fromEntries(Object.entries(parts).filter(([, s]) => s).map(([m, s]) => [m, mirrorX(s)]))
  const clean = (parts) => Object.fromEntries(Object.entries(parts).filter(([, s]) => s))
  return {
    body: clean(rig.meshes.body),
    'arm.L': clean(rig.meshes.arm),
    'arm.R': mirror(rig.meshes.arm),
    'foot.L': clean(rig.meshes.foot),
    'foot.R': mirror(rig.meshes.foot),
  }
}
