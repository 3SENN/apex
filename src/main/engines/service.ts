/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtraEngineId } from '@internal/engines/shared'
import { createExtraEngines } from '@internal/engines/main'
import type { EngineStatus } from '@shared/engine'
import { McpServer } from '../mcp/server'
import { OUTSIDE_PATH, OutsideAccess, type OutsideDeps } from '../mcp/external'
import { chatToken, newSecret, tokensEqual } from '../mcp/secrets'
import { loginShell, mergePath, pathProbe, probeShell, runCommand, STRIPPED_ENV, type RunOptions, type RunResult } from '../system/shell'
import { pathKey, withPath } from '../system/programs'
import { mainT } from '../i18n/mainT'
import type { EngineSettings, ExtraEngines, ExtraEnginesDeps } from './extras'
import type { AgentBackend } from './backend'

// Engines in one place (ST-58 to ST-60): which engine new chats use, the
// API key's state, the engines a build adds (./extras.ts), the local MCP
// server their chats reach Apex's tools on, and the opt-in route that lets
// Claude Code, or any MCP client, in the person's own terminal use Apex's
// browser tools (mcp/external.ts).
//
// Bring your own model: every engine runs on the person's own account. Apex
// never holds, proxies or meters that access.

export type { EngineSettings } from './extras'

const CHAT_PATH = /^\/mcp\/chat\/([0-9a-f-]{36})$/
const PROBE_TIMEOUT_MS = 10_000

export interface EngineServiceDeps extends Omit<ExtraEnginesDeps, 'endpoint' | 'changed'> {
  apiKeyState(): EngineStatus['apiKey']['state']
  outside: Omit<OutsideDeps, 'dir' | 'enabled' | 'tabs' | 'onChange'>
  /** Tests and builds without them pass their own engines; by default the build's (`@internal/engines/main`). */
  extras?(deps: ExtraEnginesDeps): ExtraEngines
  /** Tests replace the process runner and the shell (Add for me). */
  run?: (path: string, args: readonly string[], options: RunOptions) => Promise<RunResult>
  shell?: (script: string, interactive: boolean) => Promise<string | null>
}

export class EngineService extends EventEmitter<{ changed: [EngineStatus] }> {
  readonly outside: OutsideAccess
  readonly extras: ExtraEngines
  readonly #deps: EngineServiceDeps
  readonly #server: McpServer
  /** Made at launch: every chat token derives from it and dies with it. */
  readonly #launchSecret = newSecret()
  #lastEmitted = ''

