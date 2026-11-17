/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_FORMAT_VERSION } from '@shared/migrations'
import { writeAtomic } from '../settings'

// Originals of migrated chats, in chats/.backup/<id>.v<from>.json (SS-09).
// The first migration of a version writes it and later ones never touch it,
// so the backup is always the file exactly as the older Apex left it.

export const BACKUP_DIR = '.backup'

export function backupPath(backupDir: string, id: string, version: number): string {
  return join(backupDir, `${id}.v${version}.json`)
}

/** Writes the original bytes once; returns false when a backup of that version was already there. */
export function writeBackupOnce(backupDir: string, id: string, version: number, original: string): boolean {
  const path = backupPath(backupDir, id, version)
  if (existsSync(path)) return false
  writeAtomic(path, original)
  return true
}

/** The newest backup this build can read (version up to CHAT_FORMAT_VERSION), or null. */
export function findBackup(backupDir: string, id: string): { path: string; version: number } | null {
  let names: string[]
  try {
    names = readdirSync(backupDir)
  } catch {
    return null
  }
  const pattern = new RegExp(`^${id.replace(/[^0-9a-f-]/g, '')}\\.v(\\d+)\\.json$`)
  let best: { path: string; version: number } | null = null
  for (const name of names) {
    const match = pattern.exec(name)
    if (!match) continue
    const version = Number(match[1])
    if (version <= CHAT_FORMAT_VERSION && (!best || version > best.version)) best = { path: join(backupDir, name), version }
  }
  return best
}

/** Keeps the file a restore replaces (damaged, or saved by a newer Apex) beside the backups, so a restore never loses anything. */
export function keepReplaced(backupDir: string, id: string, file: string, now: number): string | null {
  if (!existsSync(file)) return null
  mkdirSync(backupDir, { recursive: true })
  const path = join(backupDir, `${id}.replaced-${now}.json`)
  copyFileSync(file, path)
  return path
}

/** A deleted chat's backups go with it, so nothing of it stays behind. */
export function removeBackups(backupDir: string, id: string): number {
  let names: string[]
  try {
    names = readdirSync(backupDir)
  } catch {
    return 0
  }
  const own = names.filter((name) => name.startsWith(`${id}.`) && /^[0-9a-f-]{36}$/.test(id))
  for (const name of own) rmSync(join(backupDir, name), { force: true })
  return own.length
}
