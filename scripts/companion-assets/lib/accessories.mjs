/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Ears and ear accessories (frame space: the head is the unit sphere) and
// eye accessories (eye space: eyes at x = ±0.203, the face surface at z = 0
// between them, sized for a 1.3-wide face canvas).

import { ellipsoid, lathe, merge, puffyStar, roundedRectOutline, sphere, spline, torus, transform, tube } from './geometry.mjs'
import { add, normalize, quatFromEuler, quatFromUp, scale } from './math.mjs'
import { at, dir } from './shell.mjs'

const FWD = [0, 0, 1]
const offset = (pts, v) => pts.map((p) => add(p, v))

/** Flat tapering ear along a spline: `width(t)` left-right, `thick(t)` front-back. */
const earBlade = (pts, width, thick, seg = [20, 10]) => tube(spline(pts), (t) => [thick(t), width(t)], { seg, up: FWD })

export const EARS = {
  'ears-cat': {
    label: 'Cat',
    build: () => {
      const skin = [], inner = []
      for (const sx of [-1, 1]) {
        const d = dir(sx * 0.95, 0.95)
        const tip = add(scale(d, 1.42), [sx * 0.06, 0.06, -0.04])
        const pts = [scale(d, 0.78), scale(d, 1.1), tip]
        skin.push(earBlade(pts, (t) => 0.3 * (1 - t) + 0.025, (t) => 0.12 * (1 - t) + 0.025))
        const ipts = offset([scale(d, 0.92), scale(d, 1.12), add(scale(d, 1.3), [sx * 0.04, 0.04, -0.03])], [0, 0, 0.075])
        inner.push(earBlade(ipts, (t) => 0.17 * (1 - t) + 0.02, () => 0.045))
      }
      return { 'tint:skin': merge(skin), 'paint:petal': merge(inner) }
    },
  },
  'ears-bear': {
    label: 'Bear',
    build: () => {
      const skin = [], inner = []
      for (const sx of [-1, 1]) {
        const d = dir(sx * 0.9, 0.78)
        const q = quatFromEuler(0, sx * 0.55, -sx * 0.32)
        skin.push(transform(ellipsoid({ r: [0.28, 0.26, 0.13], seg: [20, 14] }), { t: scale(d, 1.02), r: q }))
        inner.push(transform(ellipsoid({ r: [0.16, 0.15, 0.06], c: [0, -0.02, 0.1], seg: [16, 10] }), { t: scale(d, 1.02), r: q }))
      }
      return { 'tint:skin': merge(skin), 'paint:petal': merge(inner) }
    },
  },
  'ears-bunny': {
    label: 'Bunny',
    build: () => {
      const skin = [], inner = []
      for (const sx of [-1, 1]) {
        const base = scale(dir(sx * 0.34, 1.12), 0.8)
        const floppy = sx < 0
        const rel = floppy
          ? [[0, 0, 0], [-0.05, 0.42, -0.04], [-0.16, 0.74, 0.02], [-0.4, 0.78, 0.18]]
          : [[0, 0, 0], [0.05, 0.46, -0.05], [0.12, 0.86, -0.12], [0.16, 1.1, -0.18]]
        const pts = rel.map((p) => add(base, p))
        const width = (t) => 0.12 + 0.08 * Math.sin(Math.PI * Math.min(1, t * 1.1)) ** 0.7
        skin.push(earBlade(pts, width, () => 0.075, [24, 10]))
        inner.push(earBlade(offset(pts.slice(0, 3).concat([pts[3]]), [0, 0, 0.055]).map((p, i) => (i === 0 ? add(p, [0, 0.25, 0]) : p)), (t) => width(t) * 0.5, () => 0.035, [20, 8]))
      }
      return { 'tint:skin': merge(skin), 'paint:petal': merge(inner) }
    },
  },
  'ears-elf': {
    label: 'Elf',
    build: () => {
      const skin = [], inner = []
      for (const sx of [-1, 1]) {
        const d = dir(sx * 1.42, 0.02)
        const pts = [scale(d, 0.8), add(scale(d, 1.05), [0, 0.05, -0.04]), add(scale(d, 1.12), [sx * 0.32, 0.22, -0.12]), add(scale(d, 1.05), [sx * 0.46, 0.38, -0.18])]
        const width = (t) => 0.2 * (1 - t) ** 0.85 * (0.65 + 0.35 * Math.sin(Math.PI * t)) + 0.01
        skin.push(earBlade(pts, width, (t) => 0.06 * (1 - t) + 0.02, [28, 12]))
        inner.push(earBlade(offset(pts.slice(1, 4), [0, -0.01, 0.045]), (t) => width(t * 0.7 + 0.25) * 0.45, () => 0.025, [20, 10]))
      }
      return { 'tint:skin': merge(skin), 'paint:petal': merge(inner) }
    },
  },
}