  constructor(deps: EngineServiceDeps) {
    super()
    this.#deps = deps
    // The external route's secret and port (the folder is named for the client it was first made for).
    const dir = join(deps.dataDir, 'claude-code')
    mkdirSync(dir, { recursive: true })
    this.outside = new OutsideAccess({
      ...deps.outside,
      dir,
      enabled: () => deps.settings().externalAccess,
      tabs: () => deps.settings().externalTabs,
      onChange: () => this.#changed(),
    })
    this.#server = new McpServer((path, token) => this.#route(path, token))
    const extras = deps.extras ?? createExtraEngines
    this.extras = extras({
      ...deps,
      endpoint: async (chatId) => ({ url: `${await this.#listen()}/mcp/chat/${chatId}`, token: chatToken(this.#launchSecret, chatId) }),
      changed: () => this.#changed(),
    })
  }

  /** The engines this build offers besides the API key. */
  get available(): readonly ExtraEngineId[] {
    return this.extras.ids
  }

  /** The chat backends of the engines besides the API key. */
  get backends(): Partial<Record<ExtraEngineId, AgentBackend>> {
    return this.extras.backends
  }

  status(): EngineStatus {
    const settings = this.#deps.settings()
    const port = this.#server.port
    const offered = this.extras.ids as readonly string[]
    return {
      ...this.extras.status(),
      engine: settings.engine === 'api-key' || offered.includes(settings.engine) ? settings.engine : 'api-key',
      engines: ['api-key', ...this.extras.ids],
      apiKey: { state: this.#deps.apiKeyState() },
      others: this.extras.summaries(),
      external: this.outside.status(port !== null ? `http://127.0.0.1:${port}${OUTSIDE_PATH}` : null),
      processes: this.extras.processes(),
    }
  }

  /** The settings changed: the engines look again where they need to; the outside route follows its switch. */
  async settingsChanged(next: EngineSettings, previous: EngineSettings): Promise<void> {
    this.extras.settingsChanged(next, previous)
    if (next.externalAccess !== previous.externalAccess) {
      this.outside.problem = null
      if (next.externalAccess) {
        try {
          if (!this.outside.ensureSecret()) throw new Error(`Secure storage is unavailable on this system, so ${BRAND_NAME} can’t keep the access secret safe.`)
          await this.#listen()
        } catch (err) {
          this.outside.problem = err instanceof Error ? err.message : String(err)
          this.#changed()
          throw err
        }
      } else this.outside.stopAll()
    }
    if (next.externalTabs !== previous.externalTabs) this.outside.stopAll()
    this.#changed()
  }

  /** At start-up: the outside route listens again on its saved port if it is on. */
  async start(): Promise<void> {
    if (this.#deps.settings().externalAccess) await this.#listen().catch((err: unknown) => console.warn(`${BRAND_NAME} could not start its local tools server:`, err))
    await this.extras.start()
  }

  /** ST-60: runs `claude mcp add …` for you when Claude Code is found on this computer. */
  async addToClaudeCode(): Promise<{ ok: boolean; message: string }> {
    const program = await this.#claudeProgram()
    if (!program) return { ok: false, message: mainT('chat.mainService.apexCanTFind') }
    const url = await this.#outsideUrl()
    const args = this.outside.addArgs(url)
    if (!args) return { ok: false, message: mainT('chat.mainService.turnOnAccessFor') }
    const run = this.#deps.run ?? runCommand
    const options = { env: program.env, cwd: this.#deps.home, timeoutMs: PROBE_TIMEOUT_MS }
    if (this.outside.addedBefore) await run(program.path, this.outside.removeArgs(), options)
    const result = await run(program.path, args, options)
    if (result.code === 0) {
      this.outside.markAdded(url)
      this.#changed()
      return { ok: true, message: mainT('chat.mainService.apexIsAddedTo') }
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (/already exists/i.test(output)) {
      return { ok: false, message: mainT('chat.mainService.claudeCodeAlreadyHas') }
    }
    return { ok: false, message: mainT('chat.mainService.claudeCodeDidnT', { value: output ? `: ${output.split('\n').at(-1)}` : '.' }) }
  }

  /** The command with its secret, for the clipboard. */
  async outsideCommand(): Promise<string> {
    const program = await this.#claudeProgram()
    const command = this.outside.command(program?.path ?? 'claude', await this.#outsideUrl())
    if (!command) throw new Error('Turn on access for Claude Code first.')
    return command
  }

  /** Revoke: a new secret; the command added before stops working. */
  rotate(): EngineStatus {
    this.outside.rotate()
    return this.status()
  }

  async dispose(): Promise<void> {
    this.outside.stopAll()
    await this.extras.dispose()
    await this.#server.close()
  }

  /**
   * The `claude` program for Add for me: the one an engine already found,
   * else the one the person's shell finds (Windows: along the inherited PATH).
   */
  async #claudeProgram(): Promise<{ path: string; env: Record<string, string> } | null> {
    const known = await this.extras.claudeProgram?.()
    if (known) return known
    const deps = this.#deps
    const probe =
      deps.platform === 'win32' && !deps.shell
        ? pathProbe('claude', deps.env, 'win32')
        : await probeShell('claude', (script, until) => (deps.shell ? deps.shell(script, true) : loginShell(deps.env.SHELL, script, { interactive: true, until }))).catch(() => null)
    if (!probe?.lookup) return null
    const base = Object.fromEntries(Object.entries(deps.env).filter((e): e is [string, string] => e[1] !== undefined && !STRIPPED_ENV.has(e[0])))
    const env = withPath(base, mergePath(probe.path, deps.env[pathKey(deps.env, deps.platform)] ?? null, deps.home, deps.platform), deps.platform)
    return { path: probe.lookup, env }
  }

  async #outsideUrl(): Promise<string> {
    if (!this.#deps.settings().externalAccess) throw new Error('Turn on access for Claude Code first.')
    return `${await this.#listen()}${OUTSIDE_PATH}`
  }

  async #listen(): Promise<string> {
    const port = await this.#server.listen(this.outside.preferredPort)
    this.outside.rememberPort(port)
    return `http://127.0.0.1:${port}`
  }

  #route(path: string, token: string | null) {
    const chat = CHAT_PATH.exec(path)
    if (chat?.[1]) return tokensEqual(token, chatToken(this.#launchSecret, chat[1])) ? this.extras.route(chat[1]) : null
    if (path === OUTSIDE_PATH) return this.outside.route(token)
    return null
  }

  /** Emits only real changes: settings events arrive for every setting. */
  #changed(): void {
    const status = this.status()
    const key = JSON.stringify(status)
    if (key === this.#lastEmitted) return
    this.#lastEmitted = key
    this.emit('changed', status)
  }
}
