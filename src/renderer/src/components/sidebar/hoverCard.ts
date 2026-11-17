/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Bounds } from '@shared/ipc'
import type { CardSide, GroupHoverCardProps, TabHoverCardContent } from '@shared/overlay/tabs'
import { openTabsSurface, resultValue, type OpenSurface } from '../../overlay/surfaces/tabs/open'

// Row hover cards (SH-28, DS-92): resting on a tab or chat row for about a
// second (450 ms on Routines) shows a card in the overlay, right of the row
// in the sidebar and below the tab in the strip. Once a card shows, moving
// to another row glides it there straight away. Leaving starts its short
// exit (the card stays while it is hovered); a press, a drag or a tab switch
// closes it. One card per window, so this is a module.

export const ROW_DWELL_MS = 1000
export const ROUTINES_DWELL_MS = 450
/** While a card shows, the next row's card follows after only this long. */
const FOLLOW_MS = 60
/** The exit's safety net: a card that hasn't gone a second after leaving is closed. */
const EXIT_SAFETY_MS = 1000
const CARD_WIDTH = 261

export type CardContent = { surface: 'tab-hover-card'; props: TabHoverCardContent } | { surface: 'group-hover-card'; props: Omit<GroupHoverCardProps, 'side' | 'leaving' | 'glideFrom'> }

export interface CardRequest {
  /** Same key, same row: nothing reopens. */
  key: string
  side: CardSide
  dwellMs?: number
  build(): Promise<CardContent | null>
  /** The card resolved (a routine run or a group tab was chosen). */
  onChoose?(value: unknown): void
}

interface Shown {
  key: string
  row: Bounds
  open: OpenSurface | null
  surface: CardContent['surface']
  props: Record<string, unknown>
}

let timer: ReturnType<typeof setTimeout> | null = null
let safety: ReturnType<typeof setTimeout> | null = null
let shown: Shown | null = null
let pendingKey: string | null = null
let generation = 0

function rectOf(el: Element): Bounds {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/** The card's anchor: right of the sidebar's edge + 4, top 12 px above the row; or centred below a strip tab. */
function anchorFor(row: Bounds, side: CardSide, edge: number): Bounds {
  if (side === 'right') return { x: edge + 4, y: row.y - 12, width: CARD_WIDTH, height: 0 }
  return { x: row.x + row.width / 2 - CARD_WIDTH / 2, y: row.y + row.height + 6, width: CARD_WIDTH, height: 0 }
}

function clearTimers(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/** The pointer rests on a row: show (or move) the card after the dwell. */
export function hoverRow(el: Element, request: CardRequest): void {
  if (shown?.key === request.key && !shown.props.leaving) return
  clearTimers()
  pendingKey = request.key
  const wait = shown ? FOLLOW_MS : (request.dwellMs ?? ROW_DWELL_MS)
  timer = setTimeout(() => void show(el, request), wait)
}

/** The pointer left a row: the card starts leaving (it stays while hovered itself). */
export function leaveRow(key: string): void {
  if (pendingKey === key) {
    clearTimers()
    pendingKey = null
  }
  if (!shown || shown.key !== key) return
  shown.props = { ...shown.props, leaving: true }
  shown.open?.update(shown.props)
  if (safety) clearTimeout(safety)
  const leaving = shown
  safety = setTimeout(() => {
    if (shown === leaving && leaving.props.leaving) closeCard()
  }, EXIT_SAFETY_MS)
}

/** A press, a drag, a tab switch or a scroll: the card goes at once. */
export function closeCard(): void {
  clearTimers()
  pendingKey = null
  generation++
  if (safety) clearTimeout(safety)
  safety = null
  const current = shown
  shown = null
  current?.open?.close()
}

async function show(el: Element, request: CardRequest): Promise<void> {
  timer = null
  if (!el.isConnected) return
  const gen = ++generation
  const content = await request.build()
  if (gen !== generation || !content || !el.isConnected) return
  const row = rectOf(el)
  const sidebarEdge = el.closest('.sidebar')?.getBoundingClientRect().right ?? row.x + row.width
  const previous = shown
  const glideFrom = previous && previous.surface === content.surface ? { dx: previous.row.x - row.x, dy: previous.row.y - row.y } : null
  const props = { ...content.props, side: request.side, leaving: false, glideFrom } as Record<string, unknown>
  const anchor = { kind: 'window' as const, rect: anchorFor(row, request.side, sidebarEdge) }
  const next: Shown = { key: request.key, row, open: null, surface: content.surface, props }
  shown = next
  // The new card replaces the old one; it slides in from where that one was.
  previous?.open?.close()
  const open = await openTabsSurface(content.surface, anchor, props as never)
  if (!open) return
  if (shown !== next) {
    open.close()
    return
  }
  next.open = open
  if (next.props.leaving) open.update(next.props)
  void open.result.then((r) => {
    if (shown === next) shown = null
    const value = resultValue(r)
    if (value !== undefined) request.onChoose?.(value)
  })
}

/** Whether a card shows (or is about to) for this key. */
export function cardKey(): string | null {
  return shown?.key ?? pendingKey
}
