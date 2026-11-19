/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { EngineSummary } from '@shared/engine'
import type { EngineSettings, ExtraEnginesDeps } from '../../../../src/main/engines/extras'
import { writeAtomic } from '../../../../src/main/settings'
import { claudeCodeReady, compareVersions, IDLE_UPDATE, type ClaudeCodeStatus, type CliUpdateResult, type CliUpdateStatus, type RateLimitNote } from '../shared/status'
import { ClaudeCodeBackend, type ClaudeCodeDeps } from './claudeCode'
import { childEnv, fileMtime, isExecutableFile, loginShell, parseAuthStatus, pathProbe, probeShell, resolveCli, runCommand, shellQuote, VersionReader, type CliLookup, type Resolution, type RunOptions, type RunResult, type ShellProbe } from './cli'
import { pathDelimiter } from '../../../../src/main/system/programs'
import { manualCommand, updateStep, type UpdateEvent } from './cliUpdate'
import { mainT } from '../../../../src/main/i18n/mainT'

// The Claude subscription engine in one place (ST-58, ST-59): where Claude Code is
// and whether it is signed in, Update Claude Code, and the backend its chats
// run on. Its chats reach Atelier's tools on the app's local MCP server
// (src/main/engines/service.ts hands out each chat's endpoint).
//
// Bring your own Claude: the Claude subscription engine only ever runs on the
// person's own Claude account (their subscription sign-in, or an API key
// they gave Claude Code). Atelier never holds, proxies or meters that access,
// and sends nothing anywhere but to the local CLI.

/** Every build offers the engine; a test or a smoke run may build one without it. */
export const CLAUDE_CODE_ENGINE_BUILT = true

const PROBE_TIMEOUT_MS = 10_000
/** How long `claude update` may take before Atelier gives up on it and opens Terminal. */
export const UPDATE_TIMEOUT_MS = 180_000

/** Each model's minimum Claude Code version, learned from its last version error. */
const MinimumsSchema = z.record(z.string().max(200), z.object({ version: z.string().regex(/^\d+\.\d+\.\d+[\w.+-]*$/).max(64), at: z.number() }))
type Minimums = z.infer<typeof MinimumsSchema>

export interface ClaudeCodeEngineDeps extends Pick<ExtraEnginesDeps, 'dataDir' | 'home' | 'env' | 'platform' | 'resourcesPath' | 'folder' | 'openPath' | 'endpoint'> {
  settings(): EngineSettings
  /** Something the status shows changed. */
  changed(): void
  /** False hides the Claude subscription engine. */
  available?: boolean
  /** Tests replace the process runner, the shells (login, or interactive when `interactive`) and the spawn. */
  run?: (path: string, args: readonly string[], options: RunOptions) => Promise<RunResult>
  shell?: (script: string, interactive: boolean) => Promise<string | null>
  spawn?: ClaudeCodeDeps['spawn']
  isExecutable?: (path: string) => boolean
}

export class ClaudeCodeEngine {
  readonly backend: ClaudeCodeBackend
  readonly #deps: ClaudeCodeEngineDeps
  readonly #dir: string
  readonly #available: boolean
  #claude: ClaudeCodeStatus = blankStatus()
  #lookup: Promise<CliLookup | null> | null = null
  #checking: Promise<ClaudeCodeStatus> | null = null
  /** What the login and interactive shells said, asked once per look-up. */
  #probes: Promise<{ login: ShellProbe | null; interactive: ShellProbe | null }> | null = null
  readonly #versions: VersionReader
  readonly #minimumsPath: string
  #minimums: Minimums = {}
  #update: CliUpdateStatus = IDLE_UPDATE
  #updating: Promise<CliUpdateResult> | null = null
  /** `claude auth …` exists in the installed version. */
  #authCommands = false
  #processes = 0
  /** When a chat last found Claude Code signed out; a check that began earlier doesn't overrule it. */
  #signedOutAt = 0

