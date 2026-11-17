/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The layout checker's pure half: it reads a snapshot of laid-out boxes (the
// in-page collector in collect.ts makes one) and reports what is visibly
// wrong. No DOM here, so tests/layout-check.test.ts feeds it box fixtures.
//
// Kinds:
//  - page-overflow: the document itself scrolls sideways.
//  - overflow: a container that does not clip lets in-flow content spill out.
//  - text-overflow: text runs past its box with no ellipsis (or past a clamp).
//  - overlap: two in-flow siblings of a flex or grid parent whose text or
//    controls land on each other.
//  - offscreen: a control is partly outside the window.
//  - clipped: a control is partly cut off by a clipping (non-scrolling) ancestor.
//  - squeezed: a text box narrower than its content can be (crushed column).

export type LayoutKind = 'page-overflow' | 'overflow' | 'text-overflow' | 'overlap' | 'offscreen' | 'clipped' | 'squeezed'

/** One element, as the collector saw it. Boxes are viewport CSS px. */
export interface LayoutNode {
  /** Parent index in `nodes` (-1 for the root); nodes are in document (pre-) order. */
  p: number
  /** One past the last descendant's index. */
  end: number
  /** A short selector part: .class.class, tag[role=x], tag#id or tag. */
  sel: string
  tag: string
  /** Own text (direct text and inline children), or an accessible label. */
  text: string
  /** Whether `text` is the element's own visible text. */
  own: boolean
  x: number
  y: number
  w: number
  h: number
  sw: number
  cw: number
  sh: number
  ch: number
  /** Horizontal padding (left + right). */
  pw: number
  ox: string
  oy: string
  disp: string
  pos: string
  /** text-overflow */
  to: string
  /** white-space */
  ws: string
  /** -webkit-line-clamp is set. */
  clamp: boolean
  /** overflow-wrap / word-break let words break anywhere. */
  brk: boolean
  /** A control: button, link, field, tab, menu item... */
  inter: boolean
  /** font-size in px */
  fs: number
  /** The widest unbreakable word of the own text, in px (0 without text). */
  minc: number
  /** Where the own text is drawn, unclipped (the element's box when it has none). */
  tx: number
  ty: number
  tw: number
  th: number
}

export interface LayoutSnapshot {
  /** Viewport size. */
  vw: number
  vh: number
  /** document.documentElement.scrollWidth */
  docW: number
  /** The root element's computed overflow-y: 'hidden' or 'clip' pins the page to the window. */
  rootOy: string
  nodes: LayoutNode[]
}

