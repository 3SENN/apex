/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OsPlatform } from '@shared/system'
import { isExecutableFile, mergePath, STRIPPED_ENV } from '../system/shell'
import { log } from '../log'
import { findCommand, killTree, spawnProgram, windowsEssentials, withPath } from '../system/programs'
import { McpSession, ProcessTransport } from './client'
import { mainT } from '../i18n/mainT'

// Local (stdio) MCP servers. Each runs without a shell, with the
// login shell's PATH, in its own process group (so the whole tree can be
// killed), from a confined working folder unless you chose one. On Windows a
// bare command is found with PATHEXT (npx is npx.cmd, which runs as the node
// script it wraps), and taskkill ends the tree. A ring buffer keeps recent
// output with secret values masked. Crashes restart with backoff, idle
// servers stop after ten minutes, and quitting kills them all. The manager
// never decides whether a command may run: callers check OV-09's approval
// first.

export const IDLE_MS = 10 * 60_000
const LOG_LINES = 200
const BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000]
const MAX_CRASHES = BACKOFF_MS.length

export interface LocalSpec {
  id: string
  command: string
  args: string[]
  cwd: string | null
  env: Record<string, string>
  /** Values masked in logs. */
  secrets: string[]
}

export type LocalState = { state: 'starting' } | { state: 'ok' } | { state: 'stopped' } | { state: 'error'; detail: string }

interface Running {
  spec: LocalSpec
  /** Null until the spawn, which waits for the login PATH. */
  child: ChildProcess | null
  session: Promise<McpSession>
  lastUsed: number
  stopping: boolean
  /** Reached ok once; only then does a crash restart it. */
  ready: boolean
}

export interface LocalServersDeps {
  /** Where confined working folders go: <root>/<id>. */
  root: string
  /** The login shell's PATH, or null. */
  loginPath(): Promise<string | null>
  onState(id: string, state: LocalState): void
  home: string
  now?: () => number
}

export class LocalServers {
  readonly #deps: LocalServersDeps
  readonly #running = new Map<string, Running>()
  readonly #logs = new Map<string, string[]>()
  readonly #crashes = new Map<string, { count: number; timer: NodeJS.Timeout | null }>()
  readonly #idle: NodeJS.Timeout

  constructor(deps: LocalServersDeps) {
    this.#deps = deps
    this.#idle = setInterval(() => this.#reapIdle(), 60_000)
    this.#idle.unref?.()
  }