// ---- eye accessories ----

const EYE_X = 0.203
const faceRing = (R, r, c, turn) => transform(torus({ R, r, seg: [32, 8] }), { t: c, r: quatFromEuler(Math.PI / 2, turn, 0) })

/** Temple arms from the outer rims back into the head. */
const temples = (x, y, z, r) => [-1, 1].map((sx) => tube(spline([[sx * x, y, z], [sx * (x + 0.06), y + 0.02, z - 0.12], [sx * (x + 0.1), y + 0.03, -0.42]]), r, { seg: [14, 8] }))

/** A loop on a vertical cylinder of radius `R` that wraps around the face. */
function wrappedLoop(outline, R, z0, r, seg = [56, 8]) {
  return tube((t) => {
    const [a, b] = outline(t)
    return [R * Math.sin(a / R), b, R * Math.cos(a / R) - R + z0]
  }, r, { seg, loop: true, up: FWD })
}

export const EYE_ACCESSORIES = {
  'glasses-round': {
    label: 'Round glasses',
    build: () => {
      const rims = [-1, 1].map((sx) => faceRing(0.128, 0.022, [sx * EYE_X, 0, 0.065], sx * 0.22))
      const bridge = tube(spline([[-0.078, 0.02, 0.075], [0, 0.06, 0.1], [0.078, 0.02, 0.075]]), 0.02, { seg: [16, 8] })
      return { 'paint:ink': merge(...rims, bridge, ...temples(0.33, 0.01, 0.04, 0.018)) }
    },
  },
  'glasses-square': {
    label: 'Square glasses',
    build: () => {
      const rims = [-1, 1].map((sx) => wrappedLoop(roundedRectOutline(sx * EYE_X, 0, 0.29, 0.21, 0.07), 0.9, 0.065, 0.024))
      const bridge = tube(spline([[-0.06, 0.04, 0.08], [0, 0.055, 0.1], [0.06, 0.04, 0.08]]), 0.022, { seg: [14, 8] })
      return { 'tint:accent': merge(...rims, bridge, ...temples(0.34, 0.03, 0.03, 0.02)) }
    },
  },
  monocle: {
    label: 'Monocle',
    build: () => {
      // Worn over the character's right eye (-X) with a chain looping down to the side.
      const rim = faceRing(0.135, 0.026, [-EYE_X, 0, 0.07], -0.2)
      const chainPath = spline([[-0.31, -0.08, 0.05], [-0.38, -0.25, 0.06], [-0.46, -0.36, -0.02], [-0.52, -0.3, -0.18], [-0.54, -0.18, -0.32]])
      // A fine cord with a few beads reads as a chain at companion size; real links turn to noise.
      const cord = tube(chainPath, 0.011, { seg: [36, 6] })
      const beads = [0.2, 0.4, 0.6, 0.8].map((t) => sphere(0.022, chainPath(t), [8, 6]))
      const clip = sphere(0.026, [-0.31, -0.08, 0.06], [10, 6])
      return { 'paint:gold': merge(rim, clip, cord, ...beads) }
    },
  },
  visor: {
    label: 'Visor',
    build: () => {
      const R = 0.75
      const frame = wrappedLoop(roundedRectOutline(0, -0.005, 0.84, 0.29, 0.1), R, 0.075, 0.03, [72, 8])
      const brow = tube((t) => {
        const a = -0.36 + 0.72 * t
        return [R * Math.sin(a / R), 0.15, R * Math.cos(a / R) - R + 0.085]
      }, () => [0.045, 0.06], { seg: [40, 10], up: [0, 1, 0] })
      const arms = [-1, 1].map((sx) => tube(spline([[sx * 0.4, 0.05, -0.02], [sx * 0.46, 0.06, -0.16], [sx * 0.48, 0.07, -0.42]]), [0.03, 0.05], { seg: [12, 8], up: [0, 1, 0] }))
      const light = sphere(0.03, [0.3, 0.16, 0.06], [10, 6])
      return { 'tint:accent': merge(frame, brow, ...arms), 'paint:screen': light }
    },
  },
}

