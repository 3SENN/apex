/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Small file helpers the workspace stores share: atomic writes, moves that
// work across volumes, and sizes of files or folders.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, data)
  renameSync(temp, path)
}

/** Moves a file or folder; across volumes it copies, then removes the source. */
export function movePath(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    rmSync(from, { recursive: true, force: true })
  }
}

/** Bytes in a file, or in every file under a folder (symlinks count as themselves). */
export function pathSize(path: string): number {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const name of readdirSync(path)) total += pathSize(join(path, name))
  return total
}

/** `path`, or "name 2.ext", "name 3.ext"… beside it when something is already there. */
export function freePath(path: string): string {
  if (!existsSync(path)) return path
  const dir = dirname(path)
  const base = path.slice(dir.length + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = join(dir, `${stem} ${n}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
}

/** True when the first bytes look binary (a NUL byte), the same test git uses. */
export function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0)
}
