/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// 2D face layers: 512×256 transparent SVGs following the layout in
// docs/companion-system.md. Eye variants hold the eye whites and lids; the
// movable pupils live in pupils.svg and stay on the whites (at most covering
// their outline, never the skin) of the variants that show them, at the
// gazes the runtime shows them with and the ranges in eye-pupil-config.json.

import { BROW_VARIANTS, EYE_VARIANTS, FACE_IDS, MOUTH_VARIANTS } from './catalogue.mjs'
import { FACE } from './face-layout.mjs'

const { ink: INK, white: WHITE, mouth: MOUTH } = FACE
const EYES = [
  { cx: FACE.eyeLeftX, out: -1 },
  { cx: FACE.eyeRightX, out: 1 },
]
const CY = FACE.eyeY

const n = (v) => String(Math.round(v * 10) / 10)
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${FACE.width}" height="${FACE.height}" viewBox="0 0 ${FACE.width} ${FACE.height}">${body}</svg>\n`

/** Path data from [cmd, ...points] lists, with x mirrored per eye (o = ±1 toward the outside). */
function path(cx, cy, o, cmds) {
  return cmds
    .map(([c, ...pts]) => {
      if (c === 'Z') return 'Z'
      const xy = []
      for (let i = 0; i < pts.length; i += 2) xy.push(`${n(cx + pts[i] * o)} ${n(cy + pts[i + 1])}`)
      return `${c}${xy.join(' ')}`
    })
    .join(' ')
}
const stroke = (d, width, color = INK) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
const fill = (d, color, line = 0, lineColor = INK) =>
  `<path d="${d}" fill="${color}"${line ? ` stroke="${lineColor}" stroke-width="${line}" stroke-linejoin="round"` : ''}/>`
const circle = (x, y, r, color, line = 0) => `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${color}"${line ? ` stroke="${INK}" stroke-width="${line}"` : ''}/>`
const ellipse = (x, y, rx, ry, color, line = 0, rot = 0) =>
  `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" fill="${color}"${line ? ` stroke="${INK}" stroke-width="${line}"` : ''}${rot ? ` transform="rotate(${n(rot)} ${n(x)} ${n(y)})"` : ''}/>`
const both = (fn) => EYES.map(({ cx, out }) => fn(cx, out)).join('')

// ---- pupil fitting ----

/** A closed [cmd, ...points] outline (M, L, Q, Z) flattened to points, in eye-local space. */
function outline(cmds, steps = 32) {
  const points = []
  for (const [c, ...pts] of cmds) {
    if (c === 'M' || c === 'L') points.push([pts[0], pts[1]])
    else if (c === 'Q') {
      const [x0, y0] = points[points.length - 1]
      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        points.push([(1 - t) ** 2 * x0 + 2 * (1 - t) * t * pts[0] + t * t * pts[2], (1 - t) ** 2 * y0 + 2 * (1 - t) * t * pts[1] + t * t * pts[3]])
      }
    }
  }
  return points
}

/** Distance from p to a closed outline, negative outside it. */
function clearance([x, y], poly) {
  let inside = false
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j]
    const [bx, by] = poly[i]
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
    const vx = bx - ax, vy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)))
    best = Math.min(best, Math.hypot(x - ax - t * vx, y - ay - t * vy))
  }
  return inside ? best : -best
}

/**
 * How far a pupil whose outline fits in a disc of `radius` around (0, y) can
 * travel, in the ratio `aspect` (x : y), and stay inside every outline at
 * every gaze. Gaze moves x and y independently, so the corners of the range
 * are what must fit; the outlines are convex, so the rest of the range then
 * fits too. Rounded down to the half pixels the runtime offsets by.
 */
function pupilRoom(outlines, radius, y, [ax, ay]) {
  const fits = (s) => outlines.every((poly) => [[1, 1], [1, -1], [-1, 1], [-1, -1]].every(([sx, sy]) => clearance([sx * s * ax, y + sy * s * ay], poly) >= radius))
  let lo = 0, hi = 64
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  const half = (v) => Math.floor(v * 2) / 2
  return { x: half(lo * ax), y: half(lo * ay) }
}

// ---- shared eye marks ----

/** Closed eye for a blink: a soft downward curve. */
const blinkLine = (cx, o, w = 30, lash = false) =>
  stroke(path(cx, CY, o, [['M', -w, 2], ['Q', 0, 14, w, 2]]), 9) + (lash ? stroke(path(cx, CY, o, [['M', w - 2, 3], ['L', w + 9, -5]]), 6) : '')
