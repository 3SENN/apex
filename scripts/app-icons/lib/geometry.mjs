/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Vector geometry for Atelier's icon art: a small path model (move, line,
// cubic, close), the shape helpers the art needs (rounded polygons, the
// squircle tile, stroke outlines with round caps and joins), flattening to
// polygons for the rasterizer, and serialisation to SVG path data.
//
// Everything here is plain arithmetic, so the same inputs give the same
// outputs on every machine.

const TAU = Math.PI * 2

/** A path is a list of commands: ['M',x,y] ['L',x,y] ['C',x1,y1,x2,y2,x,y] ['Z']. */
export class Path {
  constructor(cmds = []) {
    this.cmds = cmds
    this._cx = 0
    this._cy = 0
  }

  moveTo(x, y) {
    this.cmds.push(['M', x, y])
    this._cx = x
    this._cy = y
    return this
  }

  lineTo(x, y) {
    this.cmds.push(['L', x, y])
    this._cx = x
    this._cy = y
    return this
  }

  cubicTo(x1, y1, x2, y2, x, y) {
    this.cmds.push(['C', x1, y1, x2, y2, x, y])
    this._cx = x
    this._cy = y
    return this
  }

  close() {
    this.cmds.push(['Z'])
    return this
  }

  /**
   * A circular arc around (cx, cy) from angle a0, sweeping by `sweep`
   * radians (positive is clockwise on screen, where y points down). Draws a
   * line to the arc's start first unless `move` is set.
   */
  arc(cx, cy, r, a0, sweep, move = false) {
    const sx = cx + r * Math.cos(a0)
    const sy = cy + r * Math.sin(a0)
    if (move) this.moveTo(sx, sy)
    else if (Math.abs(sx - this._cx) > 1e-9 || Math.abs(sy - this._cy) > 1e-9) this.lineTo(sx, sy)
    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
    const step = sweep / pieces
    const k = (4 / 3) * Math.tan(step / 4)
    let a = a0
    for (let i = 0; i < pieces; i++) {
      const b = a + step
      const c0 = Math.cos(a)
      const s0 = Math.sin(a)
      const c1 = Math.cos(b)
      const s1 = Math.sin(b)
      this.cubicTo(
        cx + r * (c0 - k * s0),
        cy + r * (s0 + k * c0),
        cx + r * (c1 + k * s1),
        cy + r * (s1 - k * c1),
        cx + r * c1,
        cy + r * s1
      )
      a = b
    }
    return this
  }

  /** Appends another path's commands. */
  add(other) {
    for (const c of other.cmds) this.cmds.push(c.slice())
    return this
  }

  /** A new path with every point passed through fn(x, y) → [x, y]. */
  map(fn) {
    const out = []
    for (const c of this.cmds) {
      if (c[0] === 'Z') {
        out.push(['Z'])
        continue
      }
      const n = [c[0]]
      for (let i = 1; i < c.length; i += 2) {
        const [x, y] = fn(c[i], c[i + 1])
        n.push(x, y)
      }
      out.push(n)
    }
    return new Path(out)
  }

  translate(dx, dy) {
    return this.map((x, y) => [x + dx, y + dy])
  }

  scale(s, ox = 0, oy = 0) {
    return this.map((x, y) => [ox + (x - ox) * s, oy + (y - oy) * s])
  }

  /**
   * Flattens to closed polygons (arrays of [x, y]). `tolerance` is the
   * largest allowed distance, in output units, between a curve and its
   * chords.
   */
  flatten(tolerance = 0.1) {
    const polys = []
    let cur = null
    let x = 0
    let y = 0
    let sx = 0
    let sy = 0
    for (const c of this.cmds) {
      switch (c[0]) {
        case 'M':
          if (cur && cur.length > 2) polys.push(cur)
          cur = [[c[1], c[2]]]
          x = sx = c[1]
          y = sy = c[2]
          break
        case 'L':
          if (!cur) cur = [[x, y]]
          cur.push([c[1], c[2]])
          x = c[1]
          y = c[2]
          break
        case 'C': {
          if (!cur) cur = [[x, y]]
          const [, x1, y1, x2, y2, x3, y3] = c
          // Segment count from the control polygon's deviation (Wang's bound).
          const ddx = Math.max(Math.abs(x - 2 * x1 + x2), Math.abs(x1 - 2 * x2 + x3))
          const ddy = Math.max(Math.abs(y - 2 * y1 + y2), Math.abs(y1 - 2 * y2 + y3))
          const dd = Math.sqrt(ddx * ddx + ddy * ddy)
          const n = Math.min(512, Math.max(1, Math.ceil(Math.sqrt((3 * dd) / (4 * tolerance)))))
          for (let i = 1; i <= n; i++) {
            const t = i / n
            const u = 1 - t
            const a = u * u * u
            const b = 3 * u * u * t
            const d = 3 * u * t * t
            const e = t * t * t
            cur.push([a * x + b * x1 + d * x2 + e * x3, a * y + b * y1 + d * y2 + e * y3])
          }
          x = x3
          y = y3
          break
        }
        case 'Z':
          if (cur && cur.length > 2) polys.push(cur)
          cur = null
          x = sx
          y = sy
          break
        default:
          throw new Error(`Unknown path command ${c[0]}`)
      }
    }
    if (cur && cur.length > 2) polys.push(cur)
    return polys
  }

