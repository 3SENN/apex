/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { OsPlatform } from '@shared/system'

// Starting other programs (engines that run on this computer, local MCP servers,
// native messaging hosts) the same way on every platform. Windows differs in
// four ways Apex handles here: PATH is split on ';' and a bare name needs one
// of PATHEXT's extensions; a .cmd or .bat file (npx, and every CLI npm
// installs) only runs through cmd.exe; there are no process groups, so a tree
// is ended with taskkill; and a console program started from a GUI app opens
// a console window unless it is hidden. The pure parts take the platform, so
// tests cover Windows on any machine.

/** PATHEXT when the environment has none (Windows' own default). */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** The separator between PATH entries. */
export function pathDelimiter(platform: OsPlatform = process.platform): string {
  return platform === 'win32' ? ';' : ':'
}

/**
 * The name PATH has in an environment. Windows' variables ignore case, and
 * a copied environment keeps whatever case the system used ('Path' there).
 */
export function pathKey(env: Readonly<Record<string, string | undefined>>, platform: OsPlatform = process.platform): string {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

/** A copy with PATH set under one key, so Windows never gets a 'Path' and a 'PATH' that disagree. */
export function withPath(env: Readonly<Record<string, string | undefined>>, value: string, platform: OsPlatform = process.platform): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, v] of Object.entries(env)) if (v !== undefined && !(platform === 'win32' && key.toUpperCase() === 'PATH')) out[key] = v
  out[platform === 'win32' ? 'Path' : 'PATH'] = value
  return out
}

/** The extensions Windows runs a bare name with, lower case, in PATHEXT's order. */
export function pathExtensions(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const raw = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] || DEFAULT_PATHEXT
  return raw
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => /^\.[a-z0-9]+$/.test(ext))
}

/** The file names a bare command can be: itself elsewhere; on Windows, itself when it has a runnable extension, then each PATHEXT extension. */
export function commandFileNames(command: string, platform: OsPlatform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  if (platform !== 'win32') return [command]
  const exts = pathExtensions(env)
  const own = win32.extname(command).toLowerCase()
  return [...(own && exts.includes(own) ? [command] : []), ...exts.map((ext) => command + ext)]
}

export interface FindOptions {
  platform?: OsPlatform
  env?: Readonly<Record<string, string | undefined>>
  isExecutable?(path: string): boolean
}

/**
 * Where a command runs from: an absolute path as is when it is runnable, a
 * bare name through PATH (with PATHEXT on Windows), and anything relative
 * (./x, a\x) never. Nothing goes through a shell.
 */
export function findCommand(command: string, PATH: string, o: FindOptions = {}): string | null {
  const platform = o.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const runnable = o.isExecutable ?? ((p: string) => isExecutable(p, platform, o.env))
  if (path.isAbsolute(command)) return commandFileNames(command, platform, o.env).find(runnable) ?? null
  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) return null
  for (const dir of PATH.split(pathDelimiter(platform))) {
    if (!dir.trim()) continue
    for (const name of commandFileNames(command, platform, o.env)) {
      const candidate = path.join(dir.trim(), name)
      if (runnable(candidate)) return candidate
    }
  }
  return null
}

/** A file this platform can run: executable elsewhere; on Windows, a file with a PATHEXT extension (Windows has no execute bit). */
export function isExecutable(path: string, platform: OsPlatform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform === 'win32') return pathExtensions(env).includes(win32.extname(path).toLowerCase())
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A Windows batch file, which only cmd.exe can run. */
export function isBatchFile(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path)
}

/**
 * The script an npm shim (cmd-shim's .cmd, as npm writes for npx, claude and
 * every global CLI) hands to node, relative to the shim's folder; null for
 * any other batch file.
 */
export function npmShimScript(text: string): string | null {
  if (!/node(?:\.exe)?/i.test(text)) return null
  const m = /"%~?dp0%?\\([^"%]+)"\s+%\*/i.exec(text)
  return m?.[1] ?? null
}

