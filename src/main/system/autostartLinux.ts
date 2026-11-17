/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAUNCH_AT_LOGIN_FLAG } from '@shared/system'

// Linux "Open Atelier when you log in": an XDG autostart entry,
// $XDG_CONFIG_HOME/autostart/atelier.desktop (~/.config by default). An AppImage
// runs from a temporary mount, so Exec points at $APPIMAGE, the file the
// person keeps; a deb install points at its executable.

export const AUTOSTART_FILE = 'atelier.desktop'

export function autostartDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const config = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(home, '.config')
  return join(config, 'autostart')
}

// Characters the Desktop Entry spec reserves inside an Exec argument.
const RESERVED = /[\s"'\\><~|&;$*?#()`]/

/**
 * One Exec argument, quoted per the Desktop Entry spec: reserved characters
 * mean double quotes with ", `, $ and \ escaped; then the string-value rule
 * doubles every backslash, and % becomes %% (field codes).
 */
export function execArg(arg: string): string {
  const quoted = RESERVED.test(arg) || arg === '' ? `"${arg.replace(/["`$\\]/g, '\\$&')}"` : arg
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

export interface AutostartEntry {
  /** The launcher: $APPIMAGE, or the installed executable. */
  launcher: string
  name: string
  comment: string
}

/** The file's content. No Hidden key, so the session starts it; GNOME's own switch says enabled. */
export function autostartContent(entry: AutostartEntry): string {
  const line = (s: string): string => s.replace(/[\r\n]+/g, ' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${line(entry.name)}`,
    `Comment=${line(entry.comment)}`,
    `Exec=${execArg(entry.launcher)} ${LAUNCH_AT_LOGIN_FLAG}`,
    'Icon=atelier',
    'Terminal=false',
    `StartupWMClass=${line(entry.name)}`,
    'X-GNOME-Autostart-enabled=true',
    // Marks the file as Atelier's own, so it is never mistaken for one the person wrote.
    'X-Atelier-Autostart=1',
    '',
  ].join('\n')
}

/** What a file on disk says: started at login, and whether its Exec still points at this launcher. */
export function parseAutostart(text: string, launcher: string): { enabled: boolean; current: boolean } {
  const keys = new Map<string, string>()
  let inEntry = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    const eq = line.indexOf('=')
    if (!inEntry || eq < 1 || line.startsWith('#')) continue
    keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const off = keys.get('Hidden') === 'true' || keys.get('X-GNOME-Autostart-enabled') === 'false'
  return { enabled: keys.has('Exec') && !off, current: keys.get('Exec') === `${execArg(launcher)} ${LAUNCH_AT_LOGIN_FLAG}` }
}

export interface AutostartFs {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, text: string): void
  remove(path: string): void
}

const nodeFs: AutostartFs = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text, { mode: 0o644 })
  },
  remove: (path) => rmSync(path, { force: true }),
}

export class LinuxAutostart {
  readonly path: string
  readonly #entry: AutostartEntry
  readonly #fs: AutostartFs

  constructor(o: { dir: string; entry: AutostartEntry; fs?: AutostartFs }) {
    this.path = join(o.dir, AUTOSTART_FILE)
    this.#entry = o.entry
    this.#fs = o.fs ?? nodeFs
  }

  enabled(): boolean {
    if (!this.#fs.exists(this.path)) return false
    try {
      return parseAutostart(this.#fs.read(this.path), this.#entry.launcher).enabled
    } catch {
      return false
    }
  }

  enable(): void {
    this.#fs.write(this.path, autostartContent(this.#entry))
  }

  disable(): void {
    this.#fs.remove(this.path)
  }

  /** A moved AppImage leaves a stale Exec; an enabled entry is rewritten to the current launcher. */
  refresh(): void {
    if (!this.#fs.exists(this.path)) return
    try {
      const parsed = parseAutostart(this.#fs.read(this.path), this.#entry.launcher)
      if (parsed.enabled && !parsed.current) this.enable()
    } catch {
      // Unreadable: leave the person's file alone.
    }
  }
}
