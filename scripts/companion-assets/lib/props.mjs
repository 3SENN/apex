/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Seven props, held in the right mitten. Modelled in world units around the
// prop anchor (the mitten's centre), upright at rest; the character's right
// is -X and the front is +Z.

import { ellipsoid, frustum, lathe, merge, puffyStar, roundedBox, sphere, spline, torus, transform, tube } from './geometry.mjs'
import { quatFromEuler, quatFromUp } from './math.mjs'

export const PROPS = {
  'prop-coffee': {
    label: 'Coffee',
    build: () => {
      const c = [-0.02, 0.05, 0.15]
      const mug = lathe(
        [
          [[0, -0.12], [0.115, -0.12], [0.125, -0.1]],
          [[0.125, -0.1], [0.128, 0.0], [0.13, 0.11]],
          [[0.13, 0.11], [0.132, 0.125], [0.12, 0.135], [0.106, 0.125], [0.104, 0.1]],
          [[0.104, 0.1], [0.1, 0.09], [0, 0.09]],
        ],
        36,
        { c },
      )
      const coffee = lathe([[[0, 0.088], [0.102, 0.088], [0.102, 0.098], [0, 0.098]]], 30, { c })
      const handle = transform(torus({ R: 0.07, r: 0.024, arc: [Math.PI * 0.12, Math.PI * 0.88], seg: [20, 8] }), {
        t: [c[0] - 0.125, c[1] + 0.005, c[2]],
        r: quatFromEuler(-Math.PI / 2, Math.PI, 0),
      })
      const foam = ellipsoid({ r: [0.05, 0.012, 0.04], c: [c[0] + 0.01, c[1] + 0.1, c[2] + 0.01], seg: [12, 6] })
      const steam = [-1, 1].map((k) =>
        tube(spline([[c[0] + k * 0.03, c[1] + 0.17, c[2]], [c[0] + k * 0.06, c[1] + 0.24, c[2]], [c[0] + k * 0.02, c[1] + 0.31, c[2]], [c[0] + k * 0.05, c[1] + 0.38, c[2]]]), (t) => 0.02 * (1 - t) + 0.006, { seg: [16, 6] }),
      )
      return { 'tint:accent': merge(mug, handle), 'paint:coffee': coffee, 'paint:foam': foam, 'paint:white': merge(steam) }
    },
  },
  'prop-book': {
    label: 'Book',
    build: () => {
      const c = [-0.04, 0.08, 0.13]
      const q = quatFromEuler(0, -0.25, 0.08)
      const place = (s) => transform(s, { r: q, t: c })
      const cover = merge(
        roundedBox({ size: [0.27, 0.34, 0.018], radius: 0.008, seg: 2, c: [0, 0, 0.04] }),
        roundedBox({ size: [0.27, 0.34, 0.018], radius: 0.008, seg: 2, c: [0, 0, -0.04] }),
        roundedBox({ size: [0.03, 0.34, 0.098], radius: 0.014, seg: 3, c: [0.125, 0, 0] }),
      )
      const pages = roundedBox({ size: [0.25, 0.32, 0.065], radius: 0.01, seg: 2, c: [-0.005, 0, 0] })
      const label = roundedBox({ size: [0.14, 0.05, 0.008], radius: 0.004, seg: 2, c: [-0.01, 0.07, 0.052] })
      const ribbon = tube(spline([[0.05, -0.16, 0.0], [0.06, -0.22, 0.01], [0.04, -0.27, 0.0]]), [0.006, 0.018], { seg: [10, 6], up: [0, 0, 1] })
      return { 'tint:accent': place(cover), 'paint:paper': place(pages), 'paint:gold': place(label), 'paint:ruby': place(ribbon) }
    },
  },
  'prop-laptop': {
    label: 'Laptop',
    build: () => {
      // Open toward the viewer, carried flat on the mitten.
      const c = [0.02, 0.0, 0.2]
      const tilt = quatFromEuler(0.08, 0, 0)
      const place = (s) => transform(s, { r: tilt, t: c })
      const base = roundedBox({ size: [0.44, 0.03, 0.3], radius: 0.012, seg: 2, c: [0, 0, 0] })
      const keys = roundedBox({ size: [0.36, 0.008, 0.14], radius: 0.004, seg: 1, c: [0, 0.016, -0.03] })
      const pad = roundedBox({ size: [0.12, 0.006, 0.06], radius: 0.004, seg: 1, c: [0, 0.016, 0.09] })
      const lidQ = quatFromEuler(-0.22, 0, 0)
      const lid = transform(roundedBox({ size: [0.44, 0.3, 0.022], radius: 0.012, seg: 2, c: [0, 0.15, 0] }), { r: lidQ, t: [0, 0.01, -0.15] })
      const screen = transform(roundedBox({ size: [0.39, 0.25, 0.006], radius: 0.006, seg: 1, c: [0, 0.155, 0.012] }), { r: lidQ, t: [0, 0.01, -0.15] })
      const lines = [0.2, 0.15, 0.1].map((y, i) => transform(roundedBox({ size: [0.22 - i * 0.05, 0.022, 0.004], radius: 0.006, seg: 1, c: [-0.06 + i * 0.025, y, 0.017] }), { r: lidQ, t: [0, 0.01, -0.15] }))
      const logo = transform(puffyStar({ outer: 0.05, inner: 0.024, depth: 0.012, c: [0.13, 0.06, 0.017] }), { r: lidQ, t: [0, 0.01, -0.15] })
      return { 'paint:silver': place(merge(base, lid)), 'paint:ink': place(merge(keys, pad)), 'paint:screen': place(screen), 'paint:white': place(merge(lines)), 'paint:star': place(logo) }
    },
  },
  'prop-wand': {
    label: 'Wand',
    build: () => {
      const tip = [-0.1, 0.44, 0.13]
      const stick = tube(spline([[0.02, -0.12, 0.05], [-0.04, 0.16, 0.09], tip]), (t) => 0.024 - 0.008 * t, { seg: [16, 8] })
      const band = transform(torus({ R: 0.024, r: 0.012, seg: [14, 6] }), { t: [-0.02, 0.1, 0.08], r: quatFromUp([-0.12, 0.56, 0.08]) })
      const star = puffyStar({ outer: 0.13, inner: 0.06, depth: 0.065, c: [tip[0] - 0.01, tip[1] + 0.1, tip[2]] })
      const sparkles = [sphere(0.025, [tip[0] + 0.14, tip[1] + 0.2, tip[2]], [8, 6]), sphere(0.018, [tip[0] - 0.15, tip[1] + 0.05, tip[2] + 0.02], [8, 6])]
      return { 'paint:ink': stick, 'paint:gold': band, 'paint:star': merge(star, ...sparkles) }
    },
  },
  'prop-magnifier': {
    label: 'Magnifier',
    build: () => {
      const handle = tube(spline([[0.01, -0.13, 0.06], [0, 0.0, 0.07], [-0.01, 0.15, 0.08]]), (t) => 0.034 - 0.006 * t, { seg: [12, 10] })
      const lensC = [-0.02, 0.31, 0.08]
      const rim = transform(torus({ R: 0.13, r: 0.026, seg: [40, 10] }), { t: lensC, r: quatFromEuler(Math.PI / 2, 0, 0) })
      const ferrule = frustum({ r0: 0.036, r1: 0.03, h: 0.05, c: [-0.012, 0.14, 0.08], seg: 16 })
      const lens = ellipsoid({ r: [0.115, 0.115, 0.015], c: lensC, seg: [24, 10] })
      return { 'paint:wood': handle, 'paint:gold': merge(rim, ferrule), 'paint:glass': lens }
    },
  },
  'prop-keypad': {
    label: 'Typing pad',
    build: () => {
      // A small keyboard tablet held up at an angle, keys toward the viewer (for typing into forms).
      const c = [-0.03, 0.06, 0.16]
      const q = quatFromEuler(-0.95, -0.2, 0.06)
      const place = (s) => transform(s, { r: q, t: c })
      const slab = roundedBox({ size: [0.34, 0.024, 0.22], radius: 0.014, seg: 2, c: [0, 0, 0] })
      const keys = []
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) {
          keys.push(roundedBox({ size: [0.05, 0.014, 0.042], radius: 0.006, seg: 1, c: [-0.12 + col * 0.06, 0.017, -0.06 + row * 0.052] }))
        }
      }
      const space = roundedBox({ size: [0.17, 0.014, 0.034], radius: 0.006, seg: 1, c: [0, 0.017, 0.09] })
      const lamp = sphere(0.012, [0.14, 0.02, -0.09], [8, 6])
      return { 'tint:accent': place(slab), 'paint:white': place(merge(...keys, space)), 'paint:emerald': place(lamp) }
    },
  },
  'prop-balloon': {
    label: 'Balloon',
    build: () => {
      const top = [-0.3, 1.28, -0.02]
      const string = tube(spline([[0, -0.08, 0.06], [-0.06, 0.3, 0.05], [-0.2, 0.7, 0.02], [-0.24, 1.0, 0], top]), 0.009, { seg: [40, 6] })
      const pts = []
      for (let i = 0; i <= 24; i++) {
        const a = Math.PI * (i / 24)
        // Teardrop: fuller at the top, narrowing to the knot.
        const r = 0.27 * Math.sin(a) * (1 - 0.18 * Math.cos(a))
        const y = -0.31 * Math.cos(a)
        pts.push([i === 0 || i === 24 ? 0 : r, y])
      }
      const body = lathe([pts], 36, { c: [top[0], top[1] + 0.33, top[2]] })
      const knot = lathe([[[0, -0.03], [0.035, -0.02], [0.012, 0.03], [0, 0.035]]], 12, { c: [top[0], top[1] + 0.01, top[2]] })
      return { 'paint:balloon': merge(body, knot), 'paint:string': string }
    },
  },
}
