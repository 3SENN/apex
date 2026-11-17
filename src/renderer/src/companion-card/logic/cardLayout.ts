/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure geometry for the companion card: where it sits in the content area,
// how wide it may be, how the hero scales with it, and where the tab row's
// underline goes. Card-relative numbers follow docs/design-spec.md
// (a 607 px wide card is the design proportion).

export interface Size {
  width: number
  height: number
}

/** Gaps between the card and the content area's top, right and bottom edges. */
export const CARD_INSET = { top: 9, right: 9, bottom: 8 } as const
/** Share of the content area's width the card takes until it is resized. */
export const CARD_DEFAULT_SHARE = 0.52
export const CARD_MIN_WIDTH = 440
/** Page left visible beside the widest card, so there is always some to click. */
export const CARD_PAGE_KEEP = 56
/** The look editor widens the card leftward by this much, right edge fixed (DS-43: 608 → 900). */
export const CARD_LOOK_GROW = 292
/** The default card's width while editing its look. */
export const CARD_LOOK_WIDTH = 900

export interface CardFrame {
  /** 'float' is the inset card over the washed page; 'column' fills a chat column. */
  mode: 'float' | 'column'
  top: number
  right: number
  bottom: number
  width: number
  /** The range the resize strip allows. */
  min: number
  max: number
}

export interface CardFrameOptions {
  /** A remembered share of the region's width, or null for the default. */
  share: number | null
  /** The look editor is open, so the card widens. */
  looking: boolean
  mode: 'float' | 'column'
}

/** The card's box inside its region (the content area, or a chat column). */
export function cardFrame(region: Size, o: CardFrameOptions): CardFrame {
  if (o.mode === 'column') {
    const width = Math.max(0, Math.round(region.width))
    return { mode: 'column', top: 0, right: 0, bottom: 0, width, min: width, max: width }
  }
  const room = Math.max(0, region.width - CARD_INSET.right)
  const max = Math.max(Math.min(CARD_MIN_WIDTH, room), room - CARD_PAGE_KEEP)
  const min = Math.min(CARD_MIN_WIDTH, max)
  const share = o.share !== null && Number.isFinite(o.share) && o.share > 0 ? o.share : CARD_DEFAULT_SHARE
  let width = clamp(Math.round(region.width * share), min, max)
  if (o.looking) width = clamp(width + CARD_LOOK_GROW, min, max)
  return { mode: 'float', ...CARD_INSET, width, min, max }
}

/** The share to remember after a resize to `width`. */
export function shareForWidth(width: number, regionWidth: number): number | null {
  if (!(regionWidth > 0) || !(width > 0)) return null
  return Math.round((width / regionWidth) * 1000) / 1000
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.min(hi, Math.max(lo, v))
}

// ---- the hero ----

/** The card width the hero's proportions are designed at. */
export const HERO_DESIGN_WIDTH = 607
/**
 * How much bigger the live view's square is than the figure it draws. The
 * view leaves 1.18 of room (companion/layout.ts frameBounds) and frames the
 * front of the bounds under perspective, so the body (near z = 0) comes out
 * smaller still: measured, a full figure fills about 1/1.29 of its square.
 */
export const FIGURE_MARGIN = 1.29
/** The figure's visible height at the design width (DS-40). */
export const FIGURE_HEIGHT = 233

export interface HeroMetrics {
  scale: number
  /** The hero's height, from the tab hairline to where the wash ends. */
  height: number
  /** The live view's square side. */
  figureSize: number
  /** The live view's top, from the hero's top. */
  figureTop: number
  /** The figure's head top and feet, from the hero's top. */
  headY: number
  feetY: number
  /** The name row's vertical centre (level with the shins). */
  nameY: number
  /** The pattern band (DS-39): visible from about 40 px, gone about 40 px above the name row. */
  fieldTop: number
  fieldHeight: number
  /** The look pill's top and right inset. */
  pillTop: number
  pillRight: number
  /** The free-text inset used by the big name and the instructions. */
  textInset: number
}

/**
 * The hero for a card `width` wide. At the design width the figure is
 * about 233 px tall with its head 62 px under the tab row and its feet on
 * the floor at 295. Wider cards and the full tab keep that fixed size
 * (DS-40, DS-121); only a narrow column shrinks it a little.
 */
export function heroMetrics(width: number): HeroMetrics {
  const scale = clamp(width / HERO_DESIGN_WIDTH, 0.82, 1)
  const figureHeight = FIGURE_HEIGHT * scale
  const figureSize = Math.round(figureHeight * FIGURE_MARGIN)
  const headY = Math.round(62 * scale)
  const figureTop = Math.round(headY - (figureSize - figureHeight) / 2)
  const feetY = Math.round(headY + figureHeight)
  const nameY = Math.round(259 * scale)
  // Placed on its own, not from the feet: it has faded out well above the name row.
  const fieldTop = Math.round(40 * scale)
  const fieldHeight = Math.round(nameY - 18 - 40 * scale) - fieldTop
  return {
    scale,
    height: Math.round(305 * scale),
    figureSize,
    figureTop,
    headY,
    feetY,
    nameY,
    fieldTop,
    fieldHeight,
    pillTop: 26,
    pillRight: 34,
    textInset: 40,
  }
}

// ---- the tab row ----

export interface TabRowMetrics {
  /** Space before the first tab's content. */
  start: number
  /** Space between one tab's content and the next. */
  gap: number
  /** The active tab's icon plus its gap to the label. */
  iconBox: number
  /** How far the underline runs past the content on each side. */
  overhang: number
}

/**
 * DS-36: the row is padded 16 px (the first button at x 17 inside the card's
 * hairline), each button is 36 px tall with 12 px side padding, 10 px apart,
 * and the active icon is 16 px plus a 6 px gap. The underline is exactly the
 * active button's width, so it overhangs the content by the button padding.
 */
export const TAB_ROW_PADDING = 16
export const TAB_BUTTON_PADDING = 12
export const TAB_BUTTON_GAP = 10
export const TAB_ROW: TabRowMetrics = {
  start: TAB_ROW_PADDING + TAB_BUTTON_PADDING,
  gap: 2 * TAB_BUTTON_PADDING + TAB_BUTTON_GAP,
  iconBox: 16 + 6,
  overhang: TAB_BUTTON_PADDING,
}

/**
 * The underline under the active tab, in the row's coordinates. Labels keep
 * one width in both weights, and only the active tab carries its icon, so
 * every position follows from the label widths alone: the line lands where
 * the tab will be once its icon has grown in, not where it is mid-animation.
 */
export function underlineFor(labelWidths: readonly number[], active: number, m: TabRowMetrics = TAB_ROW): { left: number; width: number } | null {
  if (active < 0 || active >= labelWidths.length) return null
  let x = m.start
  for (let i = 0; i < active; i++) x += labelWidths[i]! + m.gap
  const content = labelWidths[active]! + m.iconBox
  return { left: x - m.overhang, width: content + 2 * m.overhang }
}

/** "1 skill", "3 skills", or an ellipsis while the count loads. */
export function countLabel(n: number | null, one: string, many: string): string {
  if (n === null) return '…'
  return `${n} ${n === 1 ? one : many}`
}
