/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { mainT } from '../i18n/mainT'

// Path confinement for the viewer: every file it opens must sit inside
// one of Atelier's own folders, checked on the real path so a symlink inside a
// folder can't point the viewer at a file outside it.

export class PathRefused extends Error {
  constructor(message = mainT('files.error.refused')) {
    super(message)
    this.name = 'PathRefused'
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Maps a '/'-separated relative path to a file under root. Rejects '..',
 * absolute paths and NUL, then checks the real path of the nearest existing
 * ancestor (the file itself when it exists) against the real root, so a
 * symlinked file or folder that leaves root is refused.
 */
export function confine(root: string, relative: string): string {
  if (!relative || relative.includes('\0')) throw new PathRefused(mainT('files.error.invalidPath'))
  const parts = relative.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..') || parts.length === 0) throw new PathRefused(mainT('files.error.invalidPath'))
  const base = resolve(root)
  const target = resolve(base, ...parts)
  if (!inside(target, base) || target === base) throw new PathRefused()
  confineReal(base, target)
  return target
}

/** Checks an absolute path (already under root by its text) against root's real path, symlinks included. */
export function confineReal(root: string, target: string): void {
  if (!existsSync(root)) return
  let existing = target
  while (!existsSync(existing) && existing !== root && dirname(existing) !== existing) existing = dirname(existing)
  const real = realpathSync(existing)
  const realRoot = realpathSync(root)
  if (!inside(real, realRoot)) throw new PathRefused()
}

/** Whether an absolute path is (really) one of the granted paths. */
export function isGranted(granted: ReadonlySet<string>, path: string): string | null {
  if (!isAbsolute(path) || path.includes('\0')) return null
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    // A granted file that was moved or deleted: still the same grant, so the viewer can say it's missing.
    return granted.has(resolve(path)) ? resolve(path) : null
  }
  return granted.has(real) || granted.has(resolve(path)) ? real : null
}
