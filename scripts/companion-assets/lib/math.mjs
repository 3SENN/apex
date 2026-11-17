/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Small vector, quaternion and easing helpers shared by the generator.
// Plain arrays everywhere so the output is easy to inspect and deterministic.

export const TAU = Math.PI * 2

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const lerp = (a, b, t) => a + (b - a) * t
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const length = (a) => Math.hypot(a[0], a[1], a[2])
export const normalize = (a) => {
  const l = length(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0]
}

/** Quaternion [x, y, z, w] from Euler angles applied in three.js 'XYZ' order. */
export function quatFromEuler(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]
}

function quatFromAxisAngle(axis, angle) {
  const [x, y, z] = normalize(axis)
  const s = Math.sin(angle / 2)
  return [x * s, y * s, z * s, Math.cos(angle / 2)]
}

export function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q
  const ix = qw * v[0] + qy * v[2] - qz * v[1]
  const iy = qw * v[1] + qz * v[0] - qx * v[2]
  const iz = qw * v[2] + qx * v[1] - qy * v[0]
  const iw = -qx * v[0] - qy * v[1] - qz * v[2]
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ]
}

/** Rotation that turns +Y onto `dir`. */
export function quatFromUp(dir) {
  const d = normalize(dir)
  const c = d[1]
  if (c > 0.999999) return [0, 0, 0, 1]
  if (c < -0.999999) return [1, 0, 0, 0]
  return quatFromAxisAngle(cross([0, 1, 0], d), Math.acos(c))
}

// ---- easing ----

export const ease = {
  inOutSine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1)),
  outQuad: (t) => 1 - (1 - clamp(t, 0, 1)) ** 2,
}

/** Rounds to a fixed number of decimals so JSON output stays tidy and stable. */
export const round = (v, digits = 4) => {
  const f = 10 ** digits
  const r = Math.round(v * f) / f
  return Object.is(r, -0) ? 0 : r
}
