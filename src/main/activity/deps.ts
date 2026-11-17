/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the activity feature needs from the bootstrap that AppContext doesn't
// carry: the memory folders, history (to prune the visits log), the page
// bridge (page text) and the companions. index.ts passes these as
// `memoryDeps` in the app context; without them the services that need them
// answer "Not available yet".
import type { Companion } from '@shared/companion'
import type { HistoryStore } from '../history'
import type { MemoryService } from '../memory'
import type { PageBridge } from '../pageBridge'

export interface MemoryFeatureDeps {
  memory: MemoryService
  history: Pick<HistoryStore, 'on'>
  bridge: Pick<PageBridge, 'request'>
  companions: { list(): Companion[]; activeId(): string; find(id: string): Companion | undefined }
}
