/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile, execFileSync } from 'node:child_process'
import { LINUX_DESKTOP_ENTRY } from '@shared/system'
import { mainT } from '../i18n/mainT'

// The Linux default browser: xdg-settings, the freedesktop
// tool every desktop honours, names the desktop entry the installer adds. The
// default-browser service calls these on Linux in place of Electron's
// protocol-client calls, which only cover one scheme at a time.

export type Run = (file: string, args: string[]) => Promise<string>
export type RunSync = (file: string, args: string[]) => string

const CHECK_ARGS = ['check', 'default-web-browser', LINUX_DESKTOP_ENTRY]
const SET_ARGS = ['set', 'default-web-browser', LINUX_DESKTOP_ENTRY]

const run: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

// The status call is synchronous; xdg-settings check is a short shell script.
const runSync: RunSync = (file, args) => execFileSync(file, args, { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/** `xdg-settings check` prints yes or no; anything else (no xdg-utils, a refusal) is no. Pure. */
export function checkAnswer(stdout: string): boolean {
  return stdout.trim().toLowerCase() === 'yes'
}

export async function isDefaultBrowserLinux(exec: Run = run): Promise<boolean> {
  try {
    return checkAnswer(await exec('xdg-settings', CHECK_ARGS))
  } catch {
    return false
  }
}

/** The same check, synchronous, for the settings page's status read. */
export function isDefaultBrowserLinuxSync(exec: RunSync = runSync): boolean {
  try {
    return checkAnswer(exec('xdg-settings', CHECK_ARGS))
  } catch {
    return false
  }
}

/** Sets Apex as the default, then checks; throws a readable message when the desktop refuses. */
export async function makeDefaultBrowserLinux(exec: Run = run): Promise<boolean> {
  try {
    await exec('xdg-settings', SET_ARGS)
  } catch {
    throw new Error(mainT('system.defaultBrowser.linuxRefused'))
  }
  return isDefaultBrowserLinux(exec)
}
