/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Six hats, modelled in frame space (the head is the unit sphere) and
// placed by each head's hat anchor plus hat-config adjustments.

import { ellipsoid, lathe, merge, pillow, profile, puffyStar, sphere, spline, surface, torus, transform, tube, warp } from './geometry.mjs'
import { add, normalize, quatFromEuler, quatFromUp, scale, smoothstep, TAU } from './math.mjs'
import { around, at, dir, shell, wrap } from './shell.mjs'

/** A fluffy ball: a core with a ring of overlapping puffs. */
function fluff(radius, c) {
  const puffs = [sphere(radius * 0.86, c, [12, 8])]
  for (let i = 0; i < 7; i++) {
    const d = dir((TAU * i) / 7 + 0.3, i % 2 ? 0.45 : -0.15)
    puffs.push(sphere(radius * 0.5, add(c, scale(d, radius * 0.55)), [8, 6]))
  }
  puffs.push(sphere(radius * 0.5, add(c, [0, radius * 0.6, 0]), [8, 6]))
  return merge(puffs)
}

// Cap shells, shared by the meshes and the fit checks (lib/fit.mjs).
const BEANIE = {
  edge: around(0.36, 0.22, 0.02, { frontWidth: 1.0 }),
  thick: (az, el) => 0.17 + 0.1 * smoothstep(0.9, 1.5, el) + 0.015 * Math.cos(az * 16) * smoothstep(0.5, 0.8, el) * smoothstep(1.3, 1.0, el),
}
const CAP = {
  edge: around(0.42, 0.18, 0.0),
  thick: (az, el) => 0.13 + 0.05 * smoothstep(1.4, 0.4, Math.abs(wrap(az))) * smoothstep(0.4, 1.0, el) * smoothstep(1.55, 1.1, el),
}

/** A closed wall ring (crown band): outer radius `ro(az)`, height `h(az)`, thickness `th`, base height `y0`. */
function wallRing({ ro, h, th, y0, flare = 0, nu = 90, nv = 10 }) {
  return surface(nu, nv, (u, v) => {
    const az = TAU * u
    const a = TAU * v
    // Superellipse cross-section: square-ish with rounded corners.
    const c = Math.cos(a), s = Math.sin(a)
    const x = Math.sign(c) * Math.abs(c) ** 0.35
    const y = Math.sign(s) * Math.abs(s) ** 0.35
    const hh = h(az)
    const t = (y + 1) / 2
    const radius = ro(az) - th / 2 + (th / 2) * x + flare * t
    return [radius * Math.sin(az), y0 + t * hh, radius * Math.cos(az)]
  })
}