/** Happy squint: an upturned arc. */
const happyArc = (cx, o, w = 30, lift = 0) => stroke(path(cx, CY + lift, o, [['M', -w, 10], ['Q', 0, -26, w, 10]]), 10)
/** Asleep: relaxed low curve with two little lashes. */
const sleepCurve = (cx, o, w = 30) =>
  stroke(path(cx, CY + 6, o, [['M', -w, 0], ['Q', 0, 16, w, 0]]), 8) +
  stroke(path(cx, CY + 6, o, [['M', w * 0.55, 8], ['L', w * 0.75, 17]]), 5) +
  stroke(path(cx, CY + 6, o, [['M', w * 0.15, 11], ['L', w * 0.22, 21]]), 5)
/** A concentrating lid line above the eye, lower toward the nose. */
const focusLid = (cx, o, r, w = 1) => stroke(path(cx, CY, o, [['M', r * 0.95 * w, -r - 10], ['Q', 0, -r - 8, -r * 0.9 * w, -r - 1]]), 8)
/** A worried lid line above the eye, lower toward the outside. */
const sadLid = (cx, o, r) => stroke(path(cx, CY, o, [['M', -r * 0.85, -r - 12], ['Q', r * 0.1, -r - 7, r * 0.95, -r + 2]]), 7)
/** A small tear under the outer corner. */
const tear = (cx, o, r) => fill(path(cx, CY, o, [['M', r * 0.75, r * 0.55], ['Q', r * 0.62, r * 0.95, r * 0.75, r * 1.05], ['Q', r * 0.9, r * 0.95, r * 0.75, r * 0.55], ['Z']]), WHITE, 4)
const wideTicks = (cx, o, r) =>
  stroke(path(cx, CY, o, [['M', r * 0.55, -r - 8], ['L', r * 0.75, -r - 18]]), 6) + stroke(path(cx, CY, o, [['M', r * 0.95, -r * 0.55], ['L', r * 1.2, -r * 0.8]]), 6)

const pupilWithShine = (cx, r, { rx = r, ry = r, shine = 0.34, small = 0.16 } = {}) =>
  ellipse(cx, CY, rx, ry, INK) +
  circle(cx - rx * 0.32, CY - ry * 0.38, Math.min(rx, ry) * shine, WHITE) +
  circle(cx + rx * 0.36, CY + ry * 0.34, Math.min(rx, ry) * small, WHITE)

/** Eye styles with round or oval whites and a round pupil. */
function whitesStyle({ label, r, ry = r, pupil, pupilRy = pupil, stroke: sw = 8, extras = () => '', closedW = r * 0.82 }) {
  const white = (cx, rr, rry) => ellipse(cx, CY, rr, rry, WHITE, sw)
  const scaleY = ry / r
  const variants = {
    neutral: both((cx, o) => white(cx, r, ry) + extras(cx, o, 'neutral')),
    blink: both((cx, o) => blinkLine(cx, o, closedW, label === 'Lashes') + extras(cx, o, 'blink')),
    happy: both((cx, o) => happyArc(cx, o, closedW) + extras(cx, o, 'happy')),
    focused: both((cx, o) => white(cx, r - 3, ry - 4) + focusLid(cx, o, ry - 2) + extras(cx, o, 'focused')),
    wide: both((cx, o) => white(cx, r + 6, ry + 6 * scaleY) + wideTicks(cx, o, ry + 6) + extras(cx, o, 'wide')),
    sad: both((cx, o) => white(cx, r - 1, ry - 2) + sadLid(cx, o, ry - 1) + tear(cx, o, ry) + extras(cx, o, 'sad')),
    sleepy: both((cx, o) => sleepCurve(cx, o, closedW) + extras(cx, o, 'sleepy')),
  }
  const pupils = svg(both((cx) => pupilWithShine(cx, pupil, { rx: pupil, ry: pupilRy })))
  // The pupil may travel until its edge meets the middle of the outline:
  // ink on ink, so the white never shows past it.
  const roomX = r - pupil - 1
  const roomY = ry - pupilRy - 1
  return {
    label,
    variants,
    pupils,
    pupilVariants: ['neutral', 'focused', 'wide', 'sad'],
    pupilConfig: { rangeX: roomX / FACE.width, rangeY: roomY / FACE.height, scale: 1 },
  }
}

