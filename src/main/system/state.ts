/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The system feature's own small file (userData/system.json): things that happen once, like
// the "Apex is still running" notice. Not a setting: nothing to change.

interface SystemFile {
  backgroundNoticeShown: boolean
}

export class SystemState {
  readonly #path: string
  #data: SystemFile

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'system.json')
    this.#data = { backgroundNoticeShown: false }
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<SystemFile>
      this.#data = { backgroundNoticeShown: raw.backgroundNoticeShown === true }
    } catch {
      // Missing or unreadable: start fresh.
    }
  }

  get backgroundNoticeShown(): boolean {
    return this.#data.backgroundNoticeShown
  }

  markBackgroundNoticeShown(): void {
    this.#data = { ...this.#data, backgroundNoticeShown: true }
    try {
      writeFileSync(this.#path, JSON.stringify(this.#data), { mode: 0o600 })
    } catch {
      // Worst case the notice shows once more.
    }
  }
}
