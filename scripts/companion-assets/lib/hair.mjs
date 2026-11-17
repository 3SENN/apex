/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Eight hair styles, modelled in frame space (the head is the unit sphere).

import { ellipsoid, merge, sphere, spline, torus, transform, tube } from './geometry.mjs'
import { add, cross, normalize, quatFromUp, scale, smoothstep, TAU } from './math.mjs'
import { around, at, dir, shell, wrap } from './shell.mjs'

/** A tapered lock: tube along points with radius easing from `r0` to a soft tip. */
function lock(points, r0, { r1 = 0.012, seg = [24, 10], flat = 1, bulge = 0 } = {}) {
  const curve = spline(points)
  return tube(curve, (t) => {
    const r = r0 * (1 - t) ** 0.9 + r1 * t + bulge * Math.sin(Math.PI * t) * r0
    return [r, r * flat]
  }, { seg, up: [0, 0, 1] })
}

/** A cone-like spike from inside the head out along `d`. */
function spike(d, len, r0, { bend = [0, 0, 0], flat = 1 } = {}) {
  const base = scale(d, 0.84)
  const mid = add(scale(d, 0.84 + len * 0.55), scale(bend, 0.4))
  const tip = add(scale(d, 0.84 + len), bend)
  return tube(spline([base, mid, tip]), (t) => {
    const r = r0 * Math.pow(1 - t, 1.15) + 0.008
    return [r * flat, r]
  }, { seg: [10, 8], up: cross(d, [0, 1, 0]).some((v) => Math.abs(v) > 1e-3) ? cross(d, [0, 1, 0]) : [1, 0, 0] })
}

/** Points spread over the sphere (golden spiral), filtered by `keep`. */
function spread(count, keep) {
  const out = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count
    const r = Math.sqrt(1 - y * y)
    const a = golden * i
    const d = [Math.sin(a) * r, y, Math.cos(a) * r]
    if (keep(d)) out.push(d)
  }
  return out
}
const azOf = (d) => Math.atan2(d[0], d[2])
const elOf = (d) => Math.asin(Math.max(-1, Math.min(1, d[1])))

// Cap shells, shared by the meshes and the fit checks (lib/fit.mjs).
const BOB = {
  edge: around((az) => 0.3 - 0.06 * Math.max(0, Math.cos(az * 9)) ** 2, -0.55, -0.62, { frontWidth: 0.95, soft: 0.22 }),
  thick: (az, el) => 0.12 + 0.08 * smoothstep(0.7, 1.2, Math.abs(wrap(az))) * smoothstep(-0.05, -0.5, el) + 0.03 * smoothstep(0.6, 1.4, el),
}
const SPIKY = { edge: around(0.42, 0.0, -0.32), thick: () => 0.09 }
const CURLS = { edge: around(0.34, -0.12, -0.4), thick: () => 0.09 }
const BUN = {
  edge: around(0.36, 0.02, -0.42),
  thick: (az, el) => 0.085 + 0.015 * Math.cos(az * 14) * smoothstep(0.2, 0.9, el) * smoothstep(1.5, 1.0, el),
}
// The fringe sweeps from high on the left to low on the right.
const SWEPT = {
  edge: around((az) => 0.34 + 0.16 * Math.tanh(az * 1.6), -0.08, -0.38, { frontWidth: 1.0, soft: 0.3 }),
  thick: (az, el) => 0.09 + 0.06 * smoothstep(0.9, -0.2, Math.abs(wrap(az + 0.4))) * smoothstep(1.3, 0.4, el),
}
const PIGTAILS = { edge: around((az) => 0.36 + 0.1 * Math.exp(-((az / 0.1) ** 2)), -0.08, -0.36), thick: () => 0.09 }

