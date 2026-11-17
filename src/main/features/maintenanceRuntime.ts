/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AttentionState } from '@shared/notifications'
import type { MigrationsServices } from '@shared/migrations'
import type { UpdatesServices } from '@shared/updates'
import type { ChatStore } from '../chats'
import { notAvailableYet } from './personalRuntime'

// The app-maintenance part of the app context: what the diagnostics,
// migrations, updates, system, native and i18n feature modules need that
// AppContext doesn't carry, plus slots they fill in FEATURES order so one
// feature can read another's service. An unfilled slot throws "Not available yet".

/** What these features need from routines: the restart card's running count and the tray's next run. */
export interface RoutineRunInfo {
  runningCount(): number
  nextRunAt(): number | null
}

/** The attention feed, for the tray and taskbar. */
export interface AttentionFeed {
  onChange(fn: (s: AttentionState) => void): () => void
}

export interface MaintenanceRuntime {
  /** The chat store: the diagnostics report's chat.md, the migrations and their background pass. */
  chats: ChatStore
  routines: RoutineRunInfo
  attention: AttentionFeed
  /** Filled by the migrations feature; the diagnostics report.json reads its report(). */
  migrations: MigrationsServices['migrations']
  /** Filled by the updates feature; the tray reads its status(). */
  updates: UpdatesServices['updates']
}

/** index.ts passes what the bootstrap already has; the features fill the rest. */
export function createMaintenanceRuntime(deps: { chats: ChatStore; routines?: RoutineRunInfo; attention?: AttentionFeed }): MaintenanceRuntime {
  return {
    chats: deps.chats,
    routines: deps.routines ?? notAvailableYet<RoutineRunInfo>('routines'),
    attention: deps.attention ?? notAvailableYet<AttentionFeed>('attention'),
    migrations: notAvailableYet<MigrationsServices['migrations']>('migrations'),
    updates: notAvailableYet<UpdatesServices['updates']>('updates'),
  }
}
