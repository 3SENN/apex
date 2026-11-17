/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { posix, win32 } from 'node:path'
import { COMPANION_FILE_EXTENSION } from '@shared/companion'
import { LAUNCH_AT_LOGIN_FLAG, type OsPlatform } from '@shared/system'
import { isPackArchiveName } from '@shared/packs'

// Windows and Linux hand links and files to Apex by
// starting it again; the single-instance lock turns that into
// 'second-instance' with the new process's argv. parseLaunchArgs is pure:
// http(s) and file URLs, web files to open as tabs, .apexcompanion files for
// the import review. Flags and anything else are ignored.

export interface LaunchTargets {
  urls: string[]
  companionFiles: string[]
  /** The launch came from the login item (a second one is ignored). */
  background: boolean
}

/** Files Apex opens as a tab, matching the file associations it registers. */
const WEB_FILE = /\.(html?|xhtml|shtml|svg|webp|pdf)$/i
/** More than this is not a person opening links. */
export const MAX_LAUNCH_TARGETS = 20

function unquote(arg: string): string {
  const s = arg.trim()
  return s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) ? s.slice(1, -1) : s
}

function webUrl(arg: string): string | null {
  try {
    const url = new URL(arg)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:' ? url.href : null
  } catch {
    return null
  }
}

/** A file URL for a path on the given platform (the host's pathToFileURL only knows its own). */
export function fileUrl(path: string, platform: OsPlatform): string {
  const enc = (segment: string): string => encodeURIComponent(segment).replace(/%3A/gi, ':')
  if (platform === 'win32') {
    const p = path.replace(/\\/g, '/')
    // \\server\share\file → file://server/share/file
    if (p.startsWith('//')) {
      const [host = '', ...rest] = p.slice(2).split('/')
      return `file://${host}/${rest.map(enc).join('/')}`
    }
    return `file:///${p.split('/').map(enc).join('/')}`
  }
  return `file://${path.split('/').map(enc).join('/')}`
}

export function parseLaunchArgs(
  argv: readonly string[],
  o: { cwd: string; platform: OsPlatform; isFile?(path: string): boolean },
): LaunchTargets {
  const path = o.platform === 'win32' ? win32 : posix
  const out: LaunchTargets = { urls: [], companionFiles: [], background: false }
  // argv[0] is the executable; a dev run's app folder is a directory and falls through.
  for (const raw of argv.slice(1)) {
    const arg = unquote(raw)
    if (!arg) continue
    if (arg === LAUNCH_AT_LOGIN_FLAG) {
      out.background = true
      continue
    }
    // Switches (Chromium's, the person's, '--') never open anything.
    if (arg.startsWith('-')) continue
    if (out.urls.length + out.companionFiles.length >= MAX_LAUNCH_TARGETS) break
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      const url = webUrl(arg)
      if (url) out.urls.push(url)
      continue
    }
    const full = path.resolve(o.cwd, arg)
    if (o.isFile && !o.isFile(full)) continue
    // Packs (docs/packs.md) travel with the companion files: index.ts's open-file handler routes each by its extension.
    if (full.toLowerCase().endsWith(`.${COMPANION_FILE_EXTENSION}`) || isPackArchiveName(full)) out.companionFiles.push(full)
    else if (WEB_FILE.test(full)) out.urls.push(fileUrl(full, o.platform))
  }
  return out
}

/** The window outside links open in: the front one unless it is private or a chat window, else the first normal one. Pure. */
export function linkWindow<W extends { kind: string }>(focused: W | null, all: readonly W[]): W | null {
  if (focused?.kind === 'normal') return focused
  return all.find((w) => w.kind === 'normal') ?? null
}

/**
 * Windows and Linux hand a cold start its links and files on the command
 * line (macOS sends open-url and open-file instead). They go through the same
 * events, which start-up queues until the first window is ready. Pure.
 */
export function firstLaunchEvents(targets: LaunchTargets): Array<{ event: 'open-url' | 'open-file'; value: string }> {
  return [...targets.urls.map((value) => ({ event: 'open-url' as const, value })), ...targets.companionFiles.map((value) => ({ event: 'open-file' as const, value }))]
}