export const HAIR = {
  'hair-tuft': {
    label: 'Tuft',
    // A little sprout of three curls on the crown.
    build: () => ({
      'tint:hair': merge(
        lock([[0, 0.82, 0.08], [0, 1.08, 0.12], [0.03, 1.32, 0.06], [0.12, 1.44, -0.06], [0.2, 1.4, -0.16], [0.17, 1.31, -0.18]], 0.15, { seg: [36, 12], flat: 0.8, bulge: 0.1 }),
        lock([[-0.08, 0.84, 0.04], [-0.2, 1.06, 0.06], [-0.34, 1.16, 0.02], [-0.42, 1.14, -0.04]], 0.1, { seg: [22, 10], flat: 0.8 }),
        lock([[0.06, 0.84, -0.06], [0.16, 1.02, -0.18], [0.24, 1.08, -0.32], [0.26, 1.02, -0.4]], 0.09, { seg: [22, 10], flat: 0.8 }),
      ),
    }),
  },
  'hair-bob': {
    label: 'Bob',
    shells: [BOB],
    build: () => ({ 'tint:hair': shell({ ...BOB, nu: 72, nv: 18 }) }),
  },
  'hair-spiky': {
    label: 'Spiky',
    shells: [SPIKY],
    build: () => {
      const cap = shell({ ...SPIKY, nu: 48, nv: 12 })
      const spikes = []
      const list = [
        [0, 0.55, 0.62, 0.24, [0, 0.1, 0.12]],
        [0.55, 0.62, 0.55, 0.22, [0.1, 0.06, 0.04]],
        [-0.55, 0.62, 0.55, 0.22, [-0.1, 0.06, 0.04]],
        [1.2, 0.45, 0.5, 0.2, [0.14, 0.02, -0.04]],
        [-1.2, 0.45, 0.5, 0.2, [-0.14, 0.02, -0.04]],
        [0.3, 1.05, 0.62, 0.24, [0.02, 0.04, -0.12]],
        [-0.3, 1.05, 0.62, 0.24, [-0.02, 0.04, -0.12]],
        [2.0, 0.55, 0.5, 0.21, [0.08, 0, -0.12]],
        [-2.0, 0.55, 0.5, 0.21, [-0.08, 0, -0.12]],
        [Math.PI, 0.6, 0.48, 0.21, [0, 0, -0.12]],
      ]
      for (const [az, el, len, r, bend] of list) spikes.push(spike(dir(az, el), len, r, { bend }))
      return { 'tint:hair': merge(cap, ...spikes) }
    },
  },
  'hair-curls': {
    label: 'Curls',
    shells: [CURLS],
    // The curls stand about this far proud of the cap; hats seat on them.
    puff: 0.12,
    build: () => {
      const { edge } = CURLS
      const cap = shell({ ...CURLS, nu: 40, nv: 10 })
      const curls = spread(52, (d) => elOf(d) > edge(azOf(d)) + 0.14).map((d, i) =>
        sphere(0.2 + 0.03 * Math.sin(i * 2.3), scale(d, 1.04), [9, 6]),
      )
      // A row of curls along the hairline frames the face.
      for (let i = 0; i < 15; i++) {
        const az = -Math.PI + (TAU * (i + 0.5)) / 15
        const d = dir(az, edge(az) + 0.13)
        curls.push(sphere(0.17, scale(d, 1.01), [9, 6]))
      }
      return { 'tint:hair': merge(cap, ...curls) }
    },
  },
  'hair-bun': {
    label: 'Bun',
    shells: [BUN],
    build: () => {
      const cap = shell({ ...BUN, nu: 60, nv: 14 })
      const bunDir = normalize([0, 0.9, -0.42])
      const bun = transform(ellipsoid({ r: [0.36, 0.33, 0.36], seg: [18, 12] }), { t: scale(bunDir, 1.22), r: quatFromUp(bunDir) })
      const band = transform(torus({ R: 0.27, r: 0.07, seg: [28, 8] }), { t: scale(bunDir, 1.02), r: quatFromUp(bunDir) })
      return { 'tint:hair': merge(cap, bun), 'tint:accent': band }
    },
  },
  'hair-sideswept': {
    label: 'Side swept',
    shells: [SWEPT],
    build: () => {
      const cap = shell({ ...SWEPT, nu: 72, nv: 16 })
      const swoop = lock(
        [at(0.95, 0.62, 1.08), at(0.45, 0.46, 1.15), at(-0.15, 0.3, 1.13), at(-0.6, 0.18, 1.08), at(-0.9, 0.08, 1.0), at(-1.05, 0.16, 0.98)],
        0.12,
        { seg: [24, 8], flat: 0.7, bulge: 0.2 },
      )
      return { 'tint:hair': merge(cap, swoop) }
    },
  },
  'hair-pigtails': {
    label: 'Pigtails',
    shells: [PIGTAILS],
    build: () => {
      const cap = shell({ ...PIGTAILS, nu: 60, nv: 14 })
      const tails = [], ties = []
      for (const sx of [-1, 1]) {
        const root = at(sx * 1.85, 0.28, 1.02)
        const outward = normalize([sx, -0.2, -0.25])
        const p1 = add(root, scale(outward, 0.18))
        const p2 = add(p1, [sx * 0.22, -0.28, -0.04])
        const p3 = add(p2, [sx * 0.08, -0.36, 0.04])
        tails.push(tube(spline([scale(root, 0.95), p1, p2, p3]), (t) => {
          const r = 0.09 + 0.16 * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.8
          return [r * (1 - t * 0.55), r * (1 - t * 0.55)]
        }, { seg: [20, 10] }))
        ties.push(transform(torus({ R: 0.1, r: 0.055, seg: [20, 8] }), { t: add(root, scale(outward, 0.1)), r: quatFromUp(outward) }))
      }
      return { 'tint:hair': merge(cap, ...tails), 'tint:accent': merge(ties) }
    },
  },
  'hair-mohawk': {
    label: 'Mohawk',
    build: () => {
      const crest = []
      const n = 7
      for (let i = 0; i < n; i++) {
        const s = i / (n - 1)
        const el = 0.75 + (Math.PI - 0.75 - 0.35) * s
        const d = [0, Math.sin(el), Math.cos(el)]
        const height = 0.36 + 0.32 * Math.sin(Math.PI * Math.min(1, s * 1.1))
        // Spikes lean a little left and right in turn, so the crest reads as a jagged fin from the front.
        const lean = (i % 2 ? 1 : -1) * 0.07
        crest.push(spike(d, height * 1.2, 0.27, { bend: [lean, 0.02, -0.14], flat: 0.78 }))
      }
      const strip = tube((t) => {
        const el = 0.7 + (Math.PI - 0.7 - 0.3) * t
        return [0, Math.sin(el) * 1.0, Math.cos(el) * 1.0]
      }, () => [0.19, 0.15], { seg: [30, 10], up: [1, 0, 0] })
      return { 'tint:hair': merge(strip, ...crest) }
    },
  },
}
