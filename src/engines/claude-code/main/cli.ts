/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { OsPlatform } from '@shared/system'
import { mainT } from '../../../../src/main/i18n/mainT'
import { pathKey, withPath } from '../../../../src/main/system/programs'
import * as shell from '../../../../src/main/system/shell'
import { mergePath, STRIPPED_ENV, type RunOptions, type RunResult, type ShellProbe } from '../../../../src/main/system/shell'
import { compareVersions, type ClaudeAccount, type CliSource } from '../shared/status'

// The person's shell and short commands are src/main/system/shell.ts's; these
// are the same with `claude` filled in, for the engine and its tests.
export { isExecutableFile, loginShell, mergePath, runCommand, shellQuote, SHELL_TIMEOUT_MS, STRIPPED_ENV, type RunOptions, type RunResult, type ShellProbe } from '../../../../src/main/system/shell'

// Finding and talking to the `claude` CLI the way a GUI app must: a Dock
// launch inherits almost no PATH, so Atelier asks a login shell and then checks
// the usual install folders (src/main/system/shell.ts asks the shell).
// Windows has no login shell to ask, but a GUI app there inherits the
// person's whole PATH, so Atelier looks along that instead. Nothing here sends a
// message to a model.

export interface CliLookup {
  path: string
  source: CliSource
  /** What `--version` said, when it answered in time. */
  version?: string | null
}

export interface ResolveInput {
  /** Settings › Model and key path override. */
  override: string | null
  env: NodeJS.ProcessEnv
  /** process.resourcesPath of a packaged app (a bundled CLI lives in claude-code/); null in dev. */
  resourcesPath: string | null
  home: string
  isExecutable(path: string): boolean
  /** Runs `command -v claude` in a login shell; null when that fails. */
  loginShellLookup(): Promise<string | null>
  /** The same in an interactive login shell (`-ilc`), which reads .zshrc and the like; null when that fails. */
  interactiveShellLookup?(): Promise<string | null>
  /** The version a CLI reports (VersionReader.read); without it every version is unknown. */
  readVersion?(path: string): Promise<string | null>
  /** The file a path ends at, so one install found twice is listed once. */
  realPath?(path: string): string
  platform?: OsPlatform
}

export interface Resolution {
  found: CliLookup | null
  /** Every distinct CLI found, in the order Atelier looks, with its version. */
  installs: Array<CliLookup & { version: string | null }>
  overrideInvalid: boolean
}

/** The folder inside Resources that electron-builder copies a vendored CLI into. */
export const BUNDLED_DIR = 'claude-code'

/** The CLI's file name inside a folder: claude, or claude.exe on Windows. */
export function cliFileName(platform: OsPlatform = process.platform): string {
  return platform === 'win32' ? 'claude.exe' : 'claude'
}

/** Install locations a GUI app's PATH leaves out, most common first. */
export function commonPaths(home: string, platform: OsPlatform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA || win32.join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')
    return [
      // The native installer (install.ps1).
      win32.join(home, '.local', 'bin', 'claude.exe'),
      // npm's own global folder, and Node's when npm -g ran as an administrator.
      win32.join(appData, 'npm', 'claude.cmd'),
      win32.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'claude.cmd'),
      win32.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
      win32.join(home, '.bun', 'bin', 'claude.exe'),
    ]
  }
  return [
    posix.join(home, '.local/bin/claude'),
    posix.join(home, '.claude/local/claude'),
    posix.join(home, '.npm-global/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    posix.join(home, '.bun/bin/claude'),
  ]
}

/** Windows' stand-in for the shell probe: `claude` along the PATH Atelier inherited, which is the one a terminal has. */
export function pathProbe(env: Readonly<Record<string, string | undefined>>, platform: OsPlatform = process.platform, isRunnable?: (path: string) => boolean): ShellProbe {
  return shell.pathProbe('claude', env, platform, isRunnable)
}

/**
 * Every CLI Atelier can find, and the one it runs. A valid path override
 * (setting, then ATELIER_CLAUDE_PATH) wins outright. Otherwise the bundled CLI,
 * the login and interactive shells' `claude` and the usual install paths are
 * all asked for their version, and the highest wins; a tie goes to the one
 * found first, and an install whose version can't be read comes last. An
 * override that points at nothing runnable is reported, and the search goes
 * on so chats still work.
 */
