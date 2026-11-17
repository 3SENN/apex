/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { checkLayout, labelOf, selectorOf, type LayoutNode, type LayoutSnapshot } from '../src/main/smokeLayout/check'
import { LAYOUT_SIZES, layoutPages, sizeLabel } from '../src/main/smokeLayout/pages'
import { SETTINGS_PAGES } from '../src/shared/url'

// Box fixtures for the layout checker: no DOM, just what the collector reports.

type Box = Partial<LayoutNode> & { x: number; y: number; w: number; h: number }

function node(p: number, box: Box): LayoutNode {
  return {
    p,
    end: 0,
    sel: 'div',
    tag: 'div',
    text: '',
    own: false,
    sw: box.cw ?? box.w,
    cw: box.w,
    sh: box.ch ?? box.h,
    ch: box.h,
    pw: 0,
    ox: 'visible',
    oy: 'visible',
    disp: 'block',
    pos: 'static',
    to: 'clip',
    ws: 'normal',
    clamp: false,
    brk: false,
    inter: false,
    fs: 14,
    minc: 0,
    tx: box.x,
    ty: box.y,
    tw: box.w,
    th: box.h,
    ...box,
  }
}

/** Builds a snapshot from [parent, box] pairs in document order, filling in `end`. */
function snap(items: Array<[number, Box]>, extra: Partial<LayoutSnapshot> = {}): LayoutSnapshot {
  const nodes = items.map(([p, b]) => node(p, b))
  for (let i = nodes.length - 1; i >= 0; i--) {
    let end = i + 1
    for (let j = i + 1; j < nodes.length; j++) {
      let q = nodes[j]!.p
      while (q > i) q = nodes[q]!.p
      if (q === i) end = j + 1
      else break
    }
    nodes[i]!.end = end
  }
  return { vw: 1000, vh: 800, docW: 1000, rootOy: 'hidden', nodes, ...extra }
}

const root: [number, Box] = [-1, { x: 0, y: 0, w: 1000, h: 800, sel: 'body', tag: 'body', ox: 'hidden', oy: 'hidden' }]
const kinds = (s: LayoutSnapshot): string[] => checkLayout(s).map((i) => i.kind).sort()

