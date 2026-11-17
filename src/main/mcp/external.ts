/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ExternalAccessStatus, ExternalTabs } from '@shared/engine'
import { MCP_SERVER_NAME } from '@shared/engine'
import { BrowserToolExecutor, errorMessage, type ExecutorDeps } from '../agent/browserTool'
import { shellQuote } from '../system/shell'
import { writeAtomic } from '../settings'
import { readJson } from '../stores'
import { fingerprint, tokensEqual } from './secrets'
import { browserToolSpecs, errorResult, toMcpResult } from './tools'
import type { McpRoute } from './server'

// ST-60: an opt-in route that lets a Claude Code session in your terminal or
// editor use Atelier's browser tools. It has its own secret, kept encrypted and
// stable across launches so the command you add keeps working until you
// revoke it (which makes a new secret). Its tabs carry the agent marker, it
// only touches the tabs you allow, and consequential actions always ask.

export const OUTSIDE_PATH = '/mcp/outside'
/** Its tabs are let go after this long without a call. */
export const OUTSIDE_IDLE_MS = 2 * 60_000

export interface SecretBox {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export interface OutsideDeps {
  /** Where the encrypted secret and the saved port live. */
  dir: string
  box: SecretBox
  executor: Pick<ExecutorDeps, 'tabs' | 'bridge'>
  /** Asks you in Atelier; resolves false when you decline or the request goes away. */
  approve(description: string, origin: string, signal: AbortSignal): Promise<boolean>
  /** Marks the tab as driven from outside; throws while one of your chats drives it. */
  claim(tabId: string): void
  /** Lets go of every tab it holds. */
  release(): void
  enabled(): boolean
  tabs(): ExternalTabs
  onChange(): void
}

interface SavedState {
  port: number | null
  /** Fingerprint of the secret and URL last added through Atelier. */
  added: string | null
}

export class OutsideAccess {
  readonly #deps: OutsideDeps
  readonly #executor: BrowserToolExecutor
  /** Tabs it opened itself (the only ones it may use under 'own'). */
  readonly #own = new Set<string>()
  readonly #held = new Set<string>()
  #opening = false
  #secret: string | null = null
  #state: SavedState
  #lastUsedAt: number | null = null
  #idle: NodeJS.Timeout | null = null
  /** Shown in Settings when turning it on failed. */
  problem: string | null = null

