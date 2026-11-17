/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { STILLNESS_MS } from '@shared/autofill'
import type { Bounds } from '@shared/ipc'
import { sameRect } from './placement'

/**
 * The stillness rule (OV-25), enforced in main: a pick counts only after the
 * popup has been visible and still for STILLNESS_MS. A page can't move a
 * popup under the pointer and have the click land, because every move,
 * resize or re-show starts the wait again.
 */
export class StillnessGate {
  readonly #minMs: number
  #rect: Bounds | null = null
  #since: number | null = null

  constructor(minMs = STILLNESS_MS) {
    this.#minMs = minMs
  }

  /** The surface reports where it is drawn; a new rect restarts the wait. */
  shown(rect: Bounds, now: number): void {
    if (this.#since !== null && sameRect(rect, this.#rect)) return
    this.#rect = rect
    this.#since = now
  }

  /** The anchor moved (field, frame or tab): restart, if it is showing. */
  moved(now: number): void {
    if (this.#since !== null) this.#since = now
  }

  hidden(): void {
    this.#rect = null
    this.#since = null
  }

  ready(now: number): boolean {
    return this.#since !== null && now - this.#since >= this.#minMs
  }
}
