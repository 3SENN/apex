/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { copyFileSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MigrationOutcome } from '@shared/migrations'
import { log } from '../log'

// The guard for versioned JSON files. Settings and
// companions read through it, so going back to an older Apex never silently
// loses what a newer one saved: a file newer than this build understands is
// copied to <name>.newer-v<N>.json before the store falls back to what it
// can read, the log says so, and the migration report lists it.
//
// Kept free of settings.ts and the chat store, which import it.

/** The format each guarded file is written in. A newer Apex raises these. */
export const VERSIONED_FILES = {
  /** settings.json: `formatVersion` (absent before read as 1). */
  settings: 1,
  /** companions.json: `version`. */
  companions: 1,
} as const

// Newer files seen since start-up; the migrations service merges them into its report.
const newerFiles = new Map<string, MigrationOutcome>()

/** The version a file declares: `formatVersion`, else `version`; null when it declares none. */
export function declaredVersion(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  for (const key of ['formatVersion', 'version']) {
    const v = record[key]
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  }
  return null
}

/** Where a newer file's copy goes: settings.json → settings.newer-v2.json, beside it. */
export function newerCopyPath(path: string, version: number): string {
  return join(dirname(path), `${basename(path).replace(/\.json$/i, '')}.newer-v${version}.json`)
}

/**
 * Reads a JSON file and parses it with `parse`. A missing or unreadable
 * file gives `{ value: null }`. A file newer than `current` is copied first,
 * then still parsed (stores fall back field by field), with `newer: true`.
 */
export function readVersioned<T>(path: string, current: number, parse: (raw: unknown) => T): { value: T | null; newer: boolean } {
  let text: string
  let raw: unknown
  try {
    text = readFileSync(path, 'utf8')
    raw = JSON.parse(text)
  } catch {
    return { value: null, newer: false }
  }
  const version = declaredVersion(raw)
  const newer = version !== null && version > current
  if (newer) {
    const copy = newerCopyPath(path, version)
    try {
      copyFileSync(path, copy)
      log.warn('migrations', `${basename(path)} was saved by a newer ${BRAND_NAME} (format ${version}); kept a copy before reading it.`, { file: basename(path), copy: basename(copy) })
    } catch (err) {
      log.error('migrations', `Couldn't keep a copy of ${basename(path)} from a newer ${BRAND_NAME}.`, { file: basename(path), code: (err as NodeJS.ErrnoException).code ?? null })
    }
    newerFiles.set(path, { id: basename(path), title: basename(path), from: version, to: current, ok: false, error: `kept a copy as ${basename(copy)}`, at: Date.now() })
  }
  try {
    return { value: parse(raw), newer }
  } catch {
    return { value: null, newer }
  }
}

/** Files read through readVersioned that a newer Apex saved, for the report. */
export function newerFileOutcomes(): MigrationOutcome[] {
  return [...newerFiles.values()]
}

/** Tests only. */
export function resetNewerFiles(): void {
  newerFiles.clear()
}
