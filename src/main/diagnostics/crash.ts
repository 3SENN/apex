/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CrashState } from '@shared/diagnostics'

// Crash bookkeeping: the unclean-exit sentinel and the
// stored crash dumps. Pure Node; early.ts and the service call it with
// Electron's paths. The sentinel (userData/running) is written at start-up
// and removed on a clean quit, so finding it at start means the last run
// ended some other way. It holds the pid, so a second copy of Atelier starting
// beside a running one neither reads it as a crash nor removes it.

export const SENTINEL = 'running'
const DUMP_DEPTH = 3

export interface SentinelRecord {
  pid: number
  /** When that run started (ms since epoch). */
  t: number
}

export interface CrashSession {
  lastExitUnclean: boolean
  /** When the run that ended uncleanly started. */
  at: number | null
  /** This process wrote the sentinel, and removes it on a clean quit. */
  owned: boolean
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readSentinel(dir: string): SentinelRecord | null {
  const path = join(dir, SENTINEL)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SentinelRecord>
    if (typeof raw.pid === 'number' && typeof raw.t === 'number') return { pid: raw.pid, t: raw.t }
  } catch {
    // An unreadable sentinel (an old format, a torn write) still means an unclean exit.
  }
  let t: number | null = null
  try {
    t = statSync(path).mtimeMs
  } catch {
    t = null
  }
  return { pid: -1, t: t ?? 0 }
}

/** Reads the last run's sentinel and writes this run's. */
export function startSession(dir: string, { pid = process.pid, now = Date.now(), alive = isAlive }: { pid?: number; now?: number; alive?: (pid: number) => boolean } = {}): CrashSession {
  const previous = readSentinel(dir)
  if (previous && previous.pid > 0 && previous.pid !== pid && alive(previous.pid)) {
    // Another Atelier is running with this profile: not a crash, and not ours to remove.
    return { lastExitUnclean: false, at: null, owned: false }
  }
  try {
    writeFileSync(join(dir, SENTINEL), JSON.stringify({ pid, t: now } satisfies SentinelRecord))
  } catch {
    return { lastExitUnclean: previous !== null, at: previous?.t ?? null, owned: false }
  }
  return { lastExitUnclean: previous !== null, at: previous ? previous.t || null : null, owned: true }
}

/** On a clean quit: removes the sentinel when this process wrote it. */
export function endSession(dir: string, session: CrashSession | null, pid = process.pid): void {
  if (!session?.owned) return
  const current = readSentinel(dir)
  if (current && current.pid !== pid) return
  rmSync(join(dir, SENTINEL), { force: true })
}

export interface DumpFile {
  path: string
  name: string
  bytes: number
  mtime: number
}

/** Crash dumps (*.dmp) under Crashpad's folders, newest first. */
export function listDumps(dir: string | null): DumpFile[] {
  if (!dir || !existsSync(dir)) return []
  const out: DumpFile[] = []
  const walk = (folder: string, depth: number): void => {
    let names: string[] = []
    try {
      names = readdirSync(folder)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(folder, name)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (depth < DUMP_DEPTH) walk(path, depth + 1)
      } else if (name.toLowerCase().endsWith('.dmp')) {
        out.push({ path, name, bytes: stat.size, mtime: stat.mtimeMs })
      }
    }
  }
  walk(dir, 0)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Deletes every stored dump (turning crash reports off); returns how many went. */
export function deleteDumps(dir: string | null): number {
  let removed = 0
  for (const dump of listDumps(dir)) {
    try {
      rmSync(dump.path, { force: true })
      removed++
    } catch {
      // A dump in use stays; the next change of the setting tries again.
    }
  }
  return removed
}

/** The state the crash notice and report read. A dismissed notice reads as a clean exit. */
export function crashStateOf(session: CrashSession | null, dumps: readonly DumpFile[], dismissed: boolean): CrashState {
  const unclean = Boolean(session?.lastExitUnclean) && !dismissed
  const newest = dumps[0]?.mtime ?? null
  return { lastExitUnclean: unclean, dumps: dumps.length, at: unclean ? (session?.at ?? newest) : newest }
}

/** settings.json's crashReports, read synchronously before app ready; anything unreadable is off. */
export function readCrashReportsSetting(settingsPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as { crashReports?: unknown }
    return raw.crashReports === true
  } catch {
    return false
  }
}
