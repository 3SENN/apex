/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GuardKind, MainCommand } from '@shared/autofill'
import type { Bounds } from '@shared/ipc'
import type { Size } from './placement'

// Frame offsets for nested and cross-origin frames. A frame can't
// know where it sits in its parent across an origin boundary, so main asks it
// to post a nonce to its parent; the parent's preload finds the <iframe> that
// sent it and reports that element's content box. Main chains these up to the
// top frame. Composition is pure; the linker only does the asking.

/** One frame as main sees it (a WebFrameMain behind an interface, for tests). */
export interface FrameHandle {
  /** WebFrameMain.frameToken: stable for the frame's document. */
  token: string
  origin: string
  url: string
  isMain: boolean
  parent(): FrameHandle | null
  alive(): boolean
  send(command: MainCommand): void
}

/** Where a frame's viewport origin sits in the top viewport, and what of it is visible there (CSS px). */
export interface FrameBox {
  x: number
  y: number
  clip: Bounds
}

export function intersect(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

export function topBox(viewport: Size): FrameBox {
  return { x: 0, y: 0, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } }
}

/** A child frame's box, from its content rect in the parent's viewport. */
export function childBox(parent: FrameBox, childRect: Bounds): FrameBox {
  const x = parent.x + childRect.x
  const y = parent.y + childRect.y
  const clip = intersect(parent.clip, { x, y, width: childRect.width, height: childRect.height }) ?? { x, y, width: 0, height: 0 }
  return { x, y, clip }
}

/** A rect in a frame's viewport, in top-viewport coordinates. Clipped to what is visible, or null when none is. */
export function rectInTop(box: FrameBox, rect: Bounds, clip = true): Bounds | null {
  const moved = { x: rect.x + box.x, y: rect.y + box.y, width: rect.width, height: rect.height }
  return clip ? intersect(moved, box.clip) : moved
}

/** Composes a chain of child rects (outermost first) into the innermost frame's box. */
export function composeChain(viewport: Size, childRects: readonly Bounds[]): FrameBox {
  return childRects.reduce<FrameBox>((box, rect) => childBox(box, rect), topBox(viewport))
}

export function scaleRect(r: Bounds, k: number): Bounds {
  return { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k }
}

export function padRect(r: Bounds, pad: number): Bounds {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 }
}

export interface GuardedReply {
  frame: FrameHandle
  rects: Bounds[]
  focused: GuardKind | null
}

interface LinkerOptions {
  /** The top frame's viewport in CSS px. */
  viewport(): Size
  ids(): string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 400

/** Asks frames for their offsets and guarded rects, and matches the replies. */
export class FrameLinker {
  readonly #opts: LinkerOptions
  readonly #probes = new Map<string, { parentToken: string; resolve(rect: Bounds | null): void; timer: ReturnType<typeof setTimeout> }>()
  readonly #guarded = new Map<string, Array<(reply: { rects: Bounds[]; focused: GuardKind | null } | null) => void>>()

  constructor(opts: LinkerOptions) {
    this.#opts = opts
  }

  get #timeout(): number {
    return this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** The frame's box in the top viewport, or null when a frame on the way up didn't answer. */
  boxOf(frame: FrameHandle, memo = new Map<string, Promise<FrameBox | null>>()): Promise<FrameBox | null> {
    if (frame.isMain) return Promise.resolve(topBox(this.#opts.viewport()))
    const known = memo.get(frame.token)
    if (known) return known
    const result = (async () => {
      const parent = frame.parent()
      if (!parent || !frame.alive()) return null
      const [childRect, parentBox] = await Promise.all([this.#probe(frame, parent), this.boxOf(parent, memo)])
      return childRect && parentBox ? childBox(parentBox, childRect) : null
    })()
    memo.set(frame.token, result)
    return result
  }

  #probe(frame: FrameHandle, parent: FrameHandle): Promise<Bounds | null> {
    const nonce = this.#opts.ids()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#probes.delete(nonce)
        resolve(null)
      }, this.#timeout)
      this.#probes.set(nonce, { parentToken: parent.token, resolve, timer })
      frame.send({ type: 'probe-parent', nonce })
    })
  }

  /** A parent's answer; only the parent of the frame that was asked may give it. */
  onProbe(sender: FrameHandle, nonce: string, childRect: Bounds): void {
    const waiting = this.#probes.get(nonce)
    if (!waiting || waiting.parentToken !== sender.token) return
    clearTimeout(waiting.timer)
    this.#probes.delete(nonce)
    waiting.resolve(childRect)
  }

  /** Every frame's guarded rects (in its own viewport) and focused guard; frames that don't answer are left out. */
  async guarded(frames: readonly FrameHandle[]): Promise<GuardedReply[]> {
    const replies = await Promise.all(
      frames.filter((f) => f.alive()).map(
        (frame) =>
          new Promise<GuardedReply | null>((resolve) => {
            const timer = setTimeout(() => done(null), this.#timeout)
            const done = (reply: { rects: Bounds[]; focused: GuardKind | null } | null): void => {
              clearTimeout(timer)
              const list = this.#guarded.get(frame.token)
              if (list) {
                const i = list.indexOf(done)
                if (i >= 0) list.splice(i, 1)
                if (list.length === 0) this.#guarded.delete(frame.token)
              }
              resolve(reply ? { frame, ...reply } : null)
            }
            const list = this.#guarded.get(frame.token) ?? []
            list.push(done)
            this.#guarded.set(frame.token, list)
            frame.send({ type: 'report-guarded' })
          }),
      ),
    )
    return replies.filter((r): r is GuardedReply => r !== null)
  }

  onGuarded(sender: FrameHandle, rects: Bounds[], focused: GuardKind | null): void {
    for (const done of [...(this.#guarded.get(sender.token) ?? [])]) done({ rects, focused })
  }

  dispose(): void {
    for (const waiting of this.#probes.values()) {
      clearTimeout(waiting.timer)
      waiting.resolve(null)
    }
    this.#probes.clear()
    for (const list of [...this.#guarded.values()]) for (const done of [...list]) done(null)
    this.#guarded.clear()
  }
}