  constructor(deps: ClaudeCodeEngineDeps) {
    this.#deps = deps
    this.#available = deps.available ?? CLAUDE_CODE_ENGINE_BUILT
    this.#dir = join(deps.dataDir, 'claude-code')
    this.#minimumsPath = join(this.#dir, 'minimums.json')
    this.#minimums = readMinimums(this.#minimumsPath)
    this.#versions = new VersionReader({ run: (path, args, options) => (deps.run ?? runCommand)(path, args, options), env: () => this.#childEnv(), mtime: fileMtime, cwd: deps.home })
    const configDir = join(this.#dir, 'mcp')
    mkdirSync(configDir, { recursive: true })
    // Config files from an earlier launch hold tokens that no longer open anything.
    for (const name of readdirSync(configDir)) rmSync(join(configDir, name), { force: true })
    this.backend = new ClaudeCodeBackend({
      cli: () => this.cli(),
      env: () => this.#childEnv(),
      folder: deps.folder,
      configDir,
      endpoint: (chatId) => deps.endpoint(chatId),
      onNote: (note) => this.#note(note),
      effort: () => deps.settings().effort ?? 'high',
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
    })
  }

  get available(): boolean {
    return this.#available
  }

  /** Claude Code's EngineStatus fields. */
  status(): { claudeCodeAvailable: boolean; claudeCode: ClaudeCodeStatus } {
    // The first look starts on demand; the result arrives as a change.
    if (this.#available && this.#claude.checkedAt === 0 && !this.#checking) void this.recheck()
    return {
      claudeCodeAvailable: this.#available,
      claudeCode: {
        ...this.#claude,
        ...(this.#checking ? { state: 'checking' as const } : {}),
        tooOld: this.#tooOld(),
        update: this.#update,
        // A limit that has passed no longer matters.
        rateLimit: this.#claude.rateLimit && (this.#claude.rateLimit.resetsAt ?? Infinity) > Date.now() && Date.now() - this.#claude.rateLimit.at < 12 * 3_600_000 ? this.#claude.rateLimit : null,
      },
    }
  }

  /** Where Claude Code stands, for the surfaces that show every engine alike. */
  summary(): EngineSummary {
    const { claudeCode } = this.status()
    const badge = claudeCode.state === 'checking' ? mainT('settings.engine.checking') : claudeCode.state === 'ready' ? mainT('settings.engine.ready') : claudeCode.state === 'signed-out' ? mainT('engines.settings.engine.notSignedIn') : claudeCode.state === 'not-found' ? mainT('engines.settings.engine.notFound') : mainT('engines.settings.engine.found')
    const tone = claudeCode.state === 'ready' ? 'success' : claudeCode.state === 'checking' ? 'neutral' : claudeCode.state === 'unknown' ? 'info' : 'warning'
    return { id: 'claude-code', ready: claudeCodeReady(claudeCode), checking: claudeCode.state === 'checking', detail: claudeCode.detail, badge, tone }
  }

  get processes(): number {
    return this.#processes
  }

  /** The CLI Atelier runs, looked up once and again after Re-check or a new path. */
  cli(): Promise<CliLookup | null> {
    this.#lookup ??= this.#resolve().then(({ found }) => found)
    return this.#lookup
  }

  /** Finds the CLI again and reads its version and sign-in. Never sends a message to a model. */
  recheck(): Promise<ClaudeCodeStatus> {
    if (!this.#available) return Promise.resolve(this.status().claudeCode)
    this.#checking ??= this.#check()
      .finally(() => {
        this.#checking = null
        this.#changed()
      })
      .then(() => this.status().claudeCode)
    this.#changed()
    return this.#checking
  }

  /** The settings changed: a new path means a new look-up. */
  settingsChanged(next: EngineSettings, previous: EngineSettings): void {
    if (next.claudeCodePath !== previous.claudeCodePath) {
      // New chats use the new path at once; a check already running used the old one, so look again after it.
      this.#lookup = null
      void (this.#checking ?? Promise.resolve()).then(() => this.recheck())
    }
  }

  /** Opens Terminal (Command Prompt on Windows) running Claude Code, so you sign in to your own Claude account there. */
  async openSignIn(): Promise<void> {
    if (this.#deps.platform !== 'darwin' && this.#deps.platform !== 'win32') throw new Error('Open a terminal, run claude and sign in, then press Re-check.')
    const cli = await this.cli()
    const command = cli ? `${shellQuote(cli.path, this.#deps.platform)}${this.#authCommands ? ' auth login' : ''}` : 'claude'
    await this.#openTerminal('sign-in.command', [`${BRAND_NAME}: sign in to Claude Code with your own Claude account.`, `${BRAND_NAME} uses this sign-in for your chats; it never sees your password.`], command, [`All done? Go back to ${BRAND_NAME} and press Re-check.`])
  }

  /**
   * Update Claude Code: runs the chosen CLI's own `claude update` in the
   * background (progress in the status), then finds the CLI again and reads
   * its version. An install it can't update itself, or an update that left
   * the version where it was, gets Terminal with the right command. One
   * update at a time; a second call joins the running one. `model` picks the
   * minimum to reach (the one its last version error named).
   */
  updateCli(model: string | null = null): Promise<CliUpdateResult> {
    this.#updating ??= this.#runUpdate(model).finally(() => {
      this.#updating = null
    })
    return this.#updating
  }

  async #runUpdate(model: string | null): Promise<CliUpdateResult> {
    const required = (model ? this.#minimums[model]?.version : undefined) ?? this.#tooOld()?.required ?? null
    try {
      return await this.#updateSteps(required)
    } catch (err) {
      // Never leave an update looking busy: it ends as failed, and the next press starts afresh.
      this.#step({ type: 'error', detail: err instanceof Error ? err.message : String(err) })
      return { outcome: 'failed', version: this.#claude.version, required, retried: false }
    }
  }

  async #updateSteps(required: string | null): Promise<CliUpdateResult> {
    const cli = await this.cli()
    this.#step({ type: 'start', from: cli?.version ?? this.#claude.version, required, at: Date.now() })
    let output = ''
    if (cli) {
      const env = { ...(await this.#childEnv()) }
      // The child normally runs with its updater off; this run is the update.
      delete env.DISABLE_AUTOUPDATER
      const run = this.#deps.run ?? runCommand
      // Progress at most four times a second: a spinner's output shouldn't flood the windows.
      let shownAt = 0
      let pending = ''
      const onOutput = (text: string): void => {
        pending += text
        if (Date.now() - shownAt < 250) return
        shownAt = Date.now()
        this.#step({ type: 'output', text: pending })
        pending = ''
      }
      const result = await run(cli.path, ['update'], { env, cwd: this.#deps.home, timeoutMs: UPDATE_TIMEOUT_MS, onOutput })
      output = `${result.stdout}\n${result.stderr}`
      this.#step({ type: 'exited', code: result.code, output, timedOut: result.timedOut })
    } else this.#step({ type: 'exited', code: null, output: mainT('engines.chat.mainService.claudeCodeIsnT'), timedOut: false })
    if (this.#update.phase === 'checking') {
      // Find it again: the update may have moved it, or made another install the newest.
      this.#versions.clear()
      await (this.#checking ?? Promise.resolve())
      await this.recheck()
      this.#step({ type: 'version', version: this.#claude.version })
      // Chats that are idle start the new CLI with their next message.
      this.backend.restartIdle()
    }
    if (this.#update.phase === 'opening-terminal') {
      const command = manualCommand({ path: cli?.path ?? 'claude', source: cli?.source ?? 'common-path', realPath: cli ? safeRealpath(cli.path) : null }, output, this.#deps.platform)
      // Linux has no one terminal app to open: the update is yours to run, with the command shown, not a failure.
      if (this.#deps.platform !== 'darwin' && this.#deps.platform !== 'win32') {
        this.#step({ type: 'terminal', command })
      } else {
        try {
          await this.#openTerminal('update.command', [mainT('engines.chat.mainService.terminalUpdateIntro')], command, [mainT('engines.chat.mainService.terminalUpdateDone')])
          this.#step({ type: 'terminal', command })
        } catch (err) {
          this.#step({ type: 'terminal-failed', command, detail: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    const phase = this.#update.phase
    const outcome = phase === 'updated' ? 'updated' : phase === 'still-old' ? 'still-old' : phase === 'manual' ? 'manual' : 'failed'
    return { outcome, version: this.#update.to ?? this.#claude.version, required, retried: false }
  }

  #step(event: UpdateEvent): void {
    const next = updateStep(this.#update, event)
    if (next === this.#update) return
    this.#update = next
    this.#changed()
  }

  /**
   * Writes a script and opens it, which runs it in a terminal (the sign-in and
   * the manual update): a .command in Terminal on macOS, a .cmd in Command
   * Prompt on Windows, which pauses at the end so the window stays to read.
   */
  async #openTerminal(name: string, intro: readonly string[], command: string, outro: readonly string[]): Promise<void> {
    const windows = this.#deps.platform === 'win32'
    if (!windows && this.#deps.platform !== 'darwin') throw new Error(`Open a terminal and run: ${command}`)
    const path = join(this.#dir, windows ? name.replace(/\.command$/, '.cmd') : name)
    writeAtomic(path, windows ? commandPromptScript(intro, command, outro) : terminalScript(intro, command, outro))
    if (!windows) chmodSync(path, 0o700)
    const failure = await this.#deps.openPath(path)
    const terminal = windows ? 'Command Prompt' : 'Terminal'
    if (failure) throw new Error(`${BRAND_NAME} couldn’t open ${terminal} (${failure}). Open ${terminal} yourself and run: ${command}`)
  }

  /** The newest minimum a model asked for that the chosen CLI is below, if any. */
  #tooOld(): ClaudeCodeStatus['tooOld'] {
    const version = this.#claude.version
    if (!version) return null
    const below = Object.entries(this.#minimums)
      .filter(([, m]) => compareVersions(version, m.version) < 0)
      .sort((a, b) => b[1].at - a[1].at)[0]
    return below ? { model: below[0], required: below[1].version } : null
  }

  #learnMinimum(model: string, version: string): void {
    const known = this.#minimums[model]
    if (known && known.version === version) return
    this.#minimums = { ...this.#minimums, [model]: { version, at: Date.now() } }
    try {
      writeAtomic(this.#minimumsPath, JSON.stringify(this.#minimums, null, 2))
    } catch (err) {
      console.warn(`${BRAND_NAME} could not save Claude Code’s minimum versions:`, err)
    }
  }

  /** The CLI Atelier found, with the environment it runs in (the external MCP server's Add for me uses it too). */
  async program(): Promise<{ path: string; env: Record<string, string> } | null> {
    if (!this.#available) return null
    const cli = await this.cli()
    return cli ? { path: cli.path, env: await this.#childEnv() } : null
  }

  async dispose(): Promise<void> {
    await this.backend.dispose()
  }

  async #resolve(): Promise<Resolution> {
    const deps = this.#deps
    const probes = this.#shellProbes()
    return resolveCli({
      override: deps.settings().claudeCodePath,
      env: deps.env,
      resourcesPath: deps.resourcesPath,
      home: deps.home,
      isExecutable: deps.isExecutable ?? isExecutableFile,
      loginShellLookup: async () => (await probes).login?.lookup ?? null,
      interactiveShellLookup: async () => (await probes).interactive?.lookup ?? null,
      readVersion: (path) => this.#versions.read(path),
      platform: deps.platform,
    })
  }

  /** Asks the login shell and an interactive one (which reads .zshrc, where npm's folder is often added), both at once. */
  #shellProbes(): Promise<{ login: ShellProbe | null; interactive: ShellProbe | null }> {
    // Windows has no login shell; the PATH Atelier inherited is the one a terminal there has.
    if (this.#deps.platform === 'win32' && !this.#deps.shell) this.#probes ??= Promise.resolve({ login: pathProbe(this.#deps.env, 'win32', this.#deps.isExecutable), interactive: null })
    this.#probes ??= Promise.all([false, true].map((interactive) => probeShell((script, until) => this.#shell(script, interactive, until)).catch(() => null))).then(([login, interactive]) => ({ login: login ?? null, interactive: interactive ?? null }))
    return this.#probes
  }

  async #check(): Promise<void> {
    const started = Date.now()
    this.#lookup = null
    // Re-check asks the shells again: Claude Code may have been installed since.
    this.#probes = null
    const lookup = this.#resolve()
    this.#lookup = lookup.then(({ found }) => found)
    const { found, overrideInvalid, installs } = await lookup
    const base = {
      ...blankStatus(),
      overrideInvalid,
      rateLimit: this.#claude.rateLimit,
      checkedAt: Date.now(),
      installs: installs.map((i) => ({ path: i.path, source: i.source, version: i.version, chosen: i.path === found?.path })),
    }
    if (!found) {
      this.#claude = {
        ...base,
        state: 'not-found',
        detail: overrideInvalid ? mainT('engines.chat.mainService.theLocationSetFor') : mainT('engines.chat.mainService.claudeCodeIsnT'),
        nextStep: mainT('engines.chat.mainService.installClaudeCodeOn'),
      }
      return
    }
    const env = await this.#childEnv()
    const run = this.#deps.run ?? runCommand
    const auth = await run(found.path, ['auth', 'status', '--json'], { env, cwd: this.#deps.home, timeoutMs: PROBE_TIMEOUT_MS })
    const parsed = parseAuthStatus(auth)
    const reading = this.#signedOutAt >= started ? { ...parsed, state: 'signed-out' as const, detail: mainT('engines.chat.mainService.claudeCodeSaidIt') } : parsed
    this.#authCommands = reading.state !== 'unknown' || auth.code === 0
    const common = { ...base, path: found.path, source: found.source, version: found.version ?? null, account: reading.account, detail: reading.detail }
    this.#claude =
      reading.state === 'ready'
        ? { ...common, state: 'ready', nextStep: null }
        : reading.state === 'signed-out'
          ? { ...common, state: 'signed-out', nextStep: mainT('engines.chat.mainService.pressSignInTerminal') }
          : { ...common, state: 'unknown', nextStep: mainT('engines.chat.mainService.pressReCheckIf') }
  }

  #note(note: { rateLimit?: RateLimitNote | null; signedOut?: boolean; processes?: number; minimum?: { model: string; version: string } }): void {
    if (note.processes !== undefined) this.#processes = note.processes
    if (note.minimum) this.#learnMinimum(note.minimum.model, note.minimum.version)
    if (note.rateLimit !== undefined) this.#claude = { ...this.#claude, rateLimit: note.rateLimit }
    if (note.signedOut) this.#signedOutAt = Date.now()
    if (note.signedOut && this.#claude.state !== 'not-found') {
      this.#claude = {
        ...this.#claude,
        state: 'signed-out',
        detail: mainT('engines.chat.mainService.claudeCodeSaidIt'),
        nextStep: mainT('engines.chat.mainService.pressSignInTerminal'),
      }
    }
    this.#changed()
  }

  async #childEnv(): Promise<Record<string, string>> {
    const { login, interactive } = await this.#shellProbes()
    // The interactive shell's PATH first: it is the one Terminal has (nvm's node, npm's folder).
    const path = [interactive?.path, login?.path].filter(Boolean).join(pathDelimiter(this.#deps.platform)) || null
    return childEnv(this.#deps.env, path, this.#deps.home, this.#deps.platform)
  }

  #shell(script: string, interactive: boolean, until: (stdout: string) => boolean): Promise<string | null> {
    if (this.#deps.shell) return this.#deps.shell(script, interactive)
    return loginShell(this.#deps.env.SHELL, script, { interactive, until })
  }

  #changed(): void {
    this.#deps.changed()
  }
}

/** The macOS terminal script: the intro, the command it runs, then the outro. */
function terminalScript(intro: readonly string[], command: string, outro: readonly string[]): string {
  const echo = (line: string): string => `echo ${JSON.stringify(line).replace(/\$/g, '\\$').replace(/`/g, '\\`')}`
  return ['#!/bin/sh', 'clear', ...intro.map(echo), 'echo', command, 'echo', ...outro.map(echo), ''].join('\n')
}

/**
 * The same for Command Prompt. It reads the file in UTF-8 (chcp 65001), the
 * echoed text has cmd.exe's own characters escaped, % is doubled as a batch
 * file needs, and a pause keeps the window open at the end.
 */
export function commandPromptScript(intro: readonly string[], command: string, outro: readonly string[]): string {
  const batch = (text: string): string => text.replace(/%/g, '%%')
  const echo = (line: string): string => (line.trim() ? `echo ${batch(line.replace(/[\^&|<>]/g, '^$&'))}` : 'echo.')
  return ['@echo off', 'chcp 65001 >nul', 'cls', ...intro.map(echo), 'echo.', batch(command), 'echo.', ...outro.map(echo), 'pause', ''].join('\r\n')
}

function blankStatus(): ClaudeCodeStatus {
  return { state: 'checking', path: null, source: null, version: null, account: null, detail: mainT('engines.chat.mainService.lookingForClaudeCode'), nextStep: null, overrideInvalid: false, rateLimit: null, checkedAt: 0, installs: [], tooOld: null, update: IDLE_UPDATE }
}

function readMinimums(path: string): Minimums {
  try {
    const parsed = MinimumsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
