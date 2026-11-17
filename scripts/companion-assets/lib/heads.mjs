/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// The six heads. Each is a signed distance field around the neck point,
// meshed by marching rays from an interior centre. The face surface is a
// planar projection onto the head front, so the SVG layout reads exactly as
// drawn from the camera. Every head also exposes a "frame": an ellipsoid
// fitted to its cranium that hair, hats, ears and ear accessories are
// modelled against (a unit sphere in part space).

import { FACE } from './face-layout.mjs'
import { emptyShape, radialSdf, rayToSurface, sdEllipsoid, smin } from './geometry.mjs'
import { clamp, length, normalize, TAU } from './math.mjs'

function sdRoundCone(p, base, r1, r2, h) {
  const b = (r1 - r2) / h
  const a = Math.sqrt(1 - b * b)
  const qx = Math.hypot(p[0] - base[0], p[2] - base[2])
  const qy = p[1] - base[1]
  const k = -b * qx + a * qy
  if (k < 0) return Math.hypot(qx, qy) - r1
  if (k > a * h) return Math.hypot(qx, qy - h) - r2
  return qx * a + qy * b - r1
}

function sdSuperquadric(p, c, r, n, m) {
  const x = Math.abs(p[0] - c[0]) / r[0]
  const y = Math.abs(p[1] - c[1]) / r[1]
  const z = Math.abs(p[2] - c[2]) / r[2]
  const f = Math.pow(Math.pow(x, n) + Math.pow(y, n), m / n) + Math.pow(z, m)
  return (Math.pow(f, 1 / m) - 1) * Math.min(...r) * 0.9
}

const DEFS = {
  'head-round': {
    label: 'Round',
    center: [0, 0.58, 0],
    face: { width: 1.3, eyeY: 0.5 },
    sdf: (p) => {
      let d = sdEllipsoid(p, [0, 0.58, 0], [0.63, 0.6, 0.58])
      for (const sx of [-1, 1]) d = smin(d, sdEllipsoid(p, [sx * 0.27, 0.34, 0.2], [0.32, 0.26, 0.32]), 0.12)
      return d
    },
  },
  'head-oval': {
    label: 'Oval',
    center: [0, 0.66, 0],
    face: { width: 1.2, eyeY: 0.56 },
    sdf: (p) => {
      // Egg: a little narrower at the crown than at the cheeks.
      const t = clamp((p[1] - 0.66) / 0.68, -1, 1)
      const w = 1 - 0.09 * t
      return sdEllipsoid([p[0] / w, p[1], p[2] / w], [0, 0.66, 0], [0.54, 0.68, 0.55]) * w
    },
  },
  'head-soft-square': {
    label: 'Soft square',
    center: [0, 0.56, 0],
    face: { width: 1.3, eyeY: 0.49 },
    sdf: (p) => sdSuperquadric(p, [0, 0.56, 0], [0.62, 0.57, 0.56], 3.1, 2.4),
  },
  'head-drop': {
    label: 'Drop',
    center: [0, 0.66, 0],
    face: { width: 1.22, eyeY: 0.5 },
    sdf: (p) => sdRoundCone([p[0], p[1], p[2] / 0.95], [0, 0.56, 0], 0.57, 0.09, 0.66),
  },
  'head-bean': {
    label: 'Bean',
    center: [0, 0.48, 0],
    face: { width: 1.4, eyeY: 0.47 },
    sdf: (p) => smin(sdEllipsoid(p, [-0.23, 0.48, 0], [0.46, 0.49, 0.55]), sdEllipsoid(p, [0.23, 0.48, 0], [0.46, 0.49, 0.55]), 0.17),
  },
  'head-cloud': {
    label: 'Cloud',
    center: [0, 0.56, 0],
    face: { width: 1.3, eyeY: 0.49 },
    sdf: (() => {
      // Puffs ring the silhouette and the back; the face stays smooth.
      const puffs = []
      for (const deg of [0, 42, -42, 84, -84, 124, -124]) {
        const a = (deg * Math.PI) / 180
        puffs.push({ c: [0.43 * Math.sin(a), 0.56 + 0.4 * Math.cos(a), -0.08], r: deg === 0 ? 0.26 : 0.24 })
      }
      for (const deg of [0, 70, -70, 180]) {
        const a = (deg * Math.PI) / 180
        puffs.push({ c: [0.28 * Math.sin(a), 0.58 + 0.24 * Math.cos(a), -0.24], r: 0.24 })
      }
      return (p) => {
        let d = sdEllipsoid(p, [0, 0.55, 0.02], [0.57, 0.53, 0.56])
        for (const puff of puffs) d = smin(d, length([p[0] - puff.c[0], p[1] - puff.c[1], p[2] - puff.c[2]]) - puff.r, 0.05)
        return d
      }
    })(),
  },
}

function gradient(sdf, p, e = 1e-4) {
  return normalize([
    sdf([p[0] + e, p[1], p[2]]) - sdf([p[0] - e, p[1], p[2]]),
    sdf([p[0], p[1] + e, p[2]]) - sdf([p[0], p[1] - e, p[2]]),
    sdf([p[0], p[1], p[2] + e]) - sdf([p[0], p[1], p[2] - e]),
  ])
}

