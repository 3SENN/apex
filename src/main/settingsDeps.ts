/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session } from 'electron'
import type { BookmarkStore } from './stores'
import type { ChatStore } from './chats'
import type { CompanionStore } from './companions'
import type { HistoryStore } from './history'
import type { MemoryService } from './memory'

// What the settings feature needs from the bootstrap that AppContext doesn't
// carry (the stores index.ts creates). index.ts hands them over once, in its
// settings region, before the features start; the feature reads them lazily, so its
// services work in tests with a fake app and throw a clear error until set.

export interface SettingsDeps {
  chats: ChatStore
  history: HistoryStore
  memory: MemoryService
  bookmarks: BookmarkStore
  companions: CompanionStore
  /** The default web session (persist:apex-web). */
  webSession: Session
  /** Stops every routine run and the scheduler (reset). */
  stopRoutines(): void
  /** Tells the getting-started plan that bookmarks or history came over. */
  signalImport(): void
}

let deps: SettingsDeps | null = null

export function setSettingsDeps(next: SettingsDeps): void {
  deps = next
}

/** The bootstrap's stores; throws before index.ts has handed them over. */
export function settingsDeps(): SettingsDeps {
  if (!deps) throw new Error('Not available yet')
  return deps
}

export function hasSettingsDeps(): boolean {
  return deps !== null
}
