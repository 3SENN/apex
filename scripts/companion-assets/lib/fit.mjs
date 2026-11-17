/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Geometric fit checks between heads and the parts modelled in frame space.
// They decide hair compatibility and the per-head (and per-hair) seats of
// everything worn over the head, so the configs follow the geometry instead
// of being tuned by hand.

import { rayToSurface } from './geometry.mjs'
import { clamp, round, TAU } from './math.mjs'
import { dir } from './shell.mjs'

/** Head surface samples in the head's frame space (the unit sphere ≈ the cranium). */
export function framePoints(head) {
  const { c, r } = head.frame
  return head.surfacePoints.map((p) => {
    const q = [(p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]]
    const len = Math.hypot(q[0], q[1], q[2])
    return { q, len, az: Math.atan2(q[0], q[2]), el: Math.asin(clamp(q[1] / len, -1, 1)) }
  })
}

/**
 * Outer radius of a hair style's covering mass toward (az, el) in frame
 * units, or 0 where it has none. Spikes, tufts and buns are left out on
 * purpose: they poke through what is worn over them.
 */
export function hairRadius(hair, az, el) {
  let best = 0
  for (const sh of hair?.shells ?? []) {
    if (el >= sh.edge(az)) best = Math.max(best, 1 + sh.thick(az, el) + (hair.puff ?? 0))
  }
  return best
}

/** Samples of a hair style's outer surface, shaped like framePoints. */
function hairPoints(hair) {
  const out = []
  if (!hair?.shells) return out
  for (let i = 0; i < 48; i++) {
    for (let j = 0; j <= 18; j++) {
      const az = -Math.PI + (TAU * (i + 0.5)) / 48
      const el = -0.7 + ((Math.PI / 2 - 0.02 + 0.7) * j) / 18
      const len = hairRadius(hair, az, el)
      if (len > 0) out.push({ q: dir(az, el).map((v) => v * len), len, az, el })
    }
  }
  return out
}

/** Inside/outside test in frame space for the head, plus the hair's mass when one is worn (only the sign matters). */
function wornSdf(head, hair) {
  const { c, r } = head.frame
  const sdf = (q) => head.sdf([c[0] + q[0] * r[0], c[1] + q[1] * r[1], c[2] + q[2] * r[2]])
  if (!hair?.shells) return sdf
  return (q) => {
    const len = Math.hypot(q[0], q[1], q[2])
    if (len < 1e-6) return -1
    const R = hairRadius(hair, Math.atan2(q[0], q[2]), Math.asin(clamp(q[1] / len, -1, 1)))
    return Math.min(sdf(q), R > 0 ? len - R : Infinity)
  }
}

/**
 * How far the head pokes out of a cap shell (frame units; negative means it
 * stays inside). Only points well inside the covered area count: at the
 * rim the shell rolls into the head on purpose.
 */
function shellPenetration(points, shell, { scale = 1, offset = [0, 0, 0] } = {}) {
  let worst = -Infinity
  for (const p of points) {
    const q = [(p.q[0] - offset[0]) / scale, (p.q[1] - offset[1]) / scale, (p.q[2] - offset[2]) / scale]
    const len = Math.hypot(q[0], q[1], q[2])
    const az = Math.atan2(q[0], q[2])
    const el = Math.asin(clamp(q[1] / len, -1, 1))
    if (el < shell.edge(az) + 0.12) continue
    worst = Math.max(worst, (len - (1 + shell.thick(az, el))) * scale)
  }
  return worst
}

/** Mean of the average and widest horizontal radius of a frame-space solid at height y. */
function crossSection(sdf, y) {
  if (sdf([0, y, 0]) >= 0) return 0
  let sum = 0, max = 0
  const n = 32
  for (let i = 0; i < n; i++) {
    const az = (TAU * i) / n
    const d = rayToSurface(sdf, [0, y, 0], [Math.sin(az), 0, Math.cos(az)], 2.5, 30)
    sum += d
    max = Math.max(max, d)
  }
  return (sum / n + max) / 2
}

