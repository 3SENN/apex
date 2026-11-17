/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Keep awake (ST-22): while any chat or routine is working and the keepAwake
// setting is on, a 'prevent-app-suspension' power-save blocker stops the Mac
// from sleeping mid-run. The blocker is injected so the rule is unit-tested.

export interface PowerBlocker {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export class KeepAwake {
  readonly #blocker: PowerBlocker
  #id: number | null = null

  constructor(blocker: PowerBlocker) {
    this.#blocker = blocker
  }

  /** Holds the blocker exactly while `enabled` and something is busy. */
  update(enabled: boolean, busy: number): void {
    const want = enabled && busy > 0
    const holding = this.#id !== null && this.#blocker.isStarted(this.#id)
    if (want && !holding) this.#id = this.#blocker.start('prevent-app-suspension')
    else if (!want && this.#id !== null) {
      if (holding) this.#blocker.stop(this.#id)
      this.#id = null
    }
  }

  get holding(): boolean {
    return this.#id !== null && this.#blocker.isStarted(this.#id)
  }

  dispose(): void {
    this.update(false, 0)
  }
}