const EYE_STYLES = {
  'eyes-round': () => whitesStyle({ label: 'Round', r: 38, pupil: 25 }),
  'eyes-oval': () => whitesStyle({ label: 'Oval', r: 30, ry: 42, pupil: 18, pupilRy: 27 }),
  'eyes-sparkle': () => {
    const base = whitesStyle({ label: 'Sparkle', r: 42, pupil: 30 })
    // A four-point glint and a ring of shine make these read as glossy.
    const glint = (x, y, s) =>
      fill(`M${n(x)} ${n(y - s)} Q${n(x + s * 0.18)} ${n(y - s * 0.18)} ${n(x + s)} ${n(y)} Q${n(x + s * 0.18)} ${n(y + s * 0.18)} ${n(x)} ${n(y + s)} Q${n(x - s * 0.18)} ${n(y + s * 0.18)} ${n(x - s)} ${n(y)} Q${n(x - s * 0.18)} ${n(y - s * 0.18)} ${n(x)} ${n(y - s)} Z`, WHITE)
    base.pupils = svg(
      both((cx) =>
        circle(cx, CY, 30, INK) +
        `<circle cx="${n(cx)}" cy="${n(CY + 6)}" r="20" fill="${WHITE}" fill-opacity="0.18"/>` +
        glint(cx - 10, CY - 11, 13) +
        circle(cx + 12, CY + 10, 5, WHITE) +
        circle(cx - 15, CY + 9, 2.6, WHITE),
      ),
    )
    return base
  },
  'eyes-sleepy': () => {
    // Heavy-lidded: the lid line cuts the white; the pupil is a half disc tucked under it.
    const R = 34, lid = -4
    const lower = (cx, o, rx, ry, lidY, droop = 6) =>
      fill(path(cx, CY, o, [['M', -rx, lidY + droop * 0.3], ['Q', -rx, lidY + ry * 1.25, 0, lidY + ry], ['Q', rx, lidY + ry * 1.25, rx, lidY + droop], ['Z']]), WHITE, 7) +
      stroke(path(cx, CY, o, [['M', -rx - 6, lidY - 1], ['Q', 0, lidY - 4, rx + 6, lidY + droop]]), 9)
    const variants = {
      neutral: both((cx, o) => lower(cx, o, R, 30, lid)),
      blink: both((cx, o) => blinkLine(cx, o, 30)),
      happy: both((cx, o) => happyArc(cx, o, 30, 4)),
      focused: both((cx, o) => lower(cx, o, R, 30, lid) + focusLid(cx, o, 22)),
      wide: both((cx, o) => lower(cx, o, R + 3, 36, lid - 8, 2)),
      sad: both((cx, o) => lower(cx, o, R, 28, lid, 12) + tear(cx, o, 30)),
      sleepy: both((cx, o) => sleepCurve(cx, o, 30)),
    }
    const pupils = svg(
      both((cx) => fill(`M${n(cx - 18)} ${n(CY + lid + 2)} A18 18 0 0 0 ${n(cx + 18)} ${n(CY + lid + 2)} Z`, INK) + circle(cx - 6, CY + lid + 8, 4.5, WHITE)),
    )
    return {
      label: 'Sleepy',
      variants,
      pupils,
      pupilVariants: ['neutral', 'focused', 'wide', 'sad'],
      pupilConfig: { rangeX: 8 / FACE.width, rangeY: 3 / FACE.height, scale: 1 },
    }
  },
  'eyes-dot': () => {
    const variants = {
      neutral: '',
      blink: both((cx, o) => blinkLine(cx, o, 18)),
      happy: both((cx, o) => happyArc(cx, o, 20)),
      focused: both((cx, o) => stroke(path(cx, CY, o, [['M', 20, -30], ['L', -18, -22]]), 7)),
      wide: both((cx) => circle(cx, CY, 26, WHITE, 6)),
      sad: both((cx, o) => stroke(path(cx, CY, o, [['M', -16, -32], ['L', 20, -22]]), 7) + tear(cx, o, 22)),
      sleepy: both((cx, o) => sleepCurve(cx, o, 18)),
    }
    return {
      label: 'Dot',
      variants,
      pupils: svg(both((cx) => circle(cx, CY, 15, INK) + circle(cx - 5, CY - 5, 4.5, WHITE))),
      pupilVariants: ['neutral', 'focused', 'wide', 'sad'],
      pupilConfig: { rangeX: 7 / FACE.width, rangeY: 7 / FACE.height, scale: 1 },
    }
  },
  'eyes-wide': () => {
    const base = whitesStyle({ label: 'Wide', r: 46, ry: 44, pupil: 18, extras: () => '' })
    base.pupils = svg(both((cx) => pupilWithShine(cx, 18, { shine: 0.4, small: 0.2 })))
    base.pupilConfig = { rangeX: 14 / FACE.width, rangeY: 12 / FACE.height, scale: 1 }
    return base
  },
  'eyes-cat': () => {
    // Almond whites with a lifted outer corner and a little wing.
    const LINE = 7
    const almondCmds = ([w, top, bottom, lift]) => [['M', -w, 2], ['Q', -w * 0.35, -top * 1.45, w, -lift], ['Q', w * 0.25, bottom * 1.35, -w, 2], ['Z']]
    const ALMONDS = { neutral: [42, 30, 26, 10], focused: [42, 25, 24, 12], wide: [44, 36, 30, 8], sad: [41, 28, 26, -4] }
    const almond = (cx, o, shape, wing = true) => {
      const [w, , , lift] = shape
      return (
        fill(path(cx, CY, o, almondCmds(shape)), WHITE, LINE) +
        (wing ? stroke(path(cx, CY, o, [['M', w - 2, -lift], ['Q', w + 10, -lift - 4, w + 14, -lift - 13]]), LINE) : '')
      )
    }
    const variants = {
      neutral: both((cx, o) => almond(cx, o, ALMONDS.neutral)),
      blink: both((cx, o) => blinkLine(cx, o, 34) + stroke(path(cx, CY, o, [['M', 34, 2], ['Q', 44, -2, 48, -11]]), 6)),
      happy: both((cx, o) => happyArc(cx, o, 34)),
      focused: both((cx, o) => almond(cx, o, ALMONDS.focused) + focusLid(cx, o, 20)),
      wide: both((cx, o) => almond(cx, o, ALMONDS.wide)),
      sad: both((cx, o) => almond(cx, o, ALMONDS.sad, false) + sadLid(cx, o, 22) + tear(cx, o, 30)),
      sleepy: both((cx, o) => sleepCurve(cx, o, 34)),
    }
    const pupilVariants = ['neutral', 'focused', 'wide', 'sad']
    // The almonds are short, so the pupil sits at their shared middle (a
    // little above the eye centre) and is sized to leave it room to move.
    // The translucent iris is the outermost part; it may cover the outline
    // but stops 1 px short of its outer edge, so it never reaches the skin.
    const IRIS = 12, Y = -1
    const room = pupilRoom(pupilVariants.map((v) => outline(almondCmds(ALMONDS[v]))), IRIS - (LINE / 2 - 1), Y, [3, 1])
    const pupils = svg(
      both((cx) =>
        `<circle cx="${n(cx)}" cy="${n(CY + Y)}" r="${IRIS}" fill="${INK}" fill-opacity="0.32"/>` +
        ellipse(cx, CY + Y, 5, 11, INK) +
        circle(cx - 4, CY + Y - 5.5, 3.2, WHITE) +
        circle(cx + 4.5, CY + Y + 5.5, 1.8, WHITE),
      ),
    )
    return { label: 'Cat', variants, pupils, pupilVariants, pupilConfig: { rangeX: room.x / FACE.width, rangeY: room.y / FACE.height, scale: 1 } }
  },
  'eyes-lash': () => {
    // Three curled lashes on the outer top of each eye.
    const lashes = (cx, o, r) =>
      [0.6, 1.05, 1.5]
        .map((a) => {
          const root = [r * Math.sin(a), -r * Math.cos(a)]
          const b = a + 0.35
          return stroke(path(cx, CY, o, [['M', root[0], root[1]], ['Q', root[0] + 9 * Math.sin(a), root[1] - 9 * Math.cos(a), root[0] + 15 * Math.sin(b), root[1] - 15 * Math.cos(b) - 3]]), 6)
        })
        .join('')
    return whitesStyle({
      label: 'Lashes',
      r: 36,
      pupil: 23,
      extras: (cx, o, v) => {
        if (v === 'happy') return stroke(path(cx, CY, o, [['M', 26, 2], ['L', 36, -8]]), 6) + stroke(path(cx, CY, o, [['M', 30, 9], ['L', 42, 5]]), 6)
        if (v === 'sleepy') return ''
        if (v === 'blink') return ''
        return lashes(cx, o, v === 'wide' ? 42 : v === 'focused' ? 33 : v === 'sad' ? 35 : 36)
      },
    })
  },
}