  /** SVG path data, numbers rounded to `digits` decimals. */
  toSVG(digits = 2) {
    const f = (v) => fmt(v, digits)
    return this.cmds
      .map((c) => (c[0] === 'Z' ? 'Z' : c[0] + c.slice(1).map(f).join(' ')))
      .join('')
  }

  /** Bounding box of every point and control point. */
  bounds() {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const c of this.cmds) {
      for (let i = 1; i < c.length; i += 2) {
        x0 = Math.min(x0, c[i])
        x1 = Math.max(x1, c[i])
        y0 = Math.min(y0, c[i + 1])
        y1 = Math.max(y1, c[i + 1])
      }
    }
    return { x0, y0, x1, y1 }
  }
}

export function fmt(v, digits = 2) {
  const p = 10 ** digits
  let r = Math.round(v * p) / p
  if (Object.is(r, -0)) r = 0
  return String(r)
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const len = (v) => Math.sqrt(v[0] * v[0] + v[1] * v[1])
const norm = (v) => {
  const l = len(v)
  return [v[0] / l, v[1] / l]
}
const cross = (a, b) => a[0] * b[1] - a[1] * b[0]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1]

/**
 * A polygon with circular rounded corners. `radii` is one radius per
 * vertex (or one for all). Returns the path and, per corner, the arc's
 * centre and its outermost point along the corner's bisector.
 */
export function roundedPolygon(points, radii) {
  const n = points.length
  const rs = Array.isArray(radii) ? radii : points.map(() => radii)
  const corners = points.map((p, i) => {
    const prev = points[(i + n - 1) % n]
    const next = points[(i + 1) % n]
    const a = norm(sub(prev, p))
    const b = norm(sub(next, p))
    const half = Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / 2
    const r = rs[i]
    const t = r / Math.tan(half)
    const bis = norm([a[0] + b[0], a[1] + b[1]])
    const dc = r / Math.sin(half)
    const c = [p[0] + bis[0] * dc, p[1] + bis[1] * dc]
    const A = [p[0] + a[0] * t, p[1] + a[1] * t]
    const B = [p[0] + b[0] * t, p[1] + b[1] * t]
    const a0 = Math.atan2(A[1] - c[1], A[0] - c[0])
    const va = sub(A, c)
    const vb = sub(B, c)
    const sweep = Math.atan2(cross(va, vb), dot(va, vb))
    const tip = [c[0] - bis[0] * r, c[1] - bis[1] * r]
    return { c, r, a0, sweep, A, B, tip }
  })
  const path = new Path()
  corners.forEach((k, i) => {
    if (i === 0) path.moveTo(k.A[0], k.A[1])
    else path.lineTo(k.A[0], k.A[1])
    if (k.r > 0) path.arc(k.c[0], k.c[1], k.r, k.a0, k.sweep)
  })
  path.close()
  return { path, corners }
}

/**
 * Atelier's tile: a superellipse (|x|^n + |y|^n = 1) filling the box, a soft
 * square with continuous corners. Sampled densely; exact enough at 1024 px.
 */
export function squircle(x, y, w, h, exponent = 5, samples = 512) {
  const cx = x + w / 2
  const cy = y + h / 2
  const rx = w / 2
  const ry = h / 2
  const e = 2 / exponent
  const path = new Path()
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * TAU
    const c = Math.cos(t)
    const s = Math.sin(t)
    const px = cx + rx * Math.sign(c) * Math.abs(c) ** e
    const py = cy + ry * Math.sign(s) * Math.abs(s) ** e
    if (i === 0) path.moveTo(px, py)
    else path.lineTo(px, py)
  }
  return path.close()
}

/** A plain rounded rectangle with circular corners. */
export function roundedRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  const p = new Path()
  p.moveTo(x + r, y)
  p.lineTo(x + w - r, y)
  p.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2)
  p.lineTo(x + w, y + h - r)
  p.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
  p.lineTo(x + r, y + h)
  p.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI / 2)
  p.lineTo(x, y + r)
  p.arc(x + r, y + r, r, Math.PI, Math.PI / 2)
  return p.close()
}

export function circle(cx, cy, r) {
  return new Path().arc(cx, cy, r, 0, TAU, true).close()
}

