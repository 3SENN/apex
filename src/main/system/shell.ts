/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { isAbsolute, posix, win32 } from 'node:path'
import type { OsPlatform } from '@shared/system'
import { findCommand, isExecutable, killTree, pathDelimiter, pathKey, spawnProgram } from './programs'

// The person's shell, the way a GUI app must ask it: a Dock launch inherits
// almost no PATH, so Apex asks a login shell (and an interactive one, which
// reads .zshrc) where a command-line program is and what PATH a terminal
// has. Windows has no login shell to ask, but a GUI app there inherits the
// person's whole PATH, so Apex looks along that instead. Used by local MCP
// servers (connectors), the external MCP server's "Add for me" and engines
// that run a program on this computer.

/** A file this platform can run (on Windows, one with a PATHEXT extension: npm's extensionless sh shim isn't). */
export function isExecutableFile(path: string): boolean {
  return isExecutable(path)
}

/**
 * Variables a child program must not inherit: ones an agent session in a
 * terminal sets (a program started from Apex would think it is nested in
 * that session, or reach for an editor's port), and ones that would run
 * Electron as plain Node.
 */
export const STRIPPED_ENV = new Set(['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'])

/** The login shell's PATH, then the inherited one, then the usual folders, each entry once (Windows ignores case). */
export function mergePath(loginPath: string | null, inherited: string | null, home: string, platform: OsPlatform = process.platform): string {
  const delimiter = pathDelimiter(platform)
  const parts: string[] = []
  const seen = new Set<string>()
  const add = (entry: string): void => {
    const key = platform === 'win32' ? entry.toLowerCase() : entry
    if (!entry || seen.has(key)) return
    seen.add(key)
    parts.push(entry)
  }
  for (const source of [loginPath, inherited]) for (const entry of source?.split(delimiter) ?? []) add(entry.trim())
  const usual = platform === 'win32' ? [win32.join(home, '.local', 'bin')] : ['/opt/homebrew/bin', '/usr/local/bin', posix.join(home, '.local/bin'), posix.join(home, '.npm-global/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  for (const entry of usual) add(entry)
  return parts.join(delimiter)
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunOptions {
  env: Record<string, string>
  cwd?: string
  timeoutMs: number
  /** Each piece of stdout and stderr as it arrives (a long command's progress). */
  onOutput?(text: string): void
  /** Ends the run as soon as stdout says enough (the shell probe's end marker). */
  until?(stdout: string): boolean
  /** Runs in a process group of its own, killed when the run ends, so helpers a shell starts never keep it open. */
  group?: boolean
}

/** How long a finished process may take to close its pipes before Apex stops waiting. */
const CLOSE_GRACE_MS = 300

/**
 * Runs a short command with no stdin (/dev/null) and a hard timeout.
 * Output is capped. It never hangs: the timeout, the `until` test or the
 * process's exit ends it, even when something it started holds its pipes.
 */
export function runCommand(path: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let exitCode: number | null = null
    let done = false
    let child: ReturnType<typeof spawnProgram>
    try {
      // A group of its own is a POSIX idea; on Windows killTree ends the tree instead.
      child = spawnProgram(path, [...args], { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: options.group === true && process.platform !== 'win32' })
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false })
      return
    }
    let grace: NodeJS.Timeout | null = null
    const kill = (): void => killTree(child, 'SIGKILL', { group: options.group })
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      if (options.group || timedOut || code === null) kill()
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
      resolve({ code, stdout, stderr, timedOut })
    }
    const cap = (current: string, chunk: Buffer): string => (current.length > 64_000 ? current : current + chunk.toString('utf8'))
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk)
      options.onOutput?.(chunk.toString('utf8'))
      if (options.until?.(stdout)) finish(0)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk)
      options.onOutput?.(chunk.toString('utf8'))
    })
    const timer = setTimeout(() => {
      timedOut = true
      finish(null)
    }, options.timeoutMs)
    child.on('error', (err) => {
      stderr = stderr || err.message
      finish(null)
    })
    child.on('exit', (code) => {
      exitCode = code
      grace ??= setTimeout(() => finish(exitCode), CLOSE_GRACE_MS)
    })
    child.on('close', (code) => finish(code ?? exitCode))
  })
}

/** What one shell said: where a command is (as `command -v` put it) and its PATH. */
export interface ShellProbe {
  lookup: string | null
  path: string | null
}