/** Vertical shift that seats a ring modelled at height y (on the unit sphere) on a frame-space solid. */
function ringOffset(sdf, y, limit) {
  const target = Math.sqrt(1 - y * y)
  // The cross-section shrinks toward the top: find where it matches the ring.
  let lo = -0.3, hi = 1.6
  if (crossSection(sdf, hi) >= target) return clamp(hi - y, -0.3, limit)
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (crossSection(sdf, mid) > target) lo = mid
    else hi = mid
  }
  return clamp((lo + hi) / 2 - y, -0.3, limit)
}

/**
 * How much a band (a headphone arc) must grow about the frame centre to
 * clear the head and hair along its whole path. Never shrinks it, so the
 * cups stay outside the head.
 */
function bandScale(sdf, fit) {
  let s = 1
  for (let i = 0; i <= 24; i++) {
    const p = fit.path(i / 24)
    const len = Math.hypot(p[0], p[1], p[2])
    const d = p.map((v) => v / len)
    const surface = rayToSurface(sdf, [0, 0, 0], d, 2.5, 30)
    s = Math.max(s, (surface + fit.clearance) / (len - fit.half))
  }
  return Math.min(s, 1.3)
}

/**
 * Adjustment for a part worn over the head (a hat or headphones) on this
 * head, optionally over a hair style: rings are seated, shells grow until
 * head and hair are covered, bands grow until they clear both.
 */
export function hatAdjustment(head, points, fit, hair = null) {
  const adj = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }
  if (fit.type === 'ring') {
    // Hair can lift a ring well above the bare head's seat.
    adj.offset[1] = ringOffset(wornSdf(head, hair), fit.y, hair?.shells ? 0.6 : 0.3)
  } else if (fit.type === 'shell') {
    const all = hair?.shells ? [...points, ...hairPoints(hair)] : points
    let s = 1
    for (let i = 0; i < 14; i++) {
      const pen = Math.max(...fit.shells.map((sh) => shellPenetration(all, sh, { scale: s })))
      if (pen <= -0.01) break
      s += 0.02
    }
    adj.scale = Math.min(s, 1.28)
  } else if (fit.type === 'band') {
    adj.scale = bandScale(wornSdf(head, hair), fit)
  }
  return { offset: adj.offset.map((v) => round(v, 3)), rotation: adj.rotation, scale: round(adj.scale, 3) }
}

// The band along a shell hat's lower edge, at the front, where its brim or
// cuff sits: azimuth from the face, and elevation below and above the edge.
const FRINGE = { az: 1.2, below: 0.05, above: 0.4 }

/**
 * How far a hair style's geometry (frame-space positions) stands out of a
 * shell hat worn at `scale`, along the front edge where the brim or cuff
 * sits. Frame units; negative means it stays under the crown. Elsewhere hair
 * may leave a shell hat on purpose: pigtails at the sides, a bun through the
 * back, a tuft into the pom.
 */
export function fringeClearance(positions, shells, scale) {
  let worst = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const q = [positions[i], positions[i + 1], positions[i + 2]]
    const len = Math.hypot(q[0], q[1], q[2])
    const az = Math.atan2(q[0], q[2])
    if (len < 1e-6 || Math.abs(az) > FRINGE.az) continue
    const el = Math.asin(clamp(q[1] / len, -1, 1))
    for (const sh of shells) {
      const edge = sh.edge(az)
      if (el < edge - FRINGE.below || el > edge + FRINGE.above) continue
      worst = Math.max(worst, len - (1 + sh.thick(az, Math.max(el, edge))) * scale)
    }
  }
  return worst
}

/** Whether two adjustments place a part visibly differently. */
export function sameAdjustment(a, b) {
  return a.scale === b.scale && a.offset.every((v, i) => Math.abs(v - b.offset[i]) < 0.006) && a.rotation.every((v, i) => v === b.rotation[i])
}

/** Whether a hair style fits a head: its caps must cover the head where they are drawn. */
export function hairFits(points, hair, tolerance = 0.012) {
  if (!hair.shells) return { ok: true, penetration: null }
  const penetration = Math.max(...hair.shells.map((sh) => shellPenetration(points, sh)))
  return { ok: penetration <= tolerance, penetration: round(penetration, 3) }
}