  constructor(deps: OutsideDeps) {
    this.#deps = deps
    const raw = readJson(join(deps.dir, 'outside.json')) as Partial<SavedState> | null
    this.#state = { port: typeof raw?.port === 'number' && raw.port > 0 && raw.port < 65536 ? raw.port : null, added: typeof raw?.added === 'string' ? raw.added : null }
    this.#executor = new BrowserToolExecutor({
      ...deps.executor,
      // Outside sessions always ask, whatever the setting for your own chats.
      confirmConsequentialActions: () => true,
      requestApproval: (description, origin, signal) => deps.approve(`Claude Code ${description}.`, origin, signal),
      onTabTouched: (tabId) => this.#touch(tabId),
    })
  }

  /** The port it was last reachable on, so the added command keeps working. */
  get preferredPort(): number | null {
    return this.#state.port
  }

  rememberPort(port: number): void {
    if (this.#state.port === port) return
    this.#state = { ...this.#state, port }
    this.#save()
  }

  route(token: string | null): McpRoute | null {
    if (!this.#deps.enabled()) return null
    const secret = this.#loadSecret()
    if (!secret || !tokensEqual(token, secret)) return null
    return {
      name: BRAND_NAME,
      tools: () => browserToolSpecs(),
      call: async (name, args, signal) => {
        if (!this.#deps.enabled()) return errorResult(`${BRAND_NAME} turned off access for Claude Code.`)
        this.#lastUsedAt = Date.now()
        this.#armIdle()
        // new_tab claims its tab after an await inside the executor, so the flag holds until it settles.
        this.#opening = name === 'new_tab'
        try {
          const output = await this.#executor.execute(name, args, signal)
          this.#deps.onChange()
          return toMcpResult(output)
        } catch (err) {
          return errorResult(`Error: ${errorMessage(err)}`)
        } finally {
          this.#opening = false
        }
      },
    }
  }

  status(url: string | null): ExternalAccessStatus {
    const enabled = this.#deps.enabled()
    const secret = enabled ? this.#loadSecret() : null
    return {
      enabled,
      url,
      command: url && secret ? addCommand('claude', url, '••••••••') : null,
      tabs: this.#deps.tabs(),
      added: Boolean(url && secret && this.#state.added === fingerprint(secret, url)),
      activeTabs: this.#held.size,
      lastUsedAt: this.#lastUsedAt,
      problem: this.problem,
    }
  }

  /** The command with the real secret, for the clipboard or the run button. */
  command(cli: string, url: string): string | null {
    const secret = this.#loadSecret(true)
    return secret ? addCommand(cli, url, secret) : null
  }

  /** Arguments for `claude mcp add …` (run without a shell). */
  addArgs(url: string): string[] | null {
    const secret = this.#loadSecret(true)
    return secret ? ['mcp', 'add', '--transport', 'http', '--scope', 'user', MCP_SERVER_NAME, url, '--header', `Authorization: Bearer ${secret}`] : null
  }

  removeArgs(): string[] {
    return ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]
  }

  /** Makes the secret if there is none yet. False when secure storage is unavailable. */
  ensureSecret(): boolean {
    return this.#loadSecret(true) !== null
  }

  /** Whether Atelier added its entry before (so replacing it is safe). */
  get addedBefore(): boolean {
    return this.#state.added !== null
  }

  markAdded(url: string): void {
    const secret = this.#loadSecret()
    this.#state = { ...this.#state, added: secret ? fingerprint(secret, url) : null }
    this.#save()
  }

  /** Revoke: a new secret, so the command added before stops working at once. */
  rotate(): void {
    this.#secret = null
    rmSync(this.#secretPath(), { force: true })
    this.stopAll()
    if (this.#deps.enabled()) this.#loadSecret(true)
    this.#deps.onChange()
  }

  /** Lets go of every tab (turned off, revoked, or idle). */
  stopAll(): void {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = null
    this.#own.clear()
    this.#held.clear()
    this.#deps.release()
  }

  #touch(tabId: string): void {
    if (this.#opening) this.#own.add(tabId)
    if (this.#deps.tabs() === 'own' && !this.#own.has(tabId)) {
      throw new Error(`${BRAND_NAME} lets Claude Code use only the tabs it opens itself. Open one with new_tab, or ask the user to allow any tab in ${BRAND_NAME}’s settings.`)
    }
    this.#deps.claim(tabId)
    this.#held.add(tabId)
  }

  #armIdle(): void {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = setTimeout(() => {
      this.#held.clear()
      this.#deps.release()
      this.#deps.onChange()
    }, OUTSIDE_IDLE_MS)
    this.#idle.unref?.()
  }

  /** Reads the encrypted secret; `create` makes one when there is none. Null when it can't be kept safely. */
  #loadSecret(create = false): string | null {
    if (this.#secret) return this.#secret
    const path = this.#secretPath()
    if (existsSync(path) && this.#deps.box.available()) {
      try {
        this.#secret = this.#deps.box.decrypt(readFileSync(path))
        return this.#secret
      } catch {
        rmSync(path, { force: true })
      }
    }
    if (!create || !this.#deps.box.available()) return null
    this.#secret = randomBytes(32).toString('base64url')
    writeAtomic(path, this.#deps.box.encrypt(this.#secret))
    return this.#secret
  }

  #secretPath(): string {
    return join(this.#deps.dir, 'outside-secret.bin')
  }

  #save(): void {
    writeAtomic(join(this.#deps.dir, 'outside.json'), JSON.stringify(this.#state, null, 2))
  }
}

/** `claude mcp add` for Atelier's outside route, quoted for the terminal (Command Prompt on Windows). */
export function addCommand(cli: string, url: string, secret: string, platform: NodeJS.Platform = process.platform): string {
  return [shellQuote(cli, platform), 'mcp', 'add', '--transport', 'http', '--scope', 'user', MCP_SERVER_NAME, url, '--header', shellQuote(`Authorization: Bearer ${secret}`, platform)].join(' ')
}