// ---- brows ----

/** Brow strokes per variant, as [x0, y0, cx, cy, x1, y1] around (eye x, brow y), from the inner end (toward the nose) outward. */
const BROW_SHAPES = {
  neutral: [-24, 4, 0, -6, 26, 2],
  raised: [-24, -8, 0, -26, 26, -12],
  furrowed: [-24, 7, 2, -3, 28, -6],
  sad: [-24, -10, 0, -10, 26, 6],
}

function browStyle(label, width, { len = 1, lift = 0, chunky = false } = {}) {
  const variants = {}
  for (const v of BROW_VARIANTS) {
    const [x0, y0, qx, qy, x1, y1] = BROW_SHAPES[v]
    variants[v] = EYES.map(({ cx, out }) => {
      // Negative x is the inner end, so it must point toward the nose: away from `out`.
      const o = out
      const y = FACE.browY + lift
      const d = `M${n(cx + x0 * len * o)} ${n(y + y0)} Q${n(cx + qx * len * o)} ${n(y + qy)} ${n(cx + x1 * len * o)} ${n(y + y1)}`
      return chunky
        ? stroke(d, width) + stroke(d, width * 0.45, INK)
        : stroke(d, width)
    }).join('')
  }
  return { label, variants }
}

const BROW_STYLES = {
  'brows-soft': () => browStyle('Soft', 10),
  'brows-bold': () => browStyle('Bold', 16, { len: 1.05, chunky: true }),
  'brows-thin': () => browStyle('Thin', 5, { len: 1.15, lift: -2 }),
  'brows-none': () => ({ label: 'None', variants: Object.fromEntries(BROW_VARIANTS.map((v) => [v, ''])) }),
}

