/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Procedural animation clips. Each clip is a pure function of phase
// p = t / duration that returns, per rig node, a translation offset from
// rest, an absolute Euler rotation (XYZ) and a scale factor. Looping clips
// use whole-number frequencies of p so they are seamless; one-shots start
// and end exactly at rest.

import { ease, lerp, TAU } from './math.mjs'

const w = (p, k = 1, ph = 0) => Math.sin(TAU * (k * p + ph))
/** sin² bump over (a, b), zero outside. */
const bump = (p, a, b) => (p <= a || p >= b ? 0 : Math.sin((Math.PI * (p - a)) / (b - a)) ** 2)
/** Eased 0 → 1 → 0 envelope: rises over [a, b], holds, falls over [c, d]. */
const env = (p, a, b, c, d) => (p <= a || p >= d ? 0 : p < b ? ease.inOutSine((p - a) / (b - a)) : p > c ? ease.inOutSine((d - p) / (d - c)) : 1)
/** 0 → 1 over (a, b) as a half sine, for airborne arcs. */
const arc = (p, a, b) => (p <= a || p >= b ? 0 : Math.sin((Math.PI * (p - a)) / (b - a)))

/** Arm rotations as [x, y, outward]; outward > 0 swings the hand away from the body. */
const arms = (rig, l, r) => ({
  'arm.L': { r: [l[0], l[1], l[2]] },
  'arm.R': { r: [r[0], -r[1], -r[2]] },
})
const squash = (amount, bulge = 0.6) => [1 + amount * bulge, 1 - amount, 1 + amount * bulge]

