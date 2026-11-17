/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// The free-space rule before a download (UP-01): the updater's cache volume
// needs at least 2.5 times the update, and never less than the update plus
// 500 MB, so unpacking and the install itself have room.

export const DISK_MARGIN_BYTES = 500 * 1024 * 1024

export function requiredFreeBytes(updateBytes: number): number {
  const size = Math.max(0, updateBytes)
  return Math.max(Math.ceil(size * 2.5), size + DISK_MARGIN_BYTES)
}

/** Whether `free` bytes are enough; an unknown free size never blocks the download. */
export function hasRoom(free: number | null, updateBytes: number): boolean {
  return free === null || free >= requiredFreeBytes(updateBytes)
}

/** How much more space the download needs, for the error message. */
export function shortfall(free: number, updateBytes: number): number {
  return Math.max(0, requiredFreeBytes(updateBytes) - free)
}

/** Free bytes on the volume holding `dir` (or its nearest existing parent); null when it can't tell. */
export async function freeBytes(dir: string): Promise<number | null> {
  let path = dir
  for (let i = 0; i < 32; i++) {
    try {
      const s = await statfs(path)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      const parent = dirname(path)
      if (parent === path) return null
      path = parent
    }
  }
  return null
}

/** Where electron-updater keeps its download cache on each platform (its volume is what counts). */
export function updaterCacheDir(env: { platform: NodeJS.Platform; home: string; localAppData?: string; xdgCache?: string }): string {
  if (env.platform === 'win32') return env.localAppData ?? join(env.home, 'AppData', 'Local')
  if (env.platform === 'darwin') return join(env.home, 'Library', 'Caches')
  return env.xdgCache ?? join(env.home, '.cache')
}