export function polygon(points) {
  const p = new Path()
  points.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)))
  return p.close()
}

/**
 * The outline of a polyline stroked with round caps and round joins, as one
 * closed path. Valid when every segment is longer than the stroke is wide,
 * which holds for the art here.
 */
export function strokeOutline(points, halfWidth) {
  const h = halfWidth
  const segs = []
  for (let i = 0; i < points.length - 1; i++) {
    const d = norm(sub(points[i + 1], points[i]))
    segs.push({ d, n: [-d[1], d[0]] })
  }
  const ang = (v) => Math.atan2(v[1], v[0])
  const offset = (p, n, s) => [p[0] + n[0] * h * s, p[1] + n[1] * h * s]
  const lineHit = (p, d, q, e) => {
    const den = cross(d, e)
    const t = cross(sub(q, p), e) / den
    return [p[0] + d[0] * t, p[1] + d[1] * t]
  }
  const path = new Path()
  const side = (s, pts, sg) => {
    // Walk one side: s = +1 for the +n side forwards, -1 for the other side
    // backwards (pts and sg are already reversed by the caller).
    for (let j = 1; j < pts.length - 1; j++) {
      const a = sg[j - 1]
      const b = sg[j]
      const z = cross(a.d, b.d)
      const p = pts[j]
      const inner = s > 0 ? z > 0 : z < 0
      if (Math.abs(z) < 1e-12) {
        const q = offset(p, b.n, s)
        path.lineTo(q[0], q[1])
      } else if (inner) {
        const q = lineHit(offset(p, a.n, s), a.d, offset(p, b.n, s), b.d)
        path.lineTo(q[0], q[1])
      } else {
        const va = [a.n[0] * s, a.n[1] * s]
        const vb = [b.n[0] * s, b.n[1] * s]
        path.arc(p[0], p[1], h, ang(va), Math.atan2(cross(va, vb), dot(va, vb)))
      }
    }
  }
  const first = offset(points[0], segs[0].n, 1)
  path.moveTo(first[0], first[1])
  side(1, points, segs)
  const last = points[points.length - 1]
  const nl = segs[segs.length - 1].n
  path.arc(last[0], last[1], h, ang(nl), -Math.PI)
  const rpts = points.slice().reverse()
  const rsegs = segs
    .slice()
    .reverse()
    .map((s) => ({ d: [-s.d[0], -s.d[1]], n: [s.d[1], -s.d[0]] }))
  side(1, rpts, rsegs)
  const n0 = rsegs[rsegs.length - 1].n
  path.arc(points[0][0], points[0][1], h, ang(n0), -Math.PI)
  return path.close()
}

/**
 * The outline of one cubic Bézier, [x0, y0, x1, y1, x2, y2, x3, y3], stroked
 * with round caps, as one closed path: both sides offset along the curve's
 * normals, joined by half circles. Valid while the curve bends no tighter
 * than the stroke is wide, which holds for the mark.
 */
export function strokeCubic([x0, y0, x1, y1, x2, y2, x3, y3], halfWidth, samples = 48) {
  const h = halfWidth
  const pts = []
  const ns = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const u = 1 - t
    pts.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3])
    const d = norm([3 * u * u * (x1 - x0) + 6 * u * t * (x2 - x1) + 3 * t * t * (x3 - x2), 3 * u * u * (y1 - y0) + 6 * u * t * (y2 - y1) + 3 * t * t * (y3 - y2)])
    ns.push([-d[1], d[0]])
  }
  const ang = (v) => Math.atan2(v[1], v[0])
  const path = new Path().moveTo(pts[0][0] + ns[0][0] * h, pts[0][1] + ns[0][1] * h)
  for (let i = 1; i <= samples; i++) path.lineTo(pts[i][0] + ns[i][0] * h, pts[i][1] + ns[i][1] * h)
  path.arc(pts[samples][0], pts[samples][1], h, ang(ns[samples]), -Math.PI)
  for (let i = samples; i >= 0; i--) path.lineTo(pts[i][0] - ns[i][0] * h, pts[i][1] - ns[i][1] * h)
  path.arc(pts[0][0], pts[0][1], h, ang([-ns[0][0], -ns[0][1]]), -Math.PI)
  return path.close()
}

/** A four-pointed star: tips at radius r, waist points at radius r*inner on the diagonals. */
export function spark(cx, cy, r, inner = 0.395, ry = r) {
  const w = (r * inner) / Math.SQRT2
  const wy = (ry * inner) / Math.SQRT2
  return polygon([
    [cx, cy - ry],
    [cx + w, cy - wy],
    [cx + r, cy],
    [cx + w, cy + wy],
    [cx, cy + ry],
    [cx - w, cy + wy],
    [cx - r, cy],
    [cx - w, cy - wy]
  ])
}