/** `command -v <command>` prints a path, or `alias <command>=…` when it is an alias. Anything else is ignored. */
export function parseLookup(output: string | null, command: string, platform: OsPlatform = process.platform): string | null {
  const line = output?.trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
  if (!line) return null
  const alias = line.startsWith(`alias ${command}=`) ? /^alias [^=]+=['"]?([^'"]+)['"]?$/.exec(line) : null
  const path = (alias?.[1] ?? line).trim()
  return (platform === 'win32' ? win32 : posix).isAbsolute(path) ? path : null
}

/** Windows' stand-in for the shell probe: `command` along the PATH Apex inherited, which is the one a terminal has. */
export function pathProbe(command: string, env: Readonly<Record<string, string | undefined>>, platform: OsPlatform = process.platform, isRunnable?: (path: string) => boolean): ShellProbe {
  const PATH = env[pathKey(env, platform)] ?? ''
  return { lookup: findCommand(command, PATH, { platform, env, ...(isRunnable ? { isExecutable: isRunnable } : {}) }), path: PATH || null }
}

/**
 * The script a shell runs: `command -v <command>` and $PATH between marker
 * lines, so a prompt, a motd or a plugin's output around them is ignored.
 */
export function probeScript(marker: string, command: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) throw new Error(`Not a command name: ${command}`)
  return [
    `printf '\\n%s\\n' '${marker}:begin'`,
    `command -v ${command}`,
    `printf '\\n%s\\n' '${marker}:path'`,
    'printf \'%s\' "$PATH"',
    `printf '\\n%s\\n' '${marker}:end'`,
  ].join('; ')
}

/** Reads a probe's output. Null when the markers aren't all there (the shell never ran the script, or was cut off). */
export function parseProbe(output: string | null, marker: string, command: string): ShellProbe | null {
  if (!output) return null
  const lines = output.split(/\r?\n/)
  const begin = lines.lastIndexOf(`${marker}:begin`)
  const middle = lines.indexOf(`${marker}:path`, begin + 1)
  const end = lines.indexOf(`${marker}:end`, middle + 1)
  if (begin < 0 || middle < 0 || end < 0) return null
  const path = lines.slice(middle + 1, end).join('').trim()
  return { lookup: parseLookup(lines.slice(begin + 1, middle).join('\n'), command), path: path || null }
}

/** How long a shell may take to set itself up and answer. */
export const SHELL_TIMEOUT_MS = 4000

/**
 * Runs a script in the person's shell: a login shell (`-lc`), or an
 * interactive login shell (`-ilc`) that also reads .zshrc and the like.
 * stdin is /dev/null and the shell gets its own process group, so a shell
 * that waits for input or leaves helpers running never holds Apex up; the
 * run ends at `until` (the end marker), its exit or 4 s.
 */
export async function loginShell(shell: string | undefined, script: string, options: { interactive?: boolean; timeoutMs?: number; until?(stdout: string): boolean; run?: typeof runCommand } = {}): Promise<string | null> {
  // Windows has no login shell; Apex already has the PATH a terminal there would.
  if (process.platform === 'win32' && !options.run) return null
  const program = shell && isAbsolute(shell) ? shell : '/bin/zsh'
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !STRIPPED_ENV.has(e[0])))
  const run = options.run ?? runCommand
  const result = await run(program, [options.interactive ? '-ilc' : '-lc', script], { env, timeoutMs: options.timeoutMs ?? SHELL_TIMEOUT_MS, group: true, ...(options.until ? { until: options.until } : {}) })
  // An interactive shell may exit non-zero after the script ran (a plugin failing on the way out): the markers decide.
  if (options.until) return result.stdout || null
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

/** One probe of the person's shell for `command`, login or interactive, with a fresh marker. */
export async function probeShell(command: string, ask: (script: string, until: (stdout: string) => boolean) => Promise<string | null>, marker = `APEX_${randomUUID().replace(/-/g, '')}`): Promise<ShellProbe | null> {
  const output = await ask(probeScript(marker, command), (stdout) => stdout.split(/\r?\n/).includes(`${marker}:end`))
  return parseProbe(output, marker, command)
}

/** Quotes a string for the terminal: single quotes for a POSIX shell, double quotes for Windows' Command Prompt. */
export function shellQuote(text: string, platform: OsPlatform = process.platform): string {
  if (platform === 'win32') return /^[\w@+=:,./\\-]+$/.test(text) ? text : `"${text.replace(/"/g, '""')}"`
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}
