/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Procedural geometry. A shape is { pos, nrm, uv, idx } with flat number
// arrays, built from parametric grids so every primitive shares one code
// path for indexing, winding and smooth normals.

import { add, cross, dot, length, normalize, quatRotate, sub, TAU } from './math.mjs'

export const emptyShape = () => ({ pos: [], nrm: [], uv: [], idx: [] })

const key = (x, y, z) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`

/** Smooth normals: area-weighted face normals summed per position, so seams and poles stay smooth. */
function computeNormals(shape) {
  const { pos, idx } = shape
  const groups = new Map()
  const vertKey = []
  for (let i = 0; i < pos.length / 3; i++) {
    const k = key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
    vertKey.push(k)
    if (!groups.has(k)) groups.set(k, [0, 0, 0])
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2]
    const pa = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]]
    const pb = [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]]
    const pc = [pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]]
    const n = cross(sub(pb, pa), sub(pc, pa))
    for (const v of [a, b, c]) {
      const g = groups.get(vertKey[v])
      g[0] += n[0]
      g[1] += n[1]
      g[2] += n[2]
    }
  }
  shape.nrm = []
  for (let i = 0; i < vertKey.length; i++) shape.nrm.push(...normalize(groups.get(vertKey[i])))
  return shape
}

function signedVolume(shape) {
  const { pos, idx } = shape
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    v += dot([pos[a], pos[a + 1], pos[a + 2]], cross([pos[b], pos[b + 1], pos[b + 2]], [pos[c], pos[c + 1], pos[c + 2]]))
  }
  return v / 6
}

function flip(shape) {
  for (let t = 0; t < shape.idx.length; t += 3) {
    const b = shape.idx[t + 1]
    shape.idx[t + 1] = shape.idx[t + 2]
    shape.idx[t + 2] = b
  }
  for (let i = 0; i < shape.nrm.length; i++) shape.nrm[i] = -shape.nrm[i]
  return shape
}

/**
 * Parametric grid surface. `fn(u, v)` returns a point for u, v in [0, 1].
 * Closed surfaces are wound outward by signed volume; open ones keep the
 * grid's winding (normal along dP/du × dP/dv) unless `facing` is given.
 */
export function surface(nu, nv, fn, { closed = true, facing = null, smooth = true } = {}) {
  const shape = emptyShape()
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv
      shape.pos.push(...fn(u, v))
      shape.uv.push(u, v)
    }
  }
  const row = nu + 1
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row
      pushQuad(shape, a, b, c, d)
    }
  }
  dropDegenerate(shape)
  if (closed && signedVolume(shape) < 0) flip(shape)
  if (facing) orientToward(shape, facing)
  if (smooth) computeNormals(shape)
  return shape
}

function pushQuad(shape, a, b, c, d) {
  shape.idx.push(a, b, c, a, c, d)
}

function dropDegenerate(shape) {
  const { pos, idx } = shape
  const out = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const n = cross(
      [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]],
      [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]],
    )
    if (length(n) > 1e-12) out.push(idx[t], idx[t + 1], idx[t + 2])
  }
  shape.idx = out
}

/** Flips an open surface so its average normal points along `dir`. */
function orientToward(shape, dir) {
  const { pos, idx } = shape
  let s = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const n = cross(
      [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]],
      [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]],
    )
    s += dot(n, dir)
  }
  if (s < 0) flip(shape)
}

// ---- transforms ----

/** Scale (per axis), then rotate (quaternion), then translate. Normals use the inverse-transpose. */
export function transform(shape, { t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1] } = {}) {
  const sc = typeof s === 'number' ? [s, s, s] : s
  const out = { pos: [], nrm: [], uv: shape.uv.slice(), idx: shape.idx.slice() }
  for (let i = 0; i < shape.pos.length; i += 3) {
    const p = quatRotate(r, [shape.pos[i] * sc[0], shape.pos[i + 1] * sc[1], shape.pos[i + 2] * sc[2]])
    out.pos.push(p[0] + t[0], p[1] + t[1], p[2] + t[2])
    const n = quatRotate(r, normalize([shape.nrm[i] / sc[0], shape.nrm[i + 1] / sc[1], shape.nrm[i + 2] / sc[2]]))
    out.nrm.push(...n)
  }
  if (sc[0] * sc[1] * sc[2] < 0) flip(out)
  return out
}

/** Applies an arbitrary point warp; normals are recomputed. */
export function warp(shape, fn) {
  const out = { pos: [], nrm: [], uv: shape.uv.slice(), idx: shape.idx.slice() }
  for (let i = 0; i < shape.pos.length; i += 3) out.pos.push(...fn([shape.pos[i], shape.pos[i + 1], shape.pos[i + 2]]))
  return computeNormals(out)
}

export const mirrorX = (shape) => transform(shape, { s: [-1, 1, 1] })

export function merge(...shapes) {
  const out = emptyShape()
  for (const s of shapes.flat()) {
    const base = out.pos.length / 3
    out.pos.push(...s.pos)
    out.nrm.push(...s.nrm)
    out.uv.push(...(s.uv.length === s.pos.length / 1.5 ? s.uv : new Array((s.pos.length / 3) * 2).fill(0)))
    for (const i of s.idx) out.idx.push(i + base)
  }
  return out
}

// ---- primitives ----

/** Ellipsoid with optional azimuth (phi, around Y from +Z) and polar (theta, from +Y) ranges. */
export function ellipsoid({ r = [1, 1, 1], c = [0, 0, 0], seg = [32, 20], phi = [0, TAU], theta = [0, Math.PI] } = {}) {
  const full = phi[1] - phi[0] >= TAU - 1e-9 && theta[0] <= 1e-9 && theta[1] >= Math.PI - 1e-9
  return surface(seg[0], seg[1], (u, v) => {
    const p = phi[0] + (phi[1] - phi[0]) * u
    const th = theta[1] - (theta[1] - theta[0]) * v
    return [c[0] + r[0] * Math.sin(th) * Math.sin(p), c[1] + r[1] * Math.cos(th), c[2] + r[2] * Math.sin(th) * Math.cos(p)]
  }, { closed: full })
}

export const sphere = (radius, c = [0, 0, 0], seg = [24, 16]) => ellipsoid({ r: [radius, radius, radius], c, seg })

/**
 * Surface of revolution around +Y. `segments` is a list of polylines of
 * [radius, y] points; each becomes its own grid so corners between them stay
 * crisp. Walk the profile counter-clockwise around the solid's cross-section.
 */
export function lathe(segments, n = 32, { phi = [0, TAU], c = [0, 0, 0] } = {}) {
  const full = phi[1] - phi[0] >= TAU - 1e-9
  const parts = segments.map((profile) =>
    surface(n, profile.length - 1, (u, v) => {
      const p = phi[0] + (phi[1] - phi[0]) * u
      const k = Math.round(v * (profile.length - 1))
      const [r, y] = profile[k]
      return [c[0] + r * Math.sin(p), c[1] + y, c[2] + r * Math.cos(p)]
    }, { closed: false }),
  )
  const shape = merge(parts)
  const first = segments[0][0], last = segments[segments.length - 1].at(-1)
  if (full && first[0] === 0 && last[0] === 0 && signedVolume(shape) < 0) return flip(shape)
  return shape
}

/** Samples a profile function f(t) → [r, y] for t in [0, 1]. */
export const profile = (f, steps) => Array.from({ length: steps + 1 }, (_, i) => f(i / steps))

export function capsule({ radius = 0.5, height = 1, c = [0, 0, 0], seg = [24, 8] } = {}) {
  const half = height / 2
  const pts = []
  for (let i = 0; i <= seg[1]; i++) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / seg[1])
    pts.push([radius * Math.cos(a), -half + radius * Math.sin(a)])
  }
  for (let i = 0; i <= seg[1]; i++) {
    const a = (Math.PI / 2) * (i / seg[1])
    pts.push([radius * Math.cos(a), half + radius * Math.sin(a)])
  }
  pts[0][0] = 0
  pts[pts.length - 1][0] = 0
  return lathe([pts], seg[0], { c })
}

/** Cylinder / cone / frustum along +Y with flat caps; set a radius to 0 for a cone. */
export function frustum({ r0 = 0.5, r1 = 0.5, h = 1, y0 = 0, c = [0, 0, 0], seg = 24, rings = 1 } = {}) {
  const side = profile((t) => [r0 + (r1 - r0) * t, y0 + h * t], rings)
  const segs = []
  if (r0 > 0) segs.push([[0, y0], [r0, y0]])
  segs.push(side)
  if (r1 > 0) segs.push([[r1, y0 + h], [0, y0 + h]])
  return lathe(segs, seg, { c })
}

/** Rounded box centred at the origin with true circular edge rounding. */
export function roundedBox({ size = [1, 1, 1], radius = 0.1, seg = 4, flat = 2, c = [0, 0, 0] } = {}) {
  const h = size.map((s) => s / 2)
  const rad = Math.min(radius, ...h)
  const axisCoords = (half) => {
    const inner = half - rad
    const out = []
    for (let i = 0; i <= seg; i++) out.push(-half + (rad * i) / seg)
    for (let i = 1; i < flat; i++) out.push(-inner + (2 * inner * i) / flat)
    for (let i = 0; i <= seg; i++) out.push(inner + (rad * i) / seg)
    return out
  }
  const coords = h.map(axisCoords)
  const faces = [
    [0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1],
  ]
  const parts = faces.map(([n, a, b, sgn]) => {
    const ca = coords[a], cb = coords[b]
    const grid = emptyShape()
    for (let j = 0; j < cb.length; j++) {
      for (let i = 0; i < ca.length; i++) {
        const q = [0, 0, 0]
        q[n] = sgn * h[n]
        q[a] = ca[i]
        q[b] = cb[j]
        const inner = q.map((v, k) => Math.max(-(h[k] - rad), Math.min(h[k] - rad, v)))
        const nn = normalize(sub(q, inner))
        const p = add(inner, nn.map((v) => v * rad))
        grid.pos.push(p[0] + c[0], p[1] + c[1], p[2] + c[2])
        grid.nrm.push(...nn)
        grid.uv.push(i / (ca.length - 1), j / (cb.length - 1))
      }
    }
    const row = ca.length
    for (let j = 0; j < cb.length - 1; j++) {
      for (let i = 0; i < row - 1; i++) {
        const a0 = j * row + i
        if (sgn > 0) grid.idx.push(a0, a0 + 1, a0 + row + 1, a0, a0 + row + 1, a0 + row)
        else grid.idx.push(a0, a0 + row + 1, a0 + 1, a0, a0 + row, a0 + row + 1)
      }
    }
    return grid
  })
  // The face winding above is outward and the normals are analytic.
  return merge(parts)
}

/** Unit directions on a cube-sphere (even spacing, no pole pinching). */
function cubeSphereGrid(n, fn) {
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ]
  const parts = faces.map(([N, U, V]) =>
    surface(n, n, (u, v) => {
      const a = Math.tan((Math.PI / 4) * (u * 2 - 1))
      const b = Math.tan((Math.PI / 4) * (v * 2 - 1))
      return fn(normalize([N[0] + a * U[0] + b * V[0], N[1] + a * U[1] + b * V[1], N[2] + a * U[2] + b * V[2]]))
    }, { closed: false, smooth: false }),
  )
  const shape = merge(parts)
  if (signedVolume(shape) < 0) flip(shape)
  return computeNormals(shape)
}

/** Star-shaped solid: `rFn(dir)` is the distance from `c` to the surface along unit `dir`. */
const radial = (rFn, { c = [0, 0, 0], n = 16 } = {}) => cubeSphereGrid(n, (d) => add(c, d.map((v) => v * rFn(d))))

/**
 * Star-shaped solid sampled on a latitude/longitude grid whose pole axis is
 * +Z (`azimuth` runs in the XY plane), handy for flat badges such as stars.
 */
function radialLatLong(rFn, { c = [0, 0, 0], nu = 40, nv = 12 } = {}) {
  return surface(nu, nv, (u, v) => {
    const az = TAU * u
    const el = Math.PI * v - Math.PI / 2
    const d = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]
    const r = rFn(d)
    return [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r]
  })
}

/** Distance along `dir` from `origin` to the zero crossing of `sdf` (inside at origin). */
export function rayToSurface(sdf, origin, dir, rMax = 3, iters = 40) {
  let lo = 0, hi = rMax
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2
    if (sdf(add(origin, dir.map((v) => v * mid))) < 0) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Mesh a star-shaped signed distance field by marching rays from `c`. */
export const radialSdf = (sdf, { c = [0, 0, 0], n = 16, rMax = 3 } = {}) => radial((d) => rayToSurface(sdf, c, d, rMax), { c, n })

// ---- swept tubes ----

/**
 * Tube swept along `curve(t)` (t in [0, 1]) with rotation-minimising frames.
 * `radius(t)` may return a number or [rx, ry] for an elliptical section
 * (rx along the frame normal, ry along the binormal). Caps: 'round' adds
 * hemispherical ends, 'flat' adds discs, 'none' leaves the ends open.
 */
export function tube(curve, radius, { seg = [32, 12], caps = 'round', loop = false, up = null } = {}) {
  const [nAlong, nAround] = seg
  const rad = (t) => {
    const r = typeof radius === 'function' ? radius(t) : radius
    return typeof r === 'number' ? [r, r] : r
  }
  const pts = Array.from({ length: nAlong + 1 }, (_, i) => curve(i / nAlong))
  const tangents = pts.map((p, i) => {
    if (loop) return normalize(sub(pts[(i + 1) % nAlong], pts[(i - 1 + nAlong) % nAlong]))
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(nAlong, i + 1)]
    return normalize(sub(b, a))
  })
  // Double-reflection rotation-minimising frames.
  const normals = []
  let n0 = up ? normalize(sub(up, tangents[0].map((v) => v * dot(up, tangents[0])))) : null
  if (!n0 || length(n0) < 1e-6) {
    const t0 = tangents[0]
    const ref = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    n0 = normalize(cross(cross(t0, ref), t0))
  }
  normals.push(n0)
  for (let i = 0; i < nAlong; i++) {
    const v1 = sub(pts[i + 1], pts[i])
    const c1 = dot(v1, v1)
    if (c1 < 1e-14) {
      normals.push(normals[i])
      continue
    }
    const rL = sub(normals[i], v1.map((v) => (2 / c1) * dot(v1, normals[i]) * v))
    const tL = sub(tangents[i], v1.map((v) => (2 / c1) * dot(v1, tangents[i]) * v))
    const v2 = sub(tangents[i + 1], tL)
    const c2 = dot(v2, v2)
    normals.push(c2 < 1e-14 ? rL : normalize(sub(rL, v2.map((v) => (2 / c2) * dot(v2, rL) * v))))
  }
  const frame = (i) => ({ p: pts[i], t: tangents[i], n: normals[i], b: cross(tangents[i], normals[i]) })

  const rings = []
  const ring = (p, n, b, rx, ry) => ({ p, n, b, rx, ry })
  const capSteps = Math.max(3, Math.round(nAround / 4))
  if (caps === 'round' && !loop) {
    const f = frame(0)
    const [rx, ry] = rad(0)
    for (let k = 0; k < capSteps; k++) {
      const a = (Math.PI / 2) * (1 - k / capSteps)
      rings.push(ring(sub(f.p, f.t.map((v) => v * Math.sin(a) * Math.min(rx, ry))), f.n, f.b, rx * Math.cos(a), ry * Math.cos(a)))
    }
  }
  for (let i = 0; i <= nAlong; i++) {
    const f = frame(i)
    const [rx, ry] = rad(i / nAlong)
    rings.push(ring(f.p, f.n, f.b, rx, ry))
  }
  if (caps === 'round' && !loop) {
    const f = frame(nAlong)
    const [rx, ry] = rad(1)
    for (let k = 1; k <= capSteps; k++) {
      const a = (Math.PI / 2) * (k / capSteps)
      rings.push(ring(add(f.p, f.t.map((v) => v * Math.sin(a) * Math.min(rx, ry))), f.n, f.b, rx * Math.cos(a), ry * Math.cos(a)))
    }
  }
  const body = surface(nAround, rings.length - 1, (u, v) => {
    const r = rings[Math.round(v * (rings.length - 1))]
    const a = TAU * u
    return add(r.p, add(r.n.map((x) => x * Math.cos(a) * r.rx), r.b.map((x) => x * Math.sin(a) * r.ry)))
  }, { closed: loop || caps === 'round' })
  if (caps !== 'flat' || loop) return body
  const disc = (r, dir) =>
    surface(nAround, 1, (u, v) => {
      const a = TAU * u
      return add(r.p, add(r.n.map((x) => x * Math.cos(a) * r.rx * v), r.b.map((x) => x * Math.sin(a) * r.ry * v)))
    }, { closed: false, facing: dir })
  const first = rings[0], last = rings[rings.length - 1]
  const shape = merge(body, disc(first, tangents[0].map((v) => -v)), disc(last, tangents[nAlong]))
  if (signedVolume(shape) < 0) flip(shape)
  return shape
}

/**
 * Torus in the XZ plane around +Y (major radius R, tube radius r), optionally
 * partial with round ends. `tubeScale` stretches the section: [vertical, radial].
 */
export function torus({ R = 1, r = 0.25, c = [0, 0, 0], seg = [48, 12], arc = null, tubeScale = [1, 1] } = {}) {
  const a0 = arc ? arc[0] : 0
  const a1 = arc ? arc[1] : TAU
  const curve = (t) => {
    const a = a0 + (a1 - a0) * t
    return [c[0] + R * Math.sin(a), c[1], c[2] + R * Math.cos(a)]
  }
  return tube(curve, [r * tubeScale[0], r * tubeScale[1]], { seg, loop: !arc, caps: arc ? 'round' : 'none', up: [0, 1, 0] })
}

/** Points along a Catmull-Rom spline through `pts` (t in [0, 1]). */
export function spline(pts) {
  const n = pts.length - 1
  return (t) => {
    const f = Math.min(n - 1e-9, Math.max(0, t * n))
    const i = Math.floor(f)
    const s = f - i
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)]
    return [0, 1, 2].map((k) => {
      const a = p1[k], b = p2[k]
      const m1 = (p2[k] - p0[k]) / 2, m2 = (p3[k] - p1[k]) / 2
      const s2 = s * s, s3 = s2 * s
      return (2 * s3 - 3 * s2 + 1) * a + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * b + (s3 - s2) * m2
    })
  }
}

/** Puffy star badge in the XY plane facing +Z: `points` tips, rounded edges. */
export function puffyStar({ outer = 1, inner = 0.5, points = 5, depth = 0.3, c = [0, 0, 0], rot = 0, seg = 8 } = {}) {
  const sector = TAU / points
  const polyR = (a) => {
    let x = (((a - rot - Math.PI / 2) % sector) + sector) % sector
    if (x > sector / 2) x = sector - x
    // Line from the tip (angle 0, radius outer) to the valley (angle sector/2, radius inner).
    const tip = [outer, 0]
    const val = [inner * Math.cos(sector / 2), inner * Math.sin(sector / 2)]
    const d = [Math.cos(x), Math.sin(x)]
    const e = [val[0] - tip[0], val[1] - tip[1]]
    const den = d[0] * e[1] - d[1] * e[0]
    return (tip[0] * e[1] - tip[1] * e[0]) / den
  }
  const soft = (a) => {
    let s = 0
    for (let k = -3; k <= 3; k++) s += polyR(a + k * sector * 0.018)
    return s / 7
  }
  return radialLatLong((d) => {
    const q = Math.hypot(d[0], d[1])
    const rho = soft(Math.atan2(d[1], d[0]))
    return 1 / Math.sqrt((q / rho) ** 2 + (d[2] / (depth / 2)) ** 2)
  }, { c, nu: points * seg, nv: 10 })
}

/** Distance from p to an axis-aligned ellipsoid surface (approximate, sign exact). */
export function sdEllipsoid(p, c, r) {
  const q = [(p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]]
  const k0 = length(q)
  const k1 = length([q[0] / r[0], q[1] / r[1], q[2] / r[2]])
  return k0 < 1e-9 ? -Math.min(...r) : (k0 * (k0 - 1)) / k1
}

export const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/**
 * A puffy patch lying on another surface (pockets, bibs, badges).
 * `at(a, b)` returns { p, n } on the host surface for patch coordinates;
 * `outline(u)` traces the patch border (u in [0, 1]) around `centre`.
 * The top bulges by `thick` and the underside sinks `under` into the host,
 * so the patch never z-fights with it.
 */
export function pillow(at, outline, centre, { thick = 0.03, under = 0.03, lift = 0.004, seg = [40, 8], power = 3 } = {}) {
  const point = (u, v, side) => {
    const o = outline(u)
    const a = centre[0] + (o[0] - centre[0]) * v
    const b = centre[1] + (o[1] - centre[1]) * v
    const { p, n } = at(a, b)
    const h = side > 0 ? lift + thick * Math.pow(Math.max(0, 1 - v ** power), 0.5) : lift - under * Math.pow(Math.max(0, 1 - v ** power), 0.5)
    return [p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h]
  }
  const top = surface(seg[0], seg[1], (u, v) => point(u, v, 1), { closed: false, smooth: false })
  const bottom = surface(seg[0], seg[1], (u, v) => point(u, v, -1), { closed: false, smooth: false })
  flip(bottom)
  const shape = merge(top, bottom)
  if (signedVolume(shape) < 0) flip(shape)
  return computeNormals(shape)
}

/** Rounded-rectangle outline in patch coordinates, for `pillow`. */
export function roundedRectOutline(cx, cy, w, h, r) {
  const hw = w / 2, hh = h / 2
  const rr = Math.min(r, hw, hh)
  const straightX = 2 * (hw - rr), straightY = 2 * (hh - rr), arc = (Math.PI / 2) * rr
  const total = 2 * straightX + 2 * straightY + 4 * arc
  // Starts at the middle of the bottom edge and runs counter-clockwise.
  const legs = [
    ['line', [cx, cy - hh], [cx + hw - rr, cy - hh], straightX / 2],
    ['arc', [cx + hw - rr, cy - hh + rr], -Math.PI / 2, arc],
    ['line', [cx + hw, cy - hh + rr], [cx + hw, cy + hh - rr], straightY],
    ['arc', [cx + hw - rr, cy + hh - rr], 0, arc],
    ['line', [cx + hw - rr, cy + hh], [cx - hw + rr, cy + hh], straightX],
    ['arc', [cx - hw + rr, cy + hh - rr], Math.PI / 2, arc],
    ['line', [cx - hw, cy + hh - rr], [cx - hw, cy - hh + rr], straightY],
    ['arc', [cx - hw + rr, cy - hh + rr], Math.PI, arc],
    ['line', [cx - hw + rr, cy - hh], [cx, cy - hh], straightX / 2],
  ]
  return (u) => {
    let d = (((u % 1) + 1) % 1) * total
    for (const leg of legs) {
      const len = leg[3]
      if (d <= len || leg === legs[legs.length - 1]) {
        const t = len > 0 ? Math.min(1, d / len) : 0
        if (leg[0] === 'line') return [leg[1][0] + (leg[2][0] - leg[1][0]) * t, leg[1][1] + (leg[2][1] - leg[1][1]) * t]
        const a = leg[2] + (Math.PI / 2) * t
        return [leg[1][0] + rr * Math.cos(a), leg[1][1] + rr * Math.sin(a)]
      }
      d -= len
    }
    return [cx, cy - hh]
  }
}