export async function resolveCli(input: ResolveInput): Promise<Resolution> {
  const platform = input.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  let overrideInvalid = false
  const candidates: CliLookup[] = []
  const seen = new Set<string>()
  const real = (path: string): string => {
    try {
      return input.realPath ? input.realPath(path) : realpathSync(path)
    } catch {
      return path
    }
  }
  const add = (file: string | null | undefined, source: CliSource): boolean => {
    if (!file || !path.isAbsolute(file) || !input.isExecutable(file)) return false
    // Windows ignores case in paths, so one install can be found under two spellings.
    const key = platform === 'win32' ? real(file).toLowerCase() : real(file)
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push({ path: file, source })
    }
    return true
  }
  let pinned: CliLookup | null = null
  for (const [raw, source] of [[input.override, 'override'], [input.env.ATELIER_CLAUDE_PATH, 'environment']] as Array<[string | null | undefined, CliSource]>) {
    const file = raw?.trim()
    if (!file) continue
    if (add(file, source)) {
      pinned ??= { path: file, source }
      break
    }
    overrideInvalid = true
  }
  if (input.resourcesPath) add(path.join(input.resourcesPath, BUNDLED_DIR, cliFileName(platform)), 'bundled')
  const [login, interactive] = await Promise.all([input.loginShellLookup(), input.interactiveShellLookup?.() ?? Promise.resolve(null)])
  add(parseLookup(login, platform), 'login-shell')
  add(parseLookup(interactive, platform), 'login-shell')
  for (const file of commonPaths(input.home, platform, input.env)) add(file, 'common-path')

  const read = input.readVersion
  const versions = await Promise.all(candidates.map((c) => (read ? read(c.path).catch(() => null) : Promise.resolve(null))))
  const installs = candidates.map((c, i) => ({ ...c, version: versions[i] ?? null }))
  const chosen = pinned ? installs.find((i) => i.path === pinned.path) ?? null : pickHighest(installs)
  return { found: chosen ? { ...chosen } : null, installs, overrideInvalid }
}

/** The highest version; ties go to the earliest; unknown versions lose to any known one. */
export function pickHighest<T extends { version: string | null }>(installs: readonly T[]): T | null {
  let best: T | null = null
  for (const install of installs) {
    if (!best) best = install
    else if (install.version && (!best.version || compareVersions(install.version, best.version) > 0)) best = install
  }
  return best
}

/** `command -v claude` prints a path, or `alias claude=…` when it is an alias. Anything else is ignored. */
export function parseLookup(output: string | null, platform: OsPlatform = process.platform): string | null {
  return shell.parseLookup(output, 'claude', platform)
}

/**
 * The child's environment. Variables that would make the CLI refuse to start
 * (it thinks it is nested in another session), point it at an editor's port,
 * or run Electron as plain Node are removed; its self-updater is off so the
 * version never changes mid-chat. PATH gets the login shell's entries, since
 * an npm-installed CLI needs `node`.
 */
export function childEnv(base: NodeJS.ProcessEnv, loginPath: string | null, home: string, platform: OsPlatform = process.platform): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || STRIPPED_ENV.has(key)) continue
    env[key] = value
  }
  env.DISABLE_AUTOUPDATER = '1'
  return withPath(env, mergePath(loginPath, base[pathKey(base, platform)] ?? null, home, platform), platform)
}

/** '2.1.266 (Claude Code)' → '2.1.266'. */
export function parseVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)?.[1] ?? null
}

export interface AuthReading {
  state: 'ready' | 'signed-out' | 'unknown'
  account: ClaudeAccount | null
  detail: string
}

const SIGNED_OUT = /not logged in|not signed in|not authenticated|please run \/login|run `?claude`? to (?:log|sign) in|invalid api key|oauth token has expired|login required/i

/**
 * Reads `claude auth status --json`. It reports the saved sign-in without
 * contacting a model, so the check costs nothing and sends nothing of yours.
 */