// ---- mouths ----

const MX = FACE.mouthX, MY = FACE.mouthY
const MOUTH_SCALE = 1.25
const m = (cmds) => path(MX, MY, 1, cmds)
const openMouth = (d, line = 7) => fill(d, MOUTH, line)
const dShape = (w, top, depth, lip = 3) => m([['M', -w, top], ['Q', 0, top + lip, w, top], ['Q', w * 0.92, top + depth, 0, top + depth], ['Q', -w * 0.92, top + depth, -w, top], ['Z']])
const oval = (rx, ry, dy = 0) => ellipse(MX, MY + dy, rx, ry, MOUTH, 7)
const smileArc = (w, depth, y = -4) => stroke(m([['M', -w, y], ['Q', 0, y + depth, w, y]]), 8)
const frownArc = (w, depth, y = 8) => stroke(m([['M', -w, y], ['Q', 0, y - depth, w, y]]), 8)
const flatLine = (w, y = 2) => stroke(m([['M', -w, y], ['L', w, y]]), 8)
const fang = (x, y, s = 1, dir = 1) => fill(m([['M', x - 4 * s, y], ['L', x + 5 * s, y], ['L', x + 0.5 * s, y + 10 * s * dir], ['Z']]), WHITE, 3.5)
const teeth = (w, top, h) => fill(m([['M', -w * 0.84, top + 2], ['Q', 0, top + 5, w * 0.84, top + 2], ['L', w * 0.8, top + h], ['Q', 0, top + h + 3, -w * 0.8, top + h], ['Z']]), WHITE)

