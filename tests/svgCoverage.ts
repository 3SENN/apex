/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A tiny vector "rasterizer" for the generated face layers: parses the few
// SVG elements the generator writes (path with M/L/Q/A/Z, circle, ellipse)
// and answers whether a point is painted, so tests can check that one layer
// stays on top of another without a browser.

type Point = [number, number]

type Subpath = { points: Point[]; closed: boolean }
/** A straight piece of a flattened outline: ax, ay, bx, by. */
type Edge = [number, number, number, number]

export interface Shape {
  filled: boolean
  strokeWidth: number
  /** Every subpath implicitly closed, as a fill is. */
  fillEdges: Edge[]
  /** Closed only where the path says so (Z, circles, ellipses). */
  strokeEdges: Edge[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

const CURVE_STEPS = 32

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match ? (match[1] ?? null) : null
}

function num(tag: string, name: string, fallback = 0): number {
  const value = attr(tag, name)
  return value === null ? fallback : Number(value)
}

/** Endpoint-parameterized SVG arc to points (SVG 1.1 implementation notes, F.6.5). */
function arcPoints(from: Point, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, to: Point): Point[] {
  const phi = (angle * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (from[0] - to[0]) / 2
  const dy = (from[1] - to[1]) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  const scale = Math.max(1, Math.sqrt((x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)))
  rx *= scale
  ry *= scale
  const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den))
  const cx1 = (k * rx * y1) / ry
  const cy1 = (-k * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2
  const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2
  const angleOf = (ux: number, uy: number): number => Math.atan2(uy, ux)
  const start = angleOf((x1 - cx1) / rx, (y1 - cy1) / ry)
  let delta = angleOf((-x1 - cx1) / rx, (-y1 - cy1) / ry) - start
  if (!sweep && delta > 0) delta -= Math.PI * 2
  if (sweep && delta < 0) delta += Math.PI * 2
  const points: Point[] = []
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = start + (delta * i) / CURVE_STEPS
    const ex = rx * Math.cos(t)
    const ey = ry * Math.sin(t)
    points.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy])
  }
  return points
}

function pathSubpaths(d: string): Subpath[] {
  const tokens = d.match(/[MLQAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
  const subpaths: Subpath[] = []
  let current: Subpath | null = null
  let i = 0
  const take = (): number => Number(tokens[i++])
  const last = (): Point => current?.points[current.points.length - 1] ?? [0, 0]
  while (i < tokens.length) {
    const command = tokens[i++]
    if (command === 'M') {
      current = { points: [[take(), take()]], closed: false }
      subpaths.push(current)
    } else if (command === 'L') {
      current?.points.push([take(), take()])
    } else if (command === 'Q') {
      const [x0, y0] = last()
      const qx = take(), qy = take(), x = take(), y = take()
      for (let s = 1; s <= CURVE_STEPS; s++) {
        const t = s / CURVE_STEPS
        const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t
        current?.points.push([a * x0 + b * qx + c * x, a * y0 + b * qy + c * y])
      }
    } else if (command === 'A') {
      const rx = take(), ry = take(), angle = take(), large = take() === 1, sweep = take() === 1, x = take(), y = take()
      current?.points.push(...arcPoints(last(), rx, ry, angle, large, sweep, [x, y]))
    } else if (command === 'Z' || command === 'z') {
      if (current) current.closed = true
    } else {
      throw new Error(`unsupported path command ${command} in ${d}`)
    }
  }
  return subpaths
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number, rotation: number): Point[] {
  const phi = (rotation * Math.PI) / 180
  const points: Point[] = []
  for (let i = 0; i < CURVE_STEPS * 2; i++) {
    const t = (i / (CURVE_STEPS * 2)) * Math.PI * 2
    const x = rx * Math.cos(t), y = ry * Math.sin(t)
    points.push([cx + x * Math.cos(phi) - y * Math.sin(phi), cy + x * Math.sin(phi) + y * Math.cos(phi)])
  }
  return points
}

/** Parses one face layer. Only the elements and attributes the generator writes are supported. */
export function parseLayer(svg: string): Shape[] {
  const shapes: Shape[] = []
  for (const match of svg.matchAll(/<(path|circle|ellipse|g)\b[^>]*>/g)) {
    const tag = match[0]
    const kind = match[1]
    if (kind === 'g') throw new Error('grouped layers are not supported')
    if (attr(tag, 'transform') && !/^rotate\(/.test(attr(tag, 'transform') ?? '')) throw new Error(`unsupported transform in ${tag}`)
    const fill = attr(tag, 'fill')
    const stroke = attr(tag, 'stroke')
    const filled = fill !== 'none' && num(tag, 'fill-opacity', 1) > 0
    const strokeWidth = stroke && stroke !== 'none' ? num(tag, 'stroke-width', 1) : 0
    let subpaths: Subpath[]
    if (kind === 'path') {
      subpaths = pathSubpaths(attr(tag, 'd') ?? '')
    } else {
      const rotation = Number(/rotate\(\s*(-?[\d.]+)/.exec(attr(tag, 'transform') ?? '')?.[1] ?? 0)
      const r = num(tag, 'r')
      const rx = kind === 'circle' ? r : num(tag, 'rx')
      const ry = kind === 'circle' ? r : num(tag, 'ry')
      subpaths = [{ points: ellipsePoints(num(tag, 'cx'), num(tag, 'cy'), rx, ry, rotation), closed: true }]
    }
    const points = subpaths.flatMap((sp) => sp.points)
    shapes.push({
      filled,
      strokeWidth,
      fillEdges: subpaths.flatMap((sp) => edges(sp.points, true)),
      strokeEdges: subpaths.flatMap((sp) => edges(sp.points, sp.closed)),
      bounds: {
        minX: Math.min(...points.map((q) => q[0])),
        minY: Math.min(...points.map((q) => q[1])),
        maxX: Math.max(...points.map((q) => q[0])),
        maxY: Math.max(...points.map((q) => q[1])),
      },
    })
  }
  return shapes
}

function edges(points: Point[], close: boolean): Edge[] {
  const out: Edge[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point, b = points[i] as Point
    out.push([a[0], a[1], b[0], b[1]])
  }
  const first = points[0], last = points[points.length - 1]
  if (close && first && last && points.length > 2) out.push([last[0], last[1], first[0], first[1]])
  return out
}

function edgeDistance(x: number, y: number, [ax, ay, bx, by]: Edge): number {
  const vx = bx - ax, vy = by - ay
  const len = vx * vx + vy * vy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len))
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy))
}