export const HATS = {
  'hat-beanie': {
    label: 'Beanie',
    fit: { type: 'shell', shells: [BEANIE] },
    build: () => {
      const { edge } = BEANIE
      const body = shell({ ...BEANIE, nu: 64, nv: 16, tuck: 0.95, roll: 0.05 })
      // Ribbed cuff riding along the brim.
      const cuff = warp(
        tube((t) => {
          const az = -Math.PI + TAU * t
          return at(az, edge(az) + 0.1, 1.2)
        }, [0.12, 0.075], { seg: [72, 10], loop: true, up: [0, 1, 0] }),
        (p) => {
          const az = Math.atan2(p[0], p[2])
          const k = 1 + 0.02 * Math.cos(az * 30)
          return [p[0] * k, p[1], p[2] * k]
        },
      )
      const pom = fluff(0.25, [0, 1.42, -0.08])
      return { 'tint:outfit': body, 'tint:accent': cuff, 'paint:cream': pom }
    },
  },
  'hat-cap': {
    label: 'Cap',
    fit: { type: 'shell', shells: [CAP] },
    build: () => {
      const { edge } = CAP
      const crown = shell({ ...CAP, nu: 60, nv: 14, tuck: 0.95, roll: 0.04 })
      // Brim: a soft curved bill in front of the crown edge.
      const base = (a) => at(a, edge(a) + 0.03, 1.1)
      const brimAt = (a, b) => {
        const p0 = base(a)
        const fwd = normalize([Math.sin(a) * 0.55, -0.26, Math.cos(a)])
        const p = add(p0, scale(fwd, b))
        // Gentle downward curve toward the sides.
        p[1] -= 0.1 * (a / 0.9) ** 2 * b
        return { p, n: [0, 1, 0] }
      }
      const outline = (u) => {
        const t = u * TAU
        const a = 0.92 * Math.sin(t)
        const b = 0.3 - 0.32 * Math.cos(t)
        return [a, Math.max(-0.06, b)]
      }
      const brim = pillow(brimAt, outline, [0, 0.25], { thick: 0.035, under: 0.035, lift: 0, seg: [48, 6], power: 6 })
      const button = ellipsoid({ r: [0.09, 0.05, 0.09], c: [0, 1.17, -0.02], seg: [14, 8] })
      return { 'tint:outfit': crown, 'tint:accent': merge(brim, button) }
    },
  },
  'hat-crown': {
    label: 'Crown',
    // The band's base rests where the head is as wide as the unit sphere at this height.
    fit: { type: 'ring', y: Math.sin(0.92) - 0.06 },
    build: () => {
      const el0 = 0.92
      const y0 = Math.sin(el0) - 0.06
      const ring = Math.cos(el0) + 0.02
      const points = 5
      const peak = (az) => {
        const f = (((az * points) / TAU) % 1 + 1) % 1
        const tri = 1 - Math.abs(2 * f - 1) * 2
        return Math.max(0, tri) ** 1.6
      }
      const h = (az) => 0.2 + 0.26 * peak(az + Math.PI / points)
      const wall = wallRing({ ro: () => ring + 0.05, h, th: 0.07, y0, flare: 0.06 })
      const gold = [wall]
      const gems = { 'paint:ruby': [], 'paint:sapphire': [], 'paint:emerald': [] }
      for (let i = 0; i < points; i++) {
        const az = (TAU * i) / points
        const r = ring + 0.05 + 0.06 + 0.02
        gold.push(sphere(0.065, [r * Math.sin(az), y0 + 0.47, r * Math.cos(az)], [10, 7]))
        const kind = i === 0 ? 'paint:ruby' : i === 1 || i === 4 ? 'paint:emerald' : 'paint:sapphire'
        const gr = ring + 0.1
        const g = ellipsoid({ r: [i === 0 ? 0.07 : 0.055, i === 0 ? 0.08 : 0.055, 0.03], seg: [10, 7] })
        gems[kind].push(transform(g, { t: [gr * Math.sin(az), y0 + 0.12, gr * Math.cos(az)], r: quatFromEuler(-0.25, az, 0) }))
      }
      // A rim of beads round the base.
      const beadRing = torus({ R: ring + 0.08, r: 0.035, c: [0, y0 + 0.02, 0], seg: [48, 6] })
      return { 'paint:gold': merge(...gold, beadRing), ...Object.fromEntries(Object.entries(gems).map(([k, v]) => [k, merge(v)])) }
    },
  },
  'hat-wizard': {
    label: 'Wizard',
    fit: { type: 'ring', y: 0.42 },
    build: () => {
      const baseY = 0.42
      const spine = spline([[0, baseY - 0.05, 0], [0, 1.05, -0.04], [0.04, 1.6, -0.12], [0.2, 2.0, -0.24], [0.42, 2.12, -0.3]])
      const cone = tube(spine, (t) => {
        const r = 0.92 * (1 - t) ** 1.25 + 0.02
        return [r, r]
      }, { seg: [32, 20], caps: 'flat', up: [0, 0, 1] })
      const brim = torus({ R: 1.12, r: 0.42, c: [0, baseY, 0], seg: [60, 8], tubeScale: [0.14, 1] })
      const bandY = baseY + 0.16
      const bandR = 0.92 * (1 - 0.16 / 1.7) ** 1.25 + 0.04
      const band = torus({ R: bandR, r: 0.07, c: [0, bandY, 0], seg: [48, 8], tubeScale: [1.5, 0.7] })
      const star = transform(puffyStar({ outer: 0.17, inner: 0.08, depth: 0.06 }), { t: [0, 0.95, 0.66], r: quatFromEuler(-0.32, 0, 0.12) })
      const dots = [sphere(0.035, [0.24, 1.18, 0.5], [10, 6]), sphere(0.028, [-0.2, 0.78, 0.74], [10, 6])]
      return { 'tint:outfit': merge(cone, brim), 'tint:accent': band, 'paint:star': merge(star, ...dots) }
    },
  },
  'hat-beret': {
    label: 'Beret',
    // The band hugs the head where it is this wide; the soft crown puffs out over it.
    fit: { type: 'ring', y: Math.sqrt(1 - 0.74 ** 2) - 0.02 },
    build: () => {
      const bandR = 0.74
      const y0 = Math.sqrt(1 - bandR ** 2) - 0.02
      // A cushion: flat-ish underside, widest a little above the band, domed top.
      const cushion = lathe([
        profile((t) => {
          const a = Math.PI * t
          const r = 0.94 * Math.sin(a) ** 0.55
          const y = t < 0.5 ? 0.17 - 0.17 * Math.cos(a) : 0.17 - 0.27 * Math.cos(a)
          return [t === 0 || t === 1 ? 0 : r, y]
        }, 28),
      ], 56)
      const band = torus({ R: bandR, r: 0.055, c: [0, 0.02, 0], seg: [48, 8] })
      const stem = tube(spline([[0, 0.4, 0], [0.02, 0.5, 0], [0.07, 0.55, 0]]), 0.035, { seg: [8, 8] })
      // Lifted to the band's seat, then tipped about the head's centre so it stays seated.
      const tilt = quatFromEuler(-0.16, 0, 0.3)
      const place = (shape) => transform(transform(shape, { t: [0, y0, 0] }), { r: tilt })
      return { 'tint:accent': merge(place(cushion), place(stem)), 'tint:outfit': place(band) }
    },
  },
  'hat-flower-crown': {
    label: 'Flower crown',
    fit: { type: 'ring', y: Math.sin(0.6) },
    build: () => {
      const el = 0.6
      const ringR = Math.cos(el) + 0.08
      const y = Math.sin(el)
      const vine = torus({ R: ringR, r: 0.045, c: [0, y, 0], seg: [60, 6] })
      const petals = { 'paint:petal': [], 'paint:petal3': [], 'paint:white': [] }
      const centers = []
      const leaves = []
      const kinds = ['paint:petal', 'paint:white', 'paint:petal3']
      const flowers = 7
      for (let i = 0; i < flowers; i++) {
        const az = -2.3 + (4.6 * i) / (flowers - 1)
        const out = dir(az, el + 0.12)
        const c = add([ringR * Math.sin(az), y, ringR * Math.cos(az)], scale(out, 0.1))
        const q = quatFromUp(out)
        const size = i === 3 ? 1.5 : 1.25
        for (let k = 0; k < 5; k++) {
          const a = (TAU * k) / 5 + i
          const petal = ellipsoid({ r: [0.055 * size, 0.025, 0.1 * size], c: [0, 0, 0.085 * size], seg: [7, 4] })
          petals[kinds[i % 3]].push(transform(transform(petal, { r: quatFromEuler(0.12, a, 0) }), { r: q, t: c }))
        }
        centers.push(transform(sphere(0.05 * size, [0, 0.025, 0], [8, 5]), { r: q, t: c }))
        if (i < flowers - 1) {
          const la = az + 2.3 / (flowers - 1)
          const lp = add([ringR * Math.sin(la), y + 0.02, ringR * Math.cos(la)], scale(dir(la, el), 0.03))
          leaves.push(transform(ellipsoid({ r: [0.04, 0.018, 0.1], seg: [8, 5] }), { t: lp, r: quatFromEuler(0.3, la + 1.2, 0.3) }))
        }
      }
      return {
        'paint:leaf': merge(vine, ...leaves),
        'paint:star': merge(centers),
        ...Object.fromEntries(Object.entries(petals).map(([k, v]) => [k, merge(v)])),
      }
    },
  },
}