  logs(id: string): string[] {
    return (this.#logs.get(id) ?? []).slice()
  }

  isRunning(id: string): boolean {
    return this.#running.has(id)
  }

  /** The connected session, starting the server first when needed. */
  async session(spec: LocalSpec): Promise<McpSession> {
    const now = this.#deps.now?.() ?? Date.now()
    const existing = this.#running.get(spec.id)
    if (existing && JSON.stringify(existing.spec) === JSON.stringify(spec)) {
      existing.lastUsed = now
      return existing.session
    }
    if (existing) await this.stop(spec.id)
    return this.#start(spec).session
  }

  async stop(id: string, state: LocalState = { state: 'stopped' }): Promise<void> {
    const crash = this.#crashes.get(id)
    if (crash?.timer) clearTimeout(crash.timer)
    this.#crashes.delete(id)
    const running = this.#running.get(id)
    if (!running) return
    running.stopping = true
    this.#running.delete(id)
    void running.session.then((s) => s.close()).catch(() => undefined)
    if (running.child) stopTree(running.child)
    this.#deps.onState(id, state)
  }

  async stopAll(): Promise<void> {
    clearInterval(this.#idle)
    await Promise.all([...this.#running.keys()].map((id) => this.stop(id)))
  }

  /** A restart after a crash or a Reconnect: the crash count starts again. */
  async restart(spec: LocalSpec): Promise<McpSession> {
    await this.stop(spec.id)
    return this.session(spec)
  }

  #start(spec: LocalSpec): Running {
    this.#deps.onState(spec.id, { state: 'starting' })
    const cwd = spec.cwd ?? join(this.#deps.root, spec.id)
    if (!spec.cwd) mkdirSync(cwd, { recursive: true })
    const running: Running = { spec, child: null, session: Promise.resolve(null as unknown as McpSession), lastUsed: this.#deps.now?.() ?? Date.now(), stopping: false, ready: false }
    const session = (async (): Promise<McpSession> => {
      const loginPath = await this.#deps.loginPath()
      const PATH = mergePath(loginPath, process.env.PATH ?? null, this.#deps.home)
      const command = resolveCommand(spec.command, PATH)
      if (!command) throw new Error(`Couldn’t find ${spec.command} on this computer.`)
      const env = { ...withPath(baseEnv(), PATH), ...spec.env }
      // A process group of its own elsewhere; Windows has none (and a detached child there gets a console of its own).
      const child = spawnProgram(command, spec.args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      running.child = child
      // Stopped while the PATH lookup ran: don't leave the new process behind.
      if (running.stopping) {
        stopTree(child)
        throw new Error('stopped')
      }
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.#log(spec, line)
      })
      child.once('exit', (code, signal) => this.#exited(spec, running, code, signal))
      const spawned = await new Promise<Error | null>((resolve) => {
        child.once('spawn', () => resolve(null))
        child.once('error', (err) => resolve(err))
      })
      if (spawned) throw new Error(`Couldn’t start ${spec.command}: ${spawned.message}`)
      const s = await McpSession.connect(new ProcessTransport(child, (line) => this.#log(spec, line)))
      running.ready = true
      this.#deps.onState(spec.id, { state: 'ok' })
      return s
    })()
    running.session = session
    this.#running.set(spec.id, running)
    session.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      this.#log(spec, detail)
      if (this.#running.get(spec.id) === running) {
        this.#running.delete(spec.id)
        if (running.child) stopTree(running.child)
        this.#deps.onState(spec.id, { state: 'error', detail: mask(detail, spec.secrets) })
      }
    })
    return running
  }

  #exited(spec: LocalSpec, running: Running, code: number | null, signal: NodeJS.Signals | null): void {
    this.#log(spec, `exited (${signal ?? `code ${code ?? '?'}`})`)
    if (running.stopping || this.#running.get(spec.id) !== running) return
    this.#running.delete(spec.id)
    void running.session.then((s) => s.close()).catch(() => undefined)
    if (!running.ready) {
      this.#deps.onState(spec.id, { state: 'error', detail: mask(this.#logs.get(spec.id)?.slice(-2).join(' · ') || mainT('connectors.mainLocalServers.theServerStopped', { value: signal ?? mainT('connectors.mainLocalServers.exitCode', { value: code ?? '?' }) }), spec.secrets) })
      return
    }
    const crash = this.#crashes.get(spec.id) ?? { count: 0, timer: null }
    crash.count++
    if (crash.count > MAX_CRASHES) {
      this.#crashes.delete(spec.id)
      this.#deps.onState(spec.id, { state: 'error', detail: mainT('connectors.mainLocalServers.theServerKeptStopping', { value: signal ?? mainT('connectors.mainLocalServers.exitCode', { value: code ?? '?' }) }) })
      return
    }
    const delay = BACKOFF_MS[crash.count - 1] ?? 30_000
    this.#deps.onState(spec.id, { state: 'starting' })
    crash.timer = setTimeout(() => {
      crash.timer = null
      if (!this.#running.has(spec.id)) this.#start(spec).session.catch(() => undefined)
    }, delay)
    crash.timer.unref?.()
    this.#crashes.set(spec.id, crash)
  }

  #reapIdle(): void {
    const now = this.#deps.now?.() ?? Date.now()
    for (const [id, r] of this.#running) if (now - r.lastUsed >= IDLE_MS) void this.stop(id)
  }

  /** Runs the idle check now (tests). */
  reapIdleNow(): void {
    this.#reapIdle()
  }

  #log(spec: LocalSpec, line: string): void {
    const lines = this.#logs.get(spec.id) ?? []
    lines.push(mask(line.slice(0, 2000), spec.secrets))
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES)
    this.#logs.set(spec.id, lines)
    log.debug('connectors', `[${spec.id.slice(0, 8)}] ${line.slice(0, 500)}`)
  }
}

/** Replaces every secret value with dots. */
export function mask(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of [...secrets].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join('••••')
  return out
}

/** An absolute command as is; a bare name through PATH (with PATHEXT on Windows). Never through a shell. */
export function resolveCommand(command: string, PATH: string, isExecutable: (p: string) => boolean = isExecutableFile, platform: OsPlatform = process.platform): string | null {
  return findCommand(command, PATH, { platform, isExecutable })
}

/**
 * The few inherited variables a server needs; Atelier's own (Electron's,
 * editors') are left out. Windows programs need more of the system's own:
 * Node can't open a socket without SystemRoot, npx can't find its cache
 * without APPDATA.
 */
export function baseEnv(base: NodeJS.ProcessEnv = process.env, platform: OsPlatform = process.platform): Record<string, string> {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']
  const env: Record<string, string> = platform === 'win32' ? windowsEssentials(base) : {}
  for (const key of keep) {
    const value = base[key]
    if (value !== undefined && !STRIPPED_ENV.has(key)) env[key] = value
  }
  return env
}

/** SIGTERM to the process group, then SIGKILL if it is still there (on Windows taskkill ends the tree at once). */
function stopTree(child: ChildProcess): void {
  killTree(child, 'SIGTERM', { group: true })
  if (process.platform === 'win32') return
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL', { group: true })
  }, 2000)
  timer.unref?.()
}