describe('the layout checker', () => {
  it('passes a clean grid of cards', () => {
    const s = snap([
      root,
      [0, { x: 0, y: 0, w: 640, h: 100, sel: '.grid', disp: 'grid' }],
      [1, { x: 0, y: 0, w: 300, h: 100, sel: '.card' }],
      [2, { x: 8, y: 8, w: 284, h: 20, sel: '.card__name', text: 'Calendar', own: true }],
      [1, { x: 340, y: 0, w: 300, h: 100, sel: '.card' }],
      [4, { x: 348, y: 8, w: 284, h: 20, sel: '.card__name', text: 'Drive', own: true }],
    ])
    expect(checkLayout(s)).toEqual([])
  })

  it('reports the page scrolling sideways', () => {
    expect(kinds(snap([root], { docW: 1040 }))).toEqual(['page-overflow'])
  })

  it('reports a card whose content runs into the next one, once per selector', () => {
    // The connectors bug: a grid cell (overflow visible) holds a tile wider than the cell.
    const s = snap([
      root,
      [0, { x: 0, y: 0, w: 528, h: 84, sel: '.sp-tile-grid', disp: 'grid', sw: 760 }],
      [1, { x: 0, y: 0, w: 248, h: 84, sel: 'div[role=listitem]', sw: 480 }],
      [2, { x: 0, y: 0, w: 480, h: 84, sel: '.sp-conn-tile', tag: 'button', inter: true, disp: 'flex' }],
      [3, { x: 60, y: 20, w: 380, h: 20, sel: '.sp-conn-tile__desc', text: 'Read and send mail, search threads', own: true, to: 'ellipsis', ox: 'hidden', ws: 'nowrap' }],
      [1, { x: 280, y: 0, w: 248, h: 84, sel: 'div[role=listitem]', sw: 480 }],
      [5, { x: 280, y: 0, w: 480, h: 84, sel: '.sp-conn-tile', tag: 'button', inter: true, disp: 'flex' }],
    ], { vw: 700, docW: 700 })
    const issues = checkLayout(s)
    const overflow = issues.find((i) => i.kind === 'overflow')
    expect(overflow?.selector).toBe('.sp-tile-grid div[role=listitem]')
    expect(overflow?.count).toBe(2)
    // The grid itself spills too, but only the deepest container is reported.
    expect(issues.some((i) => i.kind === 'overflow' && i.selector === 'body .sp-tile-grid')).toBe(false)
    expect(issues.find((i) => i.kind === 'overlap')?.text).toContain('Read and send mail')
    // The second tile runs past the window's right edge.
    expect(issues.find((i) => i.kind === 'offscreen')?.selector).toBe('.sp-tile-grid div[role=listitem] .sp-conn-tile')
  })

  it('reports flex siblings that cover each other, and not ones that touch', () => {
    const touch = snap([root, [0, { x: 0, y: 0, w: 200, h: 40, disp: 'flex', sel: '.row' }], [1, { x: 0, y: 0, w: 100, h: 40 }], [1, { x: 100, y: 0, w: 100, h: 40 }]])
    expect(checkLayout(touch)).toEqual([])
    const cover = snap([root, [0, { x: 0, y: 0, w: 200, h: 40, disp: 'flex', sel: '.row' }], [1, { x: 0, y: 0, w: 110, h: 40, text: 'Name', own: true }], [1, { x: 100, y: 0, w: 100, h: 40, text: 'Plus', own: true }]])
    expect(kinds(cover)).toEqual(['overlap'])
    expect(checkLayout(cover)[0]!.text).toBe('Name / Plus')
  })

  it('lets a tray tuck under the composer when no text or control lands on another', () => {
    const s = snap([
      root,
      [0, { x: 0, y: 0, w: 340, h: 300, disp: 'flex', sel: '.chat-view' }],
      [1, { x: 0, y: 0, w: 340, h: 120, sel: '.chat-composer' }],
      [2, { x: 290, y: 70, w: 36, h: 36, tag: 'button', inter: true, sel: '.mic' }],
      [1, { x: 0, y: 100, w: 340, h: 70, sel: '.chat-start__tray' }],
      [4, { x: 16, y: 135, w: 80, h: 24, tag: 'button', inter: true, sel: '.nt-chip', text: 'Skills', own: true }],
    ])
    expect(checkLayout(s)).toEqual([])
  })

  it('leaves out absolutely positioned siblings and block (non flex/grid) parents', () => {
    const s = snap([
      root,
      [0, { x: 0, y: 0, w: 200, h: 40, disp: 'flex' }],
      [1, { x: 0, y: 0, w: 100, h: 40 }],
      [1, { x: 50, y: 0, w: 100, h: 40, pos: 'absolute' }],
      [0, { x: 0, y: 100, w: 200, h: 40 }],
      [4, { x: 0, y: 100, w: 120, h: 40 }],
      [4, { x: 60, y: 100, w: 120, h: 40, pos: 'relative' }],
    ])
    expect(checkLayout(s)).toEqual([])
  })

  it('reports text that runs past its box without an ellipsis', () => {
    const s = snap([root, [0, { x: 0, y: 0, w: 100, h: 20, sel: '.title', text: 'A very long title', own: true, sw: 160, ws: 'nowrap', ox: 'hidden', tw: 160 }]])
    expect(kinds(s)).toEqual(['text-overflow'])
    const ellipsis = snap([root, [0, { x: 0, y: 0, w: 100, h: 20, text: 'A very long title', own: true, sw: 160, ws: 'nowrap', ox: 'hidden', to: 'ellipsis' }]])
    expect(checkLayout(ellipsis)).toEqual([])
    const scroller = snap([root, [0, { x: 0, y: 0, w: 100, h: 20, text: 'code', own: true, sw: 160, ox: 'auto' }]])
    expect(checkLayout(scroller)).toEqual([])
  })

  it('reports wrapped text spilling below a fixed height, unless it is clamped', () => {
    const spill = snap([root, [0, { x: 0, y: 0, w: 200, h: 40, text: 'Three lines of description in a two-line box', own: true, sh: 60, th: 60 }]])
    expect(kinds(spill)).toEqual(['text-overflow'])
    const clamped = snap([root, [0, { x: 0, y: 0, w: 200, h: 40, text: 'Three lines', own: true, sh: 60, oy: 'hidden', ox: 'hidden', clamp: true }]])
    expect(checkLayout(clamped)).toEqual([])
  })

  it('does not count an absolutely positioned badge as a container spilling', () => {
    // scrollWidth includes the badge, but no in-flow content leaves the card.
    const s = snap([root, [0, { x: 0, y: 0, w: 200, h: 80, sel: '.card', sw: 210 }], [1, { x: 190, y: -6, w: 20, h: 20, pos: 'absolute', sel: '.badge' }]])
    expect(checkLayout(s)).toEqual([])
  })

  it('lets wide content spill into a scroller it sits straight in', () => {
    const s = snap([root, [0, { x: 0, y: 0, w: 600, h: 400, ox: 'auto', oy: 'auto', sel: '.vs__scroll' }], [1, { x: 0, y: 0, w: 600, h: 400, sel: '.vs__source', sw: 900 }], [2, { x: 0, y: 0, w: 900, h: 20, sel: '.vs__line' }]])
    expect(checkLayout(s)).toEqual([])
    const card = snap([root, [0, { x: 0, y: 0, w: 600, h: 400, ox: 'auto', oy: 'auto' }], [1, { x: 0, y: 0, w: 600, h: 400 }], [2, { x: 0, y: 0, w: 200, h: 80, sel: '.card', sw: 260 }], [3, { x: 0, y: 0, w: 260, h: 80 }]])
    expect(checkLayout(card).map((i) => `${i.kind} ${i.selector} ${i.detail}`)).toEqual(['overflow .card content 260 in 200 wide'])
  })

  it('reports a control cut off by the window edge, but not one in a scroller', () => {
    const edge = snap([root, [0, { x: 950, y: 10, w: 80, h: 30, sel: '.save', tag: 'button', inter: true }]])
    expect(kinds(edge)).toEqual(['offscreen'])
    const scrolled = snap([
      root,
      [0, { x: 0, y: 0, w: 1000, h: 800, ox: 'hidden', oy: 'auto', sel: '.scroller' }],
      [1, { x: 10, y: 780, w: 80, h: 30, tag: 'button', inter: true }],
      [1, { x: 10, y: 2000, w: 80, h: 30, tag: 'button', inter: true }],
    ])
    expect(checkLayout(scrolled)).toEqual([])
  })

  it('reports a control clipped by a hidden-overflow toolbar, and skips fully hidden ones', () => {
    const s = snap([
      root,
      [0, { x: 0, y: 0, w: 300, h: 40, ox: 'hidden', oy: 'hidden', sel: '.toolbar', disp: 'flex' }],
      [1, { x: 260, y: 5, w: 80, h: 30, tag: 'button', inter: true, sel: '.share' }],
      [1, { x: 400, y: 5, w: 80, h: 30, tag: 'button', inter: true, sel: '.gone' }],
    ])
    const issues = checkLayout(s)
    expect(issues.map((i) => `${i.kind} ${i.selector}`)).toEqual(['clipped .toolbar .share'])
  })

  it('reports text cut off by a clipping panel, not text an ellipsis keeps inside its box', () => {
    const bubble = snap([
      root,
      [0, { x: 400, y: 0, w: 400, h: 800, ox: 'hidden', oy: 'hidden', sel: '.chat-panel' }],
      [1, { x: 620, y: 200, w: 260, h: 40, pos: 'absolute', sel: '.speech', text: 'Hey, it is Pip. What are we tackling?', own: true, tx: 632, tw: 236 }],
    ])
    expect(checkLayout(bubble).map((i) => `${i.kind} ${i.selector}`)).toEqual(['clipped .chat-panel .speech'])
    const row = snap([
      root,
      [0, { x: 0, y: 0, w: 300, h: 40, ox: 'hidden', oy: 'hidden', sel: '.row', disp: 'flex' }],
      [1, { x: 0, y: 0, w: 300, h: 40, ox: 'hidden', to: 'ellipsis', ws: 'nowrap', text: 'A long name that runs on', own: true, sw: 500, tw: 500 }],
    ])
    expect(checkLayout(row)).toEqual([])
    // An inline value inside an ellipsised log line is cut with the line.
    const line = snap([
      root,
      [0, { x: 0, y: 0, w: 300, h: 20, ox: 'hidden', to: 'ellipsis', ws: 'nowrap', sel: '.dg-log-row__message', text: 'Error: no translation', own: true, sw: 520, tw: 520 }],
      [1, { x: 180, y: 0, w: 340, h: 20, disp: 'inline', sel: '.dg-log-row__data', text: 'file=useT.js line=11233', own: true }],
    ])
    expect(checkLayout(line)).toEqual([])
  })

  it('does not call text overflowing when only an absolutely positioned child widens the box', () => {
    const s = snap([root, [0, { x: 0, y: 0, w: 282, h: 48, sel: '.bubble', text: 'Compare two laptops', own: true, sw: 285, tx: 20, tw: 200 }]])
    expect(checkLayout(s)).toEqual([])
  })

  it('ignores a row a few px shorter than its tallest child', () => {
    const s = snap([root, [0, { x: 0, y: 0, w: 300, h: 20, sel: '.head', disp: 'flex', sh: 24 }], [1, { x: 200, y: -2, w: 60, h: 24 }]])
    expect(checkLayout(s)).toEqual([])
  })

  it('reports a text column crushed narrower than a word', () => {
    const crushed = snap([root, [0, { x: 0, y: 0, w: 20, h: 200, text: 'Permissions', own: true, brk: true, minc: 80 }]])
    expect(kinds(crushed)).toEqual(['squeezed'])
    const ellipsis = snap([root, [0, { x: 0, y: 0, w: 16, h: 20, text: 'Permissions', own: true, ox: 'hidden', to: 'ellipsis', ws: 'nowrap', sw: 80 }]])
    expect(kinds(ellipsis)).toEqual(['squeezed'])
    // A long link that breaks inside a wide bubble is fine.
    const link = snap([root, [0, { x: 0, y: 0, w: 400, h: 40, text: 'https://example.com/a/very/long/path', own: true, brk: true, minc: 600 }]])
    expect(checkLayout(link)).toEqual([])
  })

  it('names elements by their nearest classed ancestors and labels them with text', () => {
    const s = snap([root, [0, { x: 0, y: 0, w: 10, h: 10, sel: '.page' }], [1, { x: 0, y: 0, w: 10, h: 10 }], [2, { x: 0, y: 0, w: 10, h: 10, sel: 'button', text: 'Save', own: true }]])
    expect(selectorOf(s.nodes, 3)).toBe('.page button')
    expect(labelOf(s.nodes, 1)).toBe('Save')
  })
})

describe('the layout audit pages and sizes', () => {
  it('covers every Settings page, the new tab, and pages that need a target only when given one', () => {
    const none = layoutPages({ chatId: null, companionId: null, fileUrl: null, sourceUrl: null })
    const names = none.map((p) => p.name)
    expect(names[0]).toBe('newtab')
    for (const s of SETTINGS_PAGES) expect(names).toContain(`settings-${s.id}`)
    expect(names).toContain('connectors')
    expect(names).not.toContain('chat')
    expect(names).not.toContain('library')
    const all = layoutPages({ chatId: 'c1', companionId: 'pip', fileUrl: 'atelier://file?src=x', sourceUrl: 'atelier://view-source?url=y' })
    expect(all.find((p) => p.name === 'chat')?.url).toBe('atelier://chat/c1')
    expect(all.find((p) => p.name === 'companion')?.url).toBe('atelier://companion/pip')
    expect(new Set(all.map((p) => p.name)).size).toBe(all.length)
  })

  it('opens the four audit widths and the panel at 1280', () => {
    expect(LAYOUT_SIZES.map((s) => sizeLabel(s.width, s.height, s.panel))).toEqual(['900x700', '1280x800', '1470x923', '1920x1080', '1280x800+panel'])
  })
})