/** Front surface point seen along -Z at (x, y), or null when the ray misses. */
function frontHit(sdf, x, y) {
  let prev = 1.6
  if (sdf([x, y, prev]) < 0) return null
  for (let z = 1.6; z > -0.4; z -= 0.01) {
    if (sdf([x, y, z]) < 0) {
      let lo = z, hi = prev
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2
        if (sdf([x, y, mid]) < 0) lo = mid
        else hi = mid
      }
      return [x, y, (lo + hi) / 2]
    }
    prev = z
  }
  return null
}

/** Face surface: 512×256 canvas projected onto the head front, nudged just outside it. */
function faceMesh(def, layout) {
  const { width, height, x0, y0 } = layout
  const nu = 28, nv = 14
  const verts = []
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv
      const hit = frontHit(def.sdf, x0 + u * width, y0 + v * height)
      if (!hit) {
        verts.push(null)
        continue
      }
      const n = gradient(def.sdf, hit)
      verts.push(n[2] > 0.28 ? { p: hit.map((c, k) => c + n[k] * 0.012), n, uv: [u, v] } : null)
    }
  }
  const shape = emptyShape()
  const index = new Map()
  const vid = (k) => {
    if (!index.has(k)) {
      const v = verts[k]
      index.set(k, shape.pos.length / 3)
      shape.pos.push(...v.p)
      shape.nrm.push(...v.n)
      shape.uv.push(...v.uv)
    }
    return index.get(k)
  }
  const row = nu + 1
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row
      if (verts[a] && verts[b] && verts[c] && verts[d]) shape.idx.push(vid(a), vid(b), vid(c), vid(a), vid(c), vid(d))
    }
  }
  return shape
}

/** Samples surface points of the head (rays from its centre). */
function sampleSurface(def, n = 48) {
  const pts = []
  for (let j = 1; j < n; j++) {
    const th = (Math.PI * j) / n
    for (let i = 0; i < n * 2; i++) {
      const ph = (TAU * i) / (n * 2)
      const d = [Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)]
      const r = rayToSurface(def.sdf, def.center, d, 2.5)
      pts.push([def.center[0] + d[0] * r, def.center[1] + d[1] * r, def.center[2] + d[2] * r])
    }
  }
  return pts
}

/**
 * Cranium frame: centre and radii of an ellipsoid that encloses the head
 * everywhere except the lower front (the face and chin), where hair and hats
 * never go. Parts are modelled against the unit sphere in this frame.
 */
function craniumFrame(def, pts) {
  const c = def.center
  const region = pts.filter((p) => p[1] > c[1] - 0.25 || p[2] < 0.05)
  const rx = Math.max(...region.map((p) => Math.abs(p[0] - c[0])))
  const ry = Math.max(...region.filter((p) => p[1] >= c[1]).map((p) => p[1] - c[1]))
  const rz = Math.max(...region.map((p) => Math.abs(p[2] - c[2])))
  // Inflate a little toward enclosing corners and puffs; hair and hat shells
  // are thick enough to cover the rest, and the fit checks catch what is not.
  let k = 1
  for (const p of region) {
    if (p[1] < c[1] - 0.05) continue
    const q = [(p[0] - c[0]) / rx, (p[1] - c[1]) / ry, (p[2] - c[2]) / rz]
    k = Math.max(k, length(q))
  }
  k = Math.min(Math.max(1, k - 0.06), 1.06)
  return { c, r: [rx * k, ry * k, rz * k] }
}

export function buildHead(id) {
  const def = DEFS[id]
  const width = def.face.width
  const height = width / 2
  // Place the canvas so the eye line (canvas y = 112) lands on eyeY.
  const eyeV = 1 - FACE.eyeY / FACE.height
  const y0 = def.face.eyeY - eyeV * height
  const layout = { width, height, x0: -width / 2, y0 }
  const head = radialSdf(def.sdf, { c: def.center, n: 16, rMax: 2.5 })
  const face = faceMesh(def, layout)
  const pts = sampleSurface(def)
  const frame = craniumFrame(def, pts)

  const canvasToWorld = (cx, cy) => [layout.x0 + (cx / FACE.width) * width, y0 + (1 - cy / FACE.height) * height]
  const eyeL = canvasToWorld(FACE.eyeLeftX, FACE.eyeY)
  const eyeR = canvasToWorld(FACE.eyeRightX, FACE.eyeY)
  const hitL = frontHit(def.sdf, eyeL[0], eyeL[1])
  const hitR = frontHit(def.sdf, eyeR[0], eyeR[1])
  const eyeZ = (hitL[2] + hitR[2]) / 2
  const anchors = {
    hat: { t: frame.c, s: frame.r },
    hair: { t: frame.c, s: frame.r },
    ears: { t: frame.c, s: frame.r },
    earAccessory: { t: frame.c, s: frame.r },
    // Glasses are modelled for a 1.3-wide face; scale keeps them on the eyes.
    eyeAccessory: { t: [0, def.face.eyeY, eyeZ], s: width / 1.3 },
  }
  return { id, label: def.label, sdf: def.sdf, center: def.center, head, face, frame, anchors, layout, surfacePoints: pts }
}