// ---- ear accessories (frame space) ----

/** The headphone band's centre line, ear to ear over the top. */
const bandPath = (t) => {
  const a = (t * 2 - 1) * (Math.PI / 2)
  return [1.12 * Math.sin(a), -0.02 + 1.14 * Math.cos(a), -0.06]
}

export const EAR_ACCESSORIES = {
  headphones: {
    label: 'Headphones',
    // Worn over the hair, so hat-config scales it per head and hair until the band clears both.
    fit: { type: 'band', path: bandPath, half: 0.05, clearance: 0.025 },
    build: () => {
      const band = tube(bandPath, [0.1, 0.05], { seg: [40, 8], up: FWD })
      const cups = [], cushions = [], caps = []
      for (const sx of [-1, 1]) {
        const axis = [sx, 0, 0]
        const cup = lathe([[[0, -0.09], [0.25, -0.09], [0.29, -0.05], [0.29, 0.05], [0.25, 0.09], [0, 0.09]]], 24)
        cups.push(transform(cup, { t: [sx * 1.14, -0.14, -0.04], r: quatFromUp(axis) }))
        cushions.push(transform(torus({ R: 0.2, r: 0.075, seg: [24, 8] }), { t: [sx * 1.04, -0.14, -0.04], r: quatFromUp(axis) }))
        caps.push(transform(ellipsoid({ r: [0.16, 0.035, 0.16], seg: [16, 6] }), { t: [sx * 1.23, -0.14, -0.04], r: quatFromUp(axis) }))
        cups.push(transform(ellipsoid({ r: [0.06, 0.1, 0.06], seg: [10, 8] }), { t: [sx * 1.1, 0.08, -0.06] }))
      }
      return { 'tint:accent': merge(band, ...cups), 'paint:ink': merge(cushions), 'paint:white': merge(caps) }
    },
  },
  'earring-hoop': {
    label: 'Hoop earrings',
    build: () => {
      const parts = []
      for (const sx of [-1, 1]) {
        const lobe = at(sx * 1.4, -0.4, 1.03)
        parts.push(sphere(0.05, lobe, [12, 8]))
        const c = add(lobe, [sx * 0.03, -0.18, 0.03])
        parts.push(transform(torus({ R: 0.16, r: 0.03, seg: [32, 8] }), { t: c, r: quatFromUp(normalize([sx * 0.6, 0, 0.8])) }))
      }
      return { 'paint:gold': merge(parts) }
    },
  },
  'earring-star': {
    label: 'Star earrings',
    build: () => {
      const gold = [], stars = []
      for (const sx of [-1, 1]) {
        const lobe = at(sx * 1.4, -0.4, 1.03)
        gold.push(sphere(0.045, lobe, [12, 8]))
        gold.push(tube(spline([lobe, add(lobe, [sx * 0.01, -0.07, 0.01]), add(lobe, [sx * 0.02, -0.12, 0.02])]), 0.012, { seg: [8, 6] }))
        const c = add(lobe, [sx * 0.03, -0.24, 0.03])
        stars.push(transform(puffyStar({ outer: 0.17, inner: 0.08, depth: 0.07 }), { t: add(c, [0, -0.03, 0]), r: quatFromEuler(0, sx * 0.6, sx * 0.15) }))
      }
      return { 'paint:gold': merge(gold), 'paint:star': merge(stars) }
    },
  },
}
