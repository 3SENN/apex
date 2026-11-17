/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { symlinkSync } from 'node:fs'
import { resolve } from 'node:path'

// Links for the confinement tests. On Windows a symlink needs admin rights or
// Developer Mode: GitHub's runners have them, most desktops don't. A folder
// link then becomes a junction, which needs neither and is how a path really
// escapes a folder there, so the same assertions run against it. A file has
// no such stand-in: `linkFile` says so, and the test skips only the
// assertions about that link.

function refused(err: unknown): boolean {
  return process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM'
}

/** Links `path` to the folder `target`: a symlink, or a junction where Windows refuses one. */
export function linkFolder(target: string, path: string): void {
  try {
    symlinkSync(target, path, 'dir')
  } catch (err) {
    if (!refused(err)) throw err
    symlinkSync(resolve(target), path, 'junction')
  }
}

/** Links `path` to the file `target`; false where Windows won't make the link. */
export function linkFile(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch (err) {
    if (!refused(err)) throw err
    return false
  }
}