export function parseAuthStatus(result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): AuthReading {
  if (result.timedOut) return { state: 'unknown', account: null, detail: mainT('engines.chat.mainCli.claudeCodeTookToo') }
  const json = parseJsonObject(result.stdout)
  if (json && typeof json.loggedIn === 'boolean') {
    if (!json.loggedIn) return { state: 'signed-out', account: null, detail: mainT('engines.chat.mainCli.claudeCodeIsInstalled') }
    const method = String(json.authMethod ?? '').toLowerCase()
    const provider = String(json.apiProvider ?? 'firstParty')
    const account: ClaudeAccount = provider !== 'firstParty' ? 'other' : method.includes('claude.ai') || method.includes('oauth') ? 'subscription' : method.includes('key') || method.includes('console') ? 'api-key' : 'other'
    return { state: 'ready', account, detail: mainT('engines.chat.mainCli.signedInAndReady') }
  }
  const text = `${result.stdout}\n${result.stderr}`
  if (SIGNED_OUT.test(text)) return { state: 'signed-out', account: null, detail: mainT('engines.chat.mainCli.claudeCodeIsInstalled') }
  if (/unknown command|did you mean|error: unknown/i.test(text)) {
    return { state: 'unknown', account: null, detail: mainT('engines.chat.mainCli.thisVersionOfClaude') }
  }
  return { state: 'unknown', account: null, detail: mainT('engines.chat.mainCli.atelierCouldnTRead') }
}

/** Whether a failure text from the CLI means it isn't signed in. */
export function looksSignedOut(text: string): boolean {
  return SIGNED_OUT.test(text)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** How long a version check may take before the install counts as unknown. */
export const VERSION_TIMEOUT_MS = 2500

/** Resolves with null once `ms` passes without an answer. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

export interface VersionReaderDeps {
  /** Runs `<path> --version`. */
  run(path: string, args: readonly string[], options: RunOptions): Promise<RunResult>
  env(): Promise<Record<string, string>> | Record<string, string>
  /** The file's modification time; null when it can't be read. */
  mtime(path: string): number | null
  cwd?: string
  timeoutMs?: number
}

/**
 * Reads `claude --version` for each install, in parallel and capped at 2.5 s
 * each, and remembers the answer until the file changes (path + mtime), so
 * re-checks and new chats don't run every CLI again.
 */
export class VersionReader {
  readonly #deps: VersionReaderDeps
  readonly #cache = new Map<string, { mtime: number; version: Promise<string | null> }>()

  constructor(deps: VersionReaderDeps) {
    this.#deps = deps
  }

  read(path: string): Promise<string | null> {
    const mtime = this.#deps.mtime(path)
    const cached = this.#cache.get(path)
    if (cached && mtime !== null && cached.mtime === mtime) return cached.version
    const timeoutMs = this.#deps.timeoutMs ?? VERSION_TIMEOUT_MS
    const version = withTimeout(
      Promise.resolve(this.#deps.env()).then((env) => this.#deps.run(path, ['--version'], { env, cwd: this.#deps.cwd, timeoutMs })),
      timeoutMs + 250,
    ).then((result) => (result && result.code === 0 && !result.timedOut ? parseVersion(result.stdout) : null))
    // An unknown answer isn't kept: the next look asks again.
    if (mtime !== null) {
      this.#cache.set(path, { mtime, version })
      void version.then((v) => {
        if (v === null && this.#cache.get(path)?.version === version) this.#cache.delete(path)
      })
    }
    return version
  }

  /** Forgets everything (after Update Claude Code). */
  clear(): void {
    this.#cache.clear()
  }
}

export function fileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

// ---- the person's shell ----

/** The script a shell runs: `command -v claude` and $PATH between marker lines. */
export function probeScript(marker: string): string {
  return shell.probeScript(marker, 'claude')
}

/** Reads a probe's output. Null when the markers aren't all there (the shell never ran the script, or was cut off). */
export function parseProbe(output: string | null, marker: string): ShellProbe | null {
  return shell.parseProbe(output, marker, 'claude')
}

/** One probe of the person's shell for `claude`, login or interactive, with a fresh marker. */
export function probeShell(ask: (script: string, until: (stdout: string) => boolean) => Promise<string | null>, marker?: string): Promise<ShellProbe | null> {
  return shell.probeShell('claude', ask, marker)
}
