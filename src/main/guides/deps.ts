/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the guides feature needs that AppContext doesn't carry (the
// `firstRunDeps` slot, filled in index.ts). Without it the
// preset extras stay stubbed and the rest falls back to the active
// companion the host picks.
import type { Companion, CompanionPreset } from '@shared/companion'

export interface FirstRunDeps {
  companions: {
    find(id: string): Companion | undefined
    update(id: string, patch: unknown): Companion
    activeId(): string
  }
  presets(): readonly CompanionPreset[]
  /** The raw presets.json (main/companion.ts's presetsPath()), for the preset extras the base parser drops. */
  presetsRaw?(): unknown
  /** The memory build over imported chats: `memory.startJob('build', owner, { chatIds })`. */
  startMemoryBuild?(companionId: string, chatIds: string[]): void
  /** Connector directory ids (the connectors DIRECTORY), to keep a guide's suggestions real. */
  directoryIds?(): readonly string[]
  /** ON-18: the directory itself, for matching the apps you named. */
  directory?(): readonly { id: string; name: string; site: string; category: string }[]
  /** ON-18: writes a shared memory note (your profile's About me note). */
  writeMemory?(path: string, text: string): void
}