function insideFill(x: number, y: number, shape: Shape): boolean {
  // Even-odd, as the generator never relies on winding.
  let inside = false
  for (const [ax, ay, bx, by] of shape.fillEdges) {
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
  }
  return inside
}

/**
 * Whether `p` is painted by any shape, counting points up to `slack` past an
 * edge (antialiasing, and curves flattened to polylines).
 */
export function painted([x, y]: Point, shapes: readonly Shape[], slack = 0): boolean {
  for (const shape of shapes) {
    const reach = Math.max(shape.filled ? slack : 0, shape.strokeWidth > 0 ? shape.strokeWidth / 2 + slack : 0)
    const { minX, minY, maxX, maxY } = shape.bounds
    if (x < minX - reach || x > maxX + reach || y < minY - reach || y > maxY + reach) continue
    if (shape.filled && insideFill(x, y, shape)) return true
    if (shape.filled && slack > 0 && shape.fillEdges.some((e) => edgeDistance(x, y, e) <= slack)) return true
    if (shape.strokeWidth > 0 && shape.strokeEdges.some((e) => edgeDistance(x, y, e) <= shape.strokeWidth / 2 + slack)) return true
  }
  return false
}

/** Points along the painted outline of every shape (fills, plus the outer edge of strokes), about `spacing` apart. */
export function outlinePoints(shapes: readonly Shape[], spacing = 1): Point[] {
  const out: Point[] = []
  for (const shape of shapes) {
    const outlines: Array<[Edge[], number]> = []
    if (shape.filled) outlines.push([shape.fillEdges, 0])
    if (shape.strokeWidth > 0) outlines.push([shape.strokeEdges, shape.strokeWidth / 2])
    for (const [list, half] of outlines) {
      for (const [ax, ay, bx, by] of list) {
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacing))
        for (let s = 0; s < steps; s++) {
          const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps
          if (half === 0) out.push([x, y])
          else for (let k = 0; k < 8; k++) out.push([x + Math.cos((k / 8) * Math.PI * 2) * half, y + Math.sin((k / 8) * Math.PI * 2) * half])
        }
      }
    }
  }
  return out
}