/** cmd.exe's meta characters, each escaped with ^ (https://qntm.org/cmd). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Quotes one argument the way Windows programs split their command line: 2n+1 backslashes before a literal quote, 2n before the closing one. */
export function quoteArgument(arg: string): string {
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    out += ch === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${ch}`
    slashes = 0
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

/**
 * One argument on a command line cmd.exe reads. One with nothing cmd.exe or
 * the program would act on goes as it is (as Chrome passes a host its
 * origin); anything else is quoted, then every meta character escaped. A
 * batch file that hands its arguments on (%*) makes cmd.exe read them a
 * second time, so for one they are escaped `twice`; once, a quote inside an
 * argument would let the rest run as a command.
 */
export function cmdArgument(arg: string, twice = true): string {
  if (/^[\w:/.=+@-]+$/.test(arg)) return arg
  const once = quoteArgument(arg).replace(CMD_META, '^$1')
  return twice ? once.replace(CMD_META, '^$1') : once
}

export interface Launch {
  file: string
  args: string[]
  /** Set when `args` is already the exact command line (cmd.exe's). */
  verbatim: boolean
}

export interface LaunchContext {
  platform?: OsPlatform
  env?: Readonly<Record<string, string | undefined>>
  /** A batch file's text, to see through npm's shims; null when it can't be read. */
  readText?(path: string): string | null
  exists?(path: string): boolean
  /**
   * Windows: start any file Windows can open, not only programs, through
   * cmd.exe (a script runs with the program its extension belongs to). This
   * is how Chrome starts native messaging hosts.
   */
  openAny?: boolean
}

/**
 * How to start a program with these arguments. Everything runs directly
 * except a batch file on Windows. An npm shim runs as the node script it
 * wraps, so arguments never pass through cmd.exe (a line break, as in a
 * system prompt, can't). Any other batch file, and with `openAny` any file
 * that isn't a program, runs as `cmd.exe /d /s /c "…"` (no AutoRun, the line
 * taken literally) with its arguments escaped.
 */
export function launchFor(file: string, args: readonly string[], o: LaunchContext = {}): Launch {
  const platform = o.platform ?? process.platform
  const env = o.env ?? process.env
  const direct: Launch = { file, args: [...args], verbatim: false }
  if (platform !== 'win32') return direct
  const exists = o.exists ?? existsSync
  // A file that isn't there is left to spawn, which says so (cmd.exe would only say it isn't a command).
  if (!isBatchFile(file)) return o.openAny && !/\.(exe|com)$/i.test(file) && exists(file) ? throughCmd(file, args, env, false) : direct
  const script = npmShimScript((o.readText ?? readText)(file) ?? '')
  const dir = win32.dirname(file)
  if (script && exists(win32.join(dir, script))) {
    const local = win32.join(dir, 'node.exe')
    const node = exists(local) ? local : findCommand('node', env[pathKey(env, 'win32')] ?? '', { platform, env, isExecutable: (p) => exists(p) && /\.exe$/i.test(p) })
    if (node) return { file: node, args: [win32.join(dir, script), ...args], verbatim: false }
  }
  return throughCmd(file, args, env, true)
}

/** `cmd.exe /d /s /c "<file> <args>"`; `batch` when the file is a batch file that reads its arguments again. */
function throughCmd(file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>, batch: boolean): Launch {
  if (args.some((arg) => /[\r\n]/.test(arg))) throw new Error(`${win32.basename(file)} can’t be given an argument with a line break (Windows starts it through cmd.exe).`)
  const line = [file.replace(CMD_META, '^$1'), ...args.map((arg) => cmdArgument(arg, batch))].join(' ')
  return { file: comspec(env), args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** cmd.exe: ComSpec, else the one in System32 (never a cmd.exe found on PATH). */
export function comspec(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const get = (name: string): string | undefined => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
  const set = get('COMSPEC')
  if (set && win32.isAbsolute(set)) return set
  return win32.join(get('SYSTEMROOT') || 'C:\\Windows', 'System32', 'cmd.exe')
}

/**
 * spawn() for another program: batch files through cmd.exe on Windows, and
 * never a console window there (Apex is a GUI app, so a console program would
 * open one of its own).
 */
export function spawnProgram(file: string, args: readonly string[], options: SpawnOptions = {}, how: Pick<LaunchContext, 'openAny'> = {}): ChildProcess {
  const launch = launchFor(file, args, { env: options.env ?? process.env, ...how })
  return spawn(launch.file, launch.args, { ...options, windowsHide: true, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}) })
}

/**
 * Ends a process and everything it started. A group of its own (detached
 * elsewhere) gets the signal as a group; on Windows, where SIGTERM is already
 * a hard stop, taskkill ends the tree, so cmd.exe's child goes with it.
 */
export function killTree(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals = 'SIGTERM', o: { group?: boolean; platform?: OsPlatform } = {}): void {
  const pid = child.pid
  if (!pid) return
  if ((o.platform ?? process.platform) === 'win32') {
    try {
      const taskkill = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill(signal))
    } catch {
      child.kill(signal)
    }
    return
  }
  try {
    if (o.group) process.kill(-pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

/**
 * The variables Windows itself and most programs need, whatever else a caller
 * trims away: without SystemRoot, Node can't open a socket; without APPDATA
 * and the temp folders, npm and npx can't find their cache.
 */
export const WINDOWS_ESSENTIAL_ENV = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
]

/** The essential Windows variables present in `base`, under their own case. */
export function windowsEssentials(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const wanted = new Set(WINDOWS_ESSENTIAL_ENV.map((name) => name.toUpperCase()))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined && wanted.has(key.toUpperCase())) out[key] = value
  return out
}