export const CLIP_DEFS = {
  idle: {
    duration: 4,
    pose(p, rig) {
      const breath = w(p, 2)
      const sway = w(p, 1)
      const out = rig.armOut
      return {
        body: { t: [0, 0.008 * breath, 0], r: [0.012 * w(p, 2, 0.25), 0.03 * w(p, 1, 0.4), 0.03 * sway], s: [1 - 0.01 * breath, 1 + 0.022 * breath, 1 - 0.01 * breath] },
        'head-pivot': { r: [0.03 * w(p, 2, 0.1), 0.08 * w(p, 1, 0.2), -0.035 * sway + 0.02 * w(p, 2, 0.3)] },
        ...arms(rig, [0.05 * w(p, 1, 0.1), 0, out + 0.04 * breath + 0.015 * sway], [0.05 * w(p, 1, 0.6), 0, out + 0.04 * breath - 0.015 * sway]),
      }
    },
  },
  listen: {
    duration: 3,
    pose(p, rig) {
      const nod = 0.08 * bump(p, 0.18, 0.4) + 0.07 * bump(p, 0.62, 0.84)
      return {
        body: { t: [0, 0.006 * w(p, 2), 0.02], r: [0.1 + 0.015 * w(p, 1), 0.04 * w(p, 1, 0.2), 0.02 * w(p, 1, 0.25)], s: [1, 1 + 0.012 * w(p, 2), 1] },
        'head-pivot': { r: [0.04 + nod, 0.06 * w(p, 1, 0.4), 0.17 + 0.035 * w(p, 1)] },
        ...arms(rig, [-0.35 + 0.04 * w(p, 1), 0, rig.armOut + 0.04 + 0.02 * w(p, 2)], [-0.35 + 0.04 * w(p, 1, 0.5), 0, rig.armOut + 0.04 + 0.02 * w(p, 2, 0.5)]),
      }
    },
  },
  think: {
    duration: 3.5,
    pose(p, rig) {
      const tap = 0.06 * bump(p, 0.15, 0.3) + 0.06 * bump(p, 0.55, 0.7)
      return {
        body: { t: [0, 0.006 * w(p, 1), 0], r: [0.03, 0.12 + 0.03 * w(p, 1), -0.03 + 0.02 * w(p, 1, 0.3)], s: [1, 1 + 0.015 * w(p, 1), 1] },
        'head-pivot': { r: [-0.13 + 0.03 * w(p, 1), 0.16 + 0.05 * w(p, 1, 0.2), 0.12 + 0.05 * w(p, 1)] },
        'arm.R': { t: rig.think.t, r: [rig.think.r[0] + tap, rig.think.r[1], rig.think.r[2] + 0.03 * w(p, 1)] },
        'arm.L': { t: rig.hug.t, r: [rig.hug.r[0] + 0.03 * w(p, 1, 0.3), rig.hug.r[1], rig.hug.r[2]] },
      }
    },
  },
  work: {
    duration: 2,
    pose(p, rig) {
      const press = 0.5 - 0.5 * Math.cos(TAU * 4 * p)
      const tapR = bump(p, 0.15, 0.32) + bump(p, 0.65, 0.82)
      return {
        body: { t: [0, 0.014 * press, 0], r: [0.07, 0.02 * w(p, 1), 0.015 * w(p, 2)], s: squash(-0.02 * press + 0.01) },
        'head-pivot': { r: [0.17 + 0.025 * w(p, 4, 0.2), 0.05 * w(p, 1), 0.03 * w(p, 2)] },
        ...arms(
          rig,
          [-1.15 + 0.16 * w(p, 4) + 0.04 * w(p, 8), 0.1, -0.16 + 0.04 * w(p, 2)],
          [-1.15 + 0.16 * w(p, 4, 0.5) + 0.04 * w(p, 8, 0.5), 0.1, -0.16 + 0.04 * w(p, 2, 0.5)],
        ),
        'foot.R': { t: [0, 0.03 * tapR, 0], r: [-0.3 * tapR, 0, 0] },
      }
    },
  },
  talk: {
    duration: 3,
    pose(p, rig) {
      const g1 = env(p, 0.06, 0.18, 0.38, 0.5)
      const g2 = env(p, 0.52, 0.64, 0.82, 0.94)
      const beat = 0.5 - 0.5 * Math.cos(TAU * 3 * p)
      return {
        body: { t: [0, 0.01 * beat, 0], r: [0.02 * w(p, 3), 0.07 * w(p, 1, 0.15), 0.035 * w(p, 1)], s: [1 - 0.008 * beat, 1 + 0.018 * beat, 1 - 0.008 * beat] },
        'head-pivot': { r: [0.05 * w(p, 3) + 0.02 * w(p, 6, 0.1), 0.09 * w(p, 1, 0.1), 0.06 * w(p, 1, 0.35)] },
        ...arms(
          rig,
          [-0.95 * g1 + 0.03 * w(p, 2), 0.25 * g1, rig.armOut + 0.45 * g1 + 0.12 * g1 * w(p, 4)],
          [-1.0 * g2 + 0.03 * w(p, 2, 0.5), 0.25 * g2, rig.armOut + 0.55 * g2 + 0.12 * g2 * w(p, 4, 0.25)],
        ),
      }
    },
  },
  alert: {
    duration: 2,
    pose(p, rig) {
      const air = arc(p, 0.12, 0.42)
      const sq = 0.14 * bump(p, 0, 0.14) + 0.16 * bump(p, 0.4, 0.58) - 0.09 * air
      const up = 2.45 + 0.14 * w(p, 4) + 0.15 * air
      return {
        root: { t: [0, 0.17 * rig.hop * air, 0] },
        body: { r: [-0.04 * air, 0, 0.04 * w(p, 2)], s: squash(sq) },
        'head-pivot': { r: [-0.08 - 0.06 * air, 0.05 * w(p, 1), 0.07 * w(p, 2)] },
        ...arms(rig, [-0.15, 0, up], [-0.15, 0, up + 0.05 * w(p, 4, 0.5)]),
        'foot.L': { t: [0, 0.04 * air, 0], r: [0.35 * air, 0, 0] },
        'foot.R': { t: [0, 0.04 * air, 0], r: [0.35 * air, 0, 0] },
      }
    },
  },
  celebrate: {
    duration: 2.4,
    pose(p, rig) {
      const air = arc(p, 0.16, 0.56)
      const st = p > 0.16 && p < 0.56 ? Math.abs(Math.cos((Math.PI * (p - 0.16)) / 0.4)) : 0
      const sq = 0.2 * bump(p, 0, 0.18) + 0.18 * bump(p, 0.54, 0.72) + 0.07 * bump(p, 0.8, 0.96) - 0.13 * st * air ** 0.3
      const hopSmall = arc(p, 0.72, 0.84)
      const raise = env(p, 0.1, 0.22, 0.84, 1)
      const up = lerp(rig.armOut - 0.1, 2.35 + 0.3 * w(p, 3), raise)
      return {
        root: { t: [0, rig.hop * (0.4 * air + 0.06 * hopSmall), 0] },
        body: { r: [-0.05 * air, 0.28 * w(p, 1, 0.1) * air, 0.05 * w(p, 2)], s: squash(sq) },
        'head-pivot': { r: [-0.14 * air + 0.06 * bump(p, 0.55, 0.7), 0.06 * w(p, 1), 0.1 * w(p, 2)] },
        ...arms(rig, [-0.2 * raise, 0, up], [-0.2 * raise, 0, up + 0.1 * raise * w(p, 3, 0.5)]),
        'foot.L': { t: [0, 0.05 * air, 0], r: [0.4 * air, 0, 0] },
        'foot.R': { t: [0, 0.05 * air, 0], r: [0.4 * air, 0, 0] },
      }
    },
  },
  sad: {
    duration: 3.5,
    pose(p, rig) {
      const sigh = bump(p, 0.35, 0.8)
      return {
        body: { t: [0, -0.02 + 0.006 * w(p, 1), 0], r: [0.13 + 0.02 * w(p, 1) + 0.03 * sigh, 0, 0.015 * w(p, 1, 0.3)], s: [1.02, 0.955 + 0.01 * w(p, 1) - 0.03 * sigh, 1.02] },
        'head-pivot': { r: [0.3 + 0.03 * w(p, 1, 0.2) + 0.06 * sigh, -0.06, 0.1 + 0.02 * w(p, 1)] },
        ...arms(rig, [0.12 + 0.03 * w(p, 1), 0, rig.armOut * 0.3], [0.12 + 0.03 * w(p, 1, 0.5), 0, rig.armOut * 0.3]),
      }
    },
  },
  sleep: {
    duration: 4,
    pose(p, rig) {
      const b = w(p, 1)
      return {
        body: { t: [0, -0.02 + 0.01 * b, 0], r: [0.1, 0, 0.05 + 0.012 * b], s: [1 - 0.012 * b, 1 + 0.035 * b, 1 - 0.012 * b] },
        'head-pivot': { r: [0.36 + 0.035 * b, 0.05, 0.26 + 0.02 * w(p, 1, 0.25)] },
        ...arms(rig, [0.05, 0, rig.armOut * 0.5 + 0.03 * b], [0.05, 0, rig.armOut * 0.5 + 0.03 * b]),
      }
    },
  },
  wave: {
    duration: 1.4,
    pose(p, rig) {
      const up = env(p, 0, 0.22, 0.8, 1)
      const q = (p - 0.22) / 0.58
      const wave = p > 0.22 && p < 0.8 ? Math.sin(TAU * 3 * q) * Math.sin(Math.PI * q) ** 0.5 : 0
      return {
        root: { t: [0, 0.03 * rig.hop * bump(p, 0.02, 0.24), 0] },
        body: { r: [0, -0.1 * up, -0.07 * up], s: squash(0.05 * bump(p, 0.0, 0.12) - 0.03 * bump(p, 0.12, 0.3)) },
        'head-pivot': { r: [-0.05 * up, -0.1 * up, 0.12 * up + 0.03 * wave] },
        ...arms(rig, [0, 0, rig.armOut + 0.14 * up], [-0.25 * up, 0, lerp(rig.armOut, 2.5, up) + 0.38 * wave]),
      }
    },
  },
  poke: {
    duration: 1.1,
    pose(p, rig) {
      const t = p * 1.1
      const fade = 1 - ease.inOutSine((p - 0.75) / 0.25) * (p > 0.75 ? 1 : 0)
      const sq = t < 0.07 ? 0.22 * ease.outQuad(t / 0.07) : 0.22 * Math.exp(-(t - 0.07) / 0.17) * Math.cos(TAU * 3.2 * (t - 0.07))
      const wob = 0.13 * Math.exp(-t / 0.28) * Math.sin(TAU * 2.6 * t)
      const back = bump(p, 0.02, 0.45)
      const flail = bump(p, 0.02, 0.5)
      return {
        root: { t: [0, 0.05 * rig.hop * bump(p, 0.08, 0.32), 0] },
        body: { r: [-0.16 * back, 0, wob * fade], s: squash(sq * fade) },
        'head-pivot': { r: [-0.1 * back, 0.05 * flail, -0.8 * wob * fade] },
        ...arms(rig, [-0.2 * flail, 0, rig.armOut + 0.7 * flail], [-0.2 * flail, 0, rig.armOut + 0.75 * flail]),
      }
    },
  },
}
