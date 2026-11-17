/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which companions get a live WebGL figure (DS-71). Chromium drops the
// oldest context once a page holds too many, so live views share a capped
// pool; the rest show a breathing still. Pure, so it is unit-tested in node.

/** Live figures only from about this size up; smaller ones are stills. */
export const LIVE_MIN_PX = 96
/** Simultaneous live contexts; the off-screen renderer and the page compositor need some headroom. */
export const LIVE_CAP = 6

export interface LiveRequest {
  id: number
  /** CSS pixels. */
  size: number
  /** On screen (or only just left it). */
  visible: boolean
  /** Higher wins: the companion the page is about outranks decoration. */
  priority: number
  /** Registration order; earlier keeps its slot when everything else is equal. */
  since: number
}

/**
 * Grants up to `cap` live slots among visible requests of at least `minSize`.
 * Views that hold a slot keep it against equal newcomers, so slots do not
 * flap back and forth as views come and go.
 */
export function allocateLive(requests: readonly LiveRequest[], holding: ReadonlySet<number>, cap = LIVE_CAP, minSize = LIVE_MIN_PX): Set<number> {
  const eligible = requests.filter((r) => r.visible && r.size >= minSize)
  eligible.sort((a, b) => b.priority - a.priority || Number(holding.has(b.id)) - Number(holding.has(a.id)) || b.size - a.size || a.since - b.since)
  return new Set(eligible.slice(0, Math.max(0, cap)).map((r) => r.id))
}

/** Keeps the requests and tells each view when its grant changes. */
export class LiveBudget {
  private readonly requests = new Map<number, LiveRequest & { onChange(live: boolean): void }>()
  private granted = new Set<number>()
  private nextId = 1
  private pending = false

  constructor(
    private readonly cap = LIVE_CAP,
    private readonly minSize = LIVE_MIN_PX,
    /** Batches updates; tests pass a synchronous runner. */
    private readonly defer: (run: () => void) => void = (run) => queueMicrotask(run),
  ) {}

  register(init: Omit<LiveRequest, 'id' | 'since'>, onChange: (live: boolean) => void): { id: number; update(patch: Partial<Omit<LiveRequest, 'id' | 'since'>>): void; release(): void } {
    const id = this.nextId++
    this.requests.set(id, { ...init, id, since: id, onChange })
    this.schedule()
    return {
      id,
      update: (patch) => {
        const current = this.requests.get(id)
        if (!current) return
        const next = { ...current, ...patch }
        if (next.size === current.size && next.visible === current.visible && next.priority === current.priority) return
        this.requests.set(id, next)
        this.schedule()
      },
      release: () => {
        if (!this.requests.delete(id)) return
        this.granted.delete(id)
        this.schedule()
      },
    }
  }

  isLive(id: number): boolean {
    return this.granted.has(id)
  }

  private schedule(): void {
    if (this.pending) return
    this.pending = true
    this.defer(() => {
      this.pending = false
      this.apply()
    })
  }

  private apply(): void {
    const next = allocateLive([...this.requests.values()], this.granted, this.cap, this.minSize)
    const before = this.granted
    this.granted = next
    // Revoke first, so a context is freed before another is created.
    for (const id of before) if (!next.has(id)) this.requests.get(id)?.onChange(false)
    for (const id of next) if (!before.has(id)) this.requests.get(id)?.onChange(true)
  }
}

// ---- pats (DS-70) ----

/** A stroke reverses direction after travelling at least this far (CSS px). */
const STROKE_MIN_PX = 10
const STROKE_WINDOW_MS = 1400
/** Reversals for a first pat, and for follow-ups while the companion is still enjoying the last one. */
const FIRST_PAT = 4
const REPEAT_PAT = 2
const REPEAT_WINDOW_MS = 4000

/**
 * Recognises stroking: the pointer moving back and forth over the head.
 * Feed it horizontal positions; it returns true when a pat lands. Repeat
 * pats come more easily for a few seconds after one.
 */
export class PatDetector {
  private anchor: number | null = null
  private direction: -1 | 0 | 1 = 0
  private reversals: number[] = []
  private lastPat = -Infinity

  move(x: number, t: number): boolean {
    if (this.anchor === null) {
      this.anchor = x
      return false
    }
    const travel = x - this.anchor
    const dir = travel > 0 ? 1 : travel < 0 ? -1 : 0
    if (dir === 0) return false
    if (this.direction === 0 || dir === this.direction) {
      // Still going the same way: the turning point moves along.
      if (this.direction === 0 && Math.abs(travel) < STROKE_MIN_PX) return false
      this.direction = dir
      this.anchor = x
      return false
    }
    if (Math.abs(travel) < STROKE_MIN_PX) return false
    this.direction = dir
    this.anchor = x
    this.reversals = [...this.reversals.filter((r) => t - r < STROKE_WINDOW_MS), t]
    const needed = t - this.lastPat < REPEAT_WINDOW_MS ? REPEAT_PAT : FIRST_PAT
    if (this.reversals.length < needed) return false
    this.reversals = []
    this.lastPat = t
    return true
  }

  /** The pointer left the head. */
  reset(): void {
    this.anchor = null
    this.direction = 0
    this.reversals = []
  }
}