export interface LayoutBox {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutIssue {
  kind: LayoutKind
  selector: string
  text: string
  box: LayoutBox
  /** How many elements matched the same kind and selector (they are reported once). */
  count: number
  /** The measurement behind it: "content 480 in 248 wide", "covers 200x84"... */
  detail: string
}

const SCROLLS = new Set(['auto', 'scroll', 'overlay'])
const CLIPS = new Set(['hidden', 'clip'])
const FLEX_GRID = new Set(['flex', 'inline-flex', 'grid', 'inline-grid'])
/** Elements whose scroll size is their own business (fields scroll their value) or that have no CSS box children. */
const OPAQUE = new Set(['input', 'textarea', 'select', 'svg', 'img', 'canvas', 'video', 'iframe', 'picture', 'object', 'embed', 'audio'])
const WRAPS = new Set(['normal', 'pre-wrap', 'pre-line', 'break-spaces'])

const scrolls = (v: string): boolean => SCROLLS.has(v)
const clips = (v: string): boolean => CLIPS.has(v) || SCROLLS.has(v)
const inFlow = (n: LayoutNode): boolean => n.pos !== 'absolute' && n.pos !== 'fixed'
const boxed = (n: LayoutNode): boolean => n.disp !== 'inline' && n.cw > 0 && !OPAQUE.has(n.tag)

interface Interval {
  lo: number
  hi: number
}
const ALL: Interval = { lo: -Infinity, hi: Infinity }
const cut = (a: Interval, lo: number, hi: number): Interval => ({ lo: Math.max(a.lo, lo), hi: Math.min(a.hi, hi) })

/** A readable selector: the element's part after its two nearest ancestors that have classes. */
export function selectorOf(nodes: readonly LayoutNode[], i: number): string {
  const parts = [nodes[i]!.sel]
  let p = nodes[i]!.p
  while (p >= 0 && parts.length < 3) {
    const sel = nodes[p]!.sel
    if (sel.startsWith('.') || sel.includes('[role=')) parts.unshift(sel)
    p = nodes[p]!.p
  }
  return parts.join(' ')
}

/** The node's text, or its first descendant's. */
export function labelOf(nodes: readonly LayoutNode[], i: number): string {
  const n = nodes[i]!
  if (n.text) return n.text.slice(0, 60)
  for (let j = i + 1; j < n.end && j < nodes.length; j++) if (nodes[j]!.text) return nodes[j]!.text.slice(0, 60)
  return ''
}

/**
 * Where each node's in-flow content reaches: its own box, its drawn text
 * (when it does not clip), and its in-flow descendants' reach on the axes it
 * does not clip.
 */
function extents(nodes: readonly LayoutNode[]): LayoutBox[] {
  // A zero-size box (a wrapper) reaches only as far as its children do.
  const ext = nodes.map((n) => {
    const r = n.w < 1 || n.h < 1 ? { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity } : { l: n.x, t: n.y, r: n.x + n.w, b: n.y + n.h }
    if (n.own && n.w >= 1 && n.h >= 1) {
      // Text drawn past the box reaches as far as it is drawn, unless the box clips it.
      if (!clips(n.ox)) {
        r.l = Math.min(r.l, n.tx)
        r.r = Math.max(r.r, n.tx + n.tw)
      }
      if (!clips(n.oy)) {
        r.t = Math.min(r.t, n.ty)
        r.b = Math.max(r.b, n.ty + n.th)
      }
    }
    return r
  })
  for (let i = nodes.length - 1; i > 0; i--) {
    const n = nodes[i]!
    if (n.p < 0 || !inFlow(n)) continue
    const parent = nodes[n.p]!
    const e = ext[i]!
    const pe = ext[n.p]!
    if (e.l > e.r) continue
    if (!clips(parent.ox)) {
      pe.l = Math.min(pe.l, e.l)
      pe.r = Math.max(pe.r, e.r)
    }
    if (!clips(parent.oy)) {
      pe.t = Math.min(pe.t, e.t)
      pe.b = Math.max(pe.b, e.b)
    }
  }
  return ext.map((e, i) => (e.l > e.r ? { x: nodes[i]!.x, y: nodes[i]!.y, w: 0, h: 0 } : { x: e.l, y: e.t, w: e.r - e.l, h: e.b - e.t }))
}

function contentCollides(a: readonly LayoutBox[], b: readonly LayoutBox[]): boolean {
  for (const x of a) {
    for (const y of b) {
      const o = overlapArea(x, y)
      if (o.w > 2 && o.h > 2) return true
    }
  }
  return false
}

function overlapArea(a: LayoutBox, b: LayoutBox): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  }
}

/** The part of a node's text its own box lets show (an ellipsis or a clip keeps the rest inside). */
function visibleText(n: LayoutNode): LayoutBox {
  let l = n.tx
  let r = n.tx + n.tw
  let t = n.ty
  let b = n.ty + n.th
  if (clips(n.ox)) {
    l = Math.max(l, n.x)
    r = Math.min(r, n.x + n.w)
  }
  if (clips(n.oy)) {
    t = Math.max(t, n.y)
    b = Math.min(b, n.y + n.h)
  }
  return { x: l, y: t, w: Math.max(0, r - l), h: Math.max(0, b - t) }
}

function spillText(n: LayoutNode, x: boolean, y: boolean): string {
  return [x && `content ${n.sw} in ${n.cw} wide`, y && `content ${n.sh} in ${n.ch} high`].filter(Boolean).join(', ')
}

