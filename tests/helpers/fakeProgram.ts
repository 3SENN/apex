/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chmodSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

// A node script installed as a program Atelier can start, the way it would find
// one on this platform. Elsewhere that is a copy with the executable bit,
// whose #! line names node. Windows runs no #! line, so there the script sits
// next to an npm-style .cmd shim, as `npm i -g` installs a CLI (claude.cmd,
// npx.cmd): Atelier then starts it through the same path a real install takes.

/** npm's cmd-shim for a script in the same folder, as it writes C:\Program Files\nodejs\npx.cmd. */
export function npmShim(script: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    '',
  ].join('\r\n')
}

/**
 * A launcher script made runnable: `path` with a #! line elsewhere, path.bat
 * on Windows (as a host written in a scripting language registers itself
 * there). Returns the path to start it by.
 */
export function installLauncher(path: string, body: { sh: string; bat: string }): string {
  if (process.platform === 'win32') {
    writeFileSync(`${path}.bat`, `@${body.bat}\r\n`)
    return `${path}.bat`
  }
  writeFileSync(path, `#!/bin/sh\n${body.sh}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A launcher that runs a node script with whatever arguments it was given. */
export function nodeLauncher(path: string, script: string): string {
  return installLauncher(path, { sh: `exec "${process.execPath}" "${script}" "$@"`, bat: `"${process.execPath}" "${script}" %*` })
}

/**
 * Removes a folder programs ran in. Windows refuses while a process that
 * started there is still on its way out (a host the test just closed), so it
 * tries again for a few seconds.
 */
export async function removeFolder(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 25) throw err
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

/** Where the program `name` in `dir` is started from: <dir>/<name>, or <dir>\<name>.cmd on Windows. */
export function programPath(dir: string, name: string): string {
  return join(dir, process.platform === 'win32' ? `${name}.cmd` : name)
}

/** Installs the script `source` as the program `name` in `dir`, and returns programPath(dir, name). */
export function installScript(source: string, dir: string, name: string): string {
  const program = programPath(dir, name)
  if (process.platform !== 'win32') {
    copyFileSync(source, program)
    chmodSync(program, 0o755)
    return program
  }
  // The script keeps its extension, so node still reads an .mjs as a module.
  const script = `${name}${extname(source) || '.js'}`
  copyFileSync(source, join(dir, script))
  writeFileSync(program, npmShim(script))
  return program
}