const MOUTH_STYLES = {
  'mouth-smile': () => ({
    label: 'Smile',
    variants: {
      neutral: smileArc(24, 18),
      happy: openMouth(dShape(28, -8, 30)),
      'talk-small': oval(13, 9, 2),
      'talk-wide': openMouth(dShape(20, -10, 28, 2)),
      o: oval(12, 13, 2),
      sad: frownArc(20, 14),
      flat: flatLine(15),
    },
  }),
  'mouth-cat': () => {
    const omega = (w, y, dip) => stroke(m([['M', -w, y], ['Q', -w / 2, y + dip, 0, y + 2], ['Q', w / 2, y + dip, w, y]]), 7)
    return {
      label: 'Cat',
      variants: {
        neutral: omega(26, -6, 16),
        happy: openMouth(m([['M', -27, -6], ['Q', -13, 8, 0, -3], ['Q', 13, 8, 27, -6], ['Q', 24, 26, 0, 27], ['Q', -24, 26, -27, -6], ['Z']])),
        'talk-small': openMouth(m([['M', -14, 0], ['Q', -7, 7, 0, 2], ['Q', 7, 7, 14, 0], ['Q', 13, 16, 0, 17], ['Q', -13, 16, -14, 0], ['Z']])),
        'talk-wide': openMouth(m([['M', -20, -4], ['Q', -10, 6, 0, -1], ['Q', 10, 6, 20, -4], ['Q', 18, 26, 0, 27], ['Q', -18, 26, -20, -4], ['Z']])),
        o: oval(11, 12, 3) + omega(14, -14, 8),
        sad: stroke(m([['M', -24, 8], ['Q', -12, -6, 0, 2], ['Q', 12, -6, 24, 8]]), 7),
        flat: omega(22, -2, 8),
      },
    }
  },
  'mouth-grin': () => ({
    label: 'Grin',
    variants: {
      neutral: smileArc(34, 26, -8) + stroke(m([['M', -38, -12], ['L', -32, -5]]), 6) + stroke(m([['M', 38, -12], ['L', 32, -5]]), 6),
      happy: openMouth(dShape(36, -10, 34)) + teeth(36, -10, 10) + stroke(dShape(36, -10, 34), 7),
      'talk-small': openMouth(dShape(22, -6, 20)) + teeth(22, -6, 7) + stroke(dShape(22, -6, 20), 7),
      'talk-wide': openMouth(dShape(28, -10, 32)) + teeth(28, -10, 9) + stroke(dShape(28, -10, 32), 7),
      o: oval(15, 14, 2),
      sad: stroke(m([['M', -32, 12], ['Q', 0, -12, 32, 12]]), 8),
      flat: stroke(m([['M', -30, 2], ['Q', 0, 6, 30, 2]]), 8),
    },
  }),
  'mouth-small': () => ({
    label: 'Small',
    variants: {
      neutral: smileArc(10, 9, -1),
      happy: openMouth(dShape(12, -4, 15, 1)),
      'talk-small': oval(7, 6, 2),
      'talk-wide': oval(10, 10, 3),
      o: oval(7, 8, 2),
      sad: frownArc(9, 7, 6),
      flat: flatLine(8),
    },
  }),
  'mouth-fang': () => ({
    label: 'Fang',
    variants: {
      neutral: smileArc(24, 18) + fang(12, 4),
      happy: openMouth(dShape(28, -8, 30)) + fang(12, -6) + stroke(dShape(28, -8, 30), 7),
      'talk-small': oval(13, 9, 2) + fang(5, -5, 0.8),
      'talk-wide': openMouth(dShape(20, -10, 28, 2)) + fang(9, -9) + stroke(dShape(20, -10, 28, 2), 7),
      o: oval(12, 13, 2) + fang(4, -9, 0.8),
      sad: frownArc(20, 14) + fang(10, 3),
      flat: flatLine(15) + fang(8, 4),
    },
  }),
}

/** Every face layer file, the manifest's face section and the pupil config. */
export function faceFiles() {
  const files = {}
  const defs = { eyes: {}, brows: {}, mouth: {} }
  const pupilConfig = {}
  const round = (v) => Math.round(v * 10000) / 10000
  for (const id of FACE_IDS.eyes) {
    const style = EYE_STYLES[id]()
    const variants = {}
    for (const v of EYE_VARIANTS) {
      variants[v] = `face/${id}/${v}.svg`
      files[variants[v]] = svg(style.variants[v])
    }
    files[`face/${id}/pupils.svg`] = style.pupils
    defs.eyes[id] = { label: style.label, variants, pupils: `face/${id}/pupils.svg`, pupilVariants: style.pupilVariants }
    pupilConfig[id] = { rangeX: round(style.pupilConfig.rangeX), rangeY: round(style.pupilConfig.rangeY), scale: style.pupilConfig.scale }
  }
  for (const id of FACE_IDS.brows) {
    const style = BROW_STYLES[id]()
    const variants = {}
    for (const v of BROW_VARIANTS) {
      variants[v] = `face/${id}/${v}.svg`
      files[variants[v]] = svg(style.variants[v])
    }
    defs.brows[id] = { label: style.label, variants }
  }
  for (const id of FACE_IDS.mouth) {
    const style = MOUTH_STYLES[id]()
    const variants = {}
    for (const v of MOUTH_VARIANTS) {
      variants[v] = `face/${id}/${v}.svg`
      // Drawn at a comfortable size for editing, then enlarged to read at small sizes.
      files[variants[v]] = svg(`<g transform="translate(${MX} ${MY}) scale(${MOUTH_SCALE}) translate(${-MX} ${-MY})">${style.variants[v]}</g>`)
    }
    defs.mouth[id] = { label: style.label, variants }
  }
  return { files, defs, pupilConfig }
}