/** Every layout problem in a snapshot, one entry per kind and selector. */
export function checkLayout(snap: LayoutSnapshot): LayoutIssue[] {
  const { nodes, vw, vh } = snap
  const found: Array<{ kind: LayoutKind; i: number; text?: string; detail: string }> = []
  const pageScrollsY = !CLIPS.has(snap.rootOy)

  // Per axis: the interval an element can show in, and whether the window edge still bounds it (no scroller between).
  const clipX: Interval[] = []
  const clipY: Interval[] = []
  const vpX: boolean[] = []
  const vpY: boolean[] = []
  const shown: boolean[] = []
  nodes.forEach((n, i) => {
    if (n.p < 0 || n.pos === 'fixed') {
      clipX[i] = { lo: 0, hi: vw }
      clipY[i] = pageScrollsY ? ALL : { lo: 0, hi: vh }
      vpX[i] = true
      vpY[i] = !pageScrollsY
    } else {
      const p = nodes[n.p]!
      clipX[i] = scrolls(p.ox) ? ALL : CLIPS.has(p.ox) ? cut(clipX[n.p]!, p.x, p.x + p.w) : clipX[n.p]!
      clipY[i] = scrolls(p.oy) ? ALL : CLIPS.has(p.oy) ? cut(clipY[n.p]!, p.y, p.y + p.h) : clipY[n.p]!
      vpX[i] = vpX[n.p]! && !scrolls(p.ox)
      vpY[i] = vpY[n.p]! && !scrolls(p.oy)
    }
    const cx = clipX[i]!
    const cy = clipY[i]!
    shown[i] = n.w >= 1 && n.h >= 1 && n.x + n.w > cx.lo && n.x < cx.hi && n.y + n.h > cy.lo && n.y < cy.hi
  })

  const ext = extents(nodes)
  const spillX: boolean[] = []
  const spillY: boolean[] = []

  nodes.forEach((n, i) => {
    if (!shown[i]) return
    // ---- text and containers that spill ----
    if (boxed(n)) {
      let text = false
      if (n.own) {
        // The browser says the content is wider (or taller) than the box, and the text itself is drawn past the box.
        const overX = n.sw > n.cw + 1 && (n.tx + n.tw > n.x + n.w + 1 || n.tx < n.x - 1) && !scrolls(n.ox) && !(n.to === 'ellipsis' && CLIPS.has(n.ox))
        const overY = n.sh > n.ch + 2 && (n.ty + n.th > n.y + n.h + 1 || n.ty < n.y - 1) && !scrolls(n.oy) && !n.clamp
        if (overX || overY) {
          found.push({ kind: 'text-overflow', i, detail: spillText(n, overX, overY) })
          spillX[i] = overX
          spillY[i] = overY
          text = true
        } else {
          const content = n.cw - n.pw
          const crushed = n.to === 'ellipsis' && CLIPS.has(n.ox) && n.text.length > 3 && n.cw < 2 * n.fs
          const broken = WRAPS.has(n.ws) && n.brk && n.minc > 0 && content < Math.min(n.minc, 6 * n.fs) - 2
          if (crushed || broken) found.push({ kind: 'squeezed', i, detail: crushed ? `${n.cw} wide with an ellipsis` : `${Math.round(content)} wide for a ${n.minc} word` })
        }
      }
      if (!text) {
        const e = ext[i]!
        // Content that spills straight into a scroller on that axis is scrolled to, not lost. A few px of height is harmless; width is not.
        const parent = n.p >= 0 ? nodes[n.p]! : null
        const overX = n.ox === 'visible' && n.sw > n.cw + 1 && (e.x + e.w > n.x + n.w + 1 || e.x < n.x - 1) && !(parent && scrolls(parent.ox))
        const overY = n.oy === 'visible' && n.sh > n.ch + 8 && (e.y + e.h > n.y + n.h + 8 || e.y < n.y - 8) && !(parent && scrolls(parent.oy))
        if (overX || overY) {
          found.push({ kind: 'overflow', i, detail: spillText(n, overX, overY) })
          spillX[i] = overX
          spillY[i] = overY
        }
      }
    }
    // ---- controls, and text, cut off by the window or a clipping ancestor ----
    // Inline pieces of a parent's text (a link, a highlighted value) are cut, or ellipsised, with that text: the parent answers for them.
    const pieceOfText = n.disp === 'inline' && n.p >= 0 && nodes[n.p]!.own
    if ((n.inter || n.own) && !pieceOfText) {
      // A control by its box; text by where it is drawn, as far as its own box lets it show.
      const b = n.inter ? { x: n.x, y: n.y, w: n.w, h: n.h } : visibleText(n)
      const cx = clipX[i]!
      const cy = clipY[i]!
      const seen = b.w > 0 && b.h > 0 && b.x + b.w > cx.lo && b.x < cx.hi && b.y + b.h > cy.lo && b.y < cy.hi
      const outX = b.x < -1 || b.x + b.w > vw + 1
      const outY = b.y < -1 || b.y + b.h > vh + 1
      if (!seen) {
        // fully hidden: nothing to see, nothing cut
      } else if ((vpX[i] && outX) || (vpY[i] && outY)) found.push({ kind: 'offscreen', i, detail: `window ${vw}x${vh}` })
      else {
        const hidden = Math.max(cx.lo - b.x, b.x + b.w - cx.hi, cy.lo - b.y, b.y + b.h - cy.hi)
        if (hidden > 2) found.push({ kind: 'clipped', i, detail: `${Math.round(hidden)}px cut off` })
      }
    }
  })

  // ---- in-flow siblings of a flex or grid parent whose content runs into each other ----
  // Boxes may overlap on purpose (a tray tucked under a composer); text or a control landing on the other's text or control is the defect.
  const contentOf = new Map<number, LayoutBox[]>()
  const content = (i: number): LayoutBox[] => {
    let boxes = contentOf.get(i)
    if (!boxes) {
      boxes = []
      for (let j = i; j < nodes[i]!.end && j < nodes.length && boxes.length < 400; j++) {
        const m = nodes[j]!
        if (!shown[j] || !(m.inter || m.own)) continue
        const b = m.inter ? { x: m.x, y: m.y, w: m.w, h: m.h } : visibleText(m)
        if (b.w > 0 && b.h > 0) boxes.push(b)
      }
      contentOf.set(i, boxes)
    }
    return boxes
  }
  const kids = new Map<number, number[]>()
  nodes.forEach((n, i) => {
    if (n.p < 0 || !shown[i] || !inFlow(n) || !FLEX_GRID.has(nodes[n.p]!.disp)) return
    const list = kids.get(n.p) ?? []
    list.push(i)
    kids.set(n.p, list)
  })
  for (const list of kids.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const ia = list[a]!
        const ib = list[b]!
        const o = overlapArea(ext[ia]!, ext[ib]!)
        if (o.w > 2 && o.h > 2 && contentCollides(content(ia), content(ib))) found.push({ kind: 'overlap', i: ia, text: `${labelOf(nodes, ia)} / ${labelOf(nodes, ib)}`.slice(0, 90), detail: `covers ${selectorOf(nodes, ib).split(' ').pop()} by ${Math.round(o.w)}x${Math.round(o.h)}` })
      }
    }
  }

  // A spill shows on every container up to the one that clips it: report only the deepest.
  const covered = new Set<number>()
  for (const f of found) {
    if (f.kind !== 'overflow' && f.kind !== 'text-overflow') continue
    for (let p = nodes[f.i]!.p; p >= 0; p = nodes[p]!.p) {
      if ((spillX[f.i] && spillX[p]) || (spillY[f.i] && spillY[p])) covered.add(p)
    }
  }

  const out = new Map<string, LayoutIssue>()
  if (snap.docW > vw + 1) out.set('page-overflow html', { kind: 'page-overflow', selector: 'html', text: '', box: { x: 0, y: 0, w: snap.docW, h: vh }, count: 1, detail: `${snap.docW} wide in a ${vw} window` })
  for (const f of found) {
    if (f.kind === 'overflow' && covered.has(f.i)) continue
    const n = nodes[f.i]!
    const selector = selectorOf(nodes, f.i)
    const key = `${f.kind} ${selector}`
    const seen = out.get(key)
    if (seen) seen.count++
    else out.set(key, { kind: f.kind, selector, text: f.text ?? labelOf(nodes, f.i), box: { x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h) }, count: 1, detail: f.detail })
  }
  return [...out.values()]
}
