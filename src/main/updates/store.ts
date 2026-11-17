/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { EMPTY_UPDATES_FILE, type UpdatesFile } from '@shared/updates'
import { log } from '../log'
import { writeAtomic } from '../settings'

// userData/updates.json: the pending install, what's new bookkeeping, the
// unsupported-version snooze and the last check time. It is app-wide (never
// per profile). A missing or damaged file reads as empty, field by field.

const version = z.string().min(1).max(64)
const time = z.number().finite().nonnegative()

const FIELDS = {
  pending: z.object({ version, startedAt: time, attempts: z.number().int().min(0).max(1000) }).nullable(),
  lastSeenVersion: version.nullable(),
  whatsNewShownFor: version.nullable(),
  unsupportedSnoozeUntil: time.nullable(),
  lastCheckAt: time.nullable(),
} satisfies { [K in keyof UpdatesFile]: z.ZodType<UpdatesFile[K]> }

/** Reads each field on its own, so one bad value never loses the rest. */
export function normalizeUpdatesFile(raw: unknown): UpdatesFile {
  const out: UpdatesFile = { ...EMPTY_UPDATES_FILE }
  if (!raw || typeof raw !== 'object') return out
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(FIELDS) as (keyof UpdatesFile)[]) {
    const parsed = FIELDS[key].safeParse(record[key])
    if (parsed.success) (out as unknown as Record<string, unknown>)[key] = parsed.data
  }
  return out
}

export class UpdatesStore {
  readonly path: string
  #file: UpdatesFile

  constructor(dataDir: string) {
    this.path = join(dataDir, 'updates.json')
    this.#file = this.#read()
  }

  get(): UpdatesFile {
    return { ...this.#file }
  }

  update(patch: Partial<UpdatesFile>): UpdatesFile {
    this.#file = normalizeUpdatesFile({ ...this.#file, ...patch })
    try {
      writeAtomic(this.path, JSON.stringify(this.#file, null, 2))
    } catch (err) {
      log.warn('updates', "Couldn't save updates.json", { error: err instanceof Error ? err.message : String(err) })
    }
    return this.get()
  }

  /** Reads the file again (smoke: a snooze survives a reload). */
  reload(): UpdatesFile {
    this.#file = this.#read()
    return this.get()
  }

  #read(): UpdatesFile {
    try {
      return normalizeUpdatesFile(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      return { ...EMPTY_UPDATES_FILE }
    }
  }
}
