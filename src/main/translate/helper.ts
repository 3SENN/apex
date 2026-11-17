/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import type { AppleStatus, TranslateErrorCode } from '@shared/translate'
import { log } from '../log'

// The on-device translation helper's main side (TR-05). native/translate is a
// small Swift program on Apple's Translation and NaturalLanguage frameworks;
// it starts on first use, answers JSON lines (one reply per request id), and
// is stopped after a quiet spell. Tests and smoke point ATELIER_TRANSLATE_HELPER
// at a script, or pass a spawner of their own. Every line it prints is
// checked here; anything else is dropped.

const ERROR_CODES = ['not-installed', 'unsupported', 'unavailable', 'failed', 'bad-request'] as const
const id = z.number().int().nonnegative()

const helperLine = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('status'), status: z.enum(['installed', 'supported', 'unsupported', 'unavailable']) }),
  z.object({ id, type: z.literal('result'), texts: z.array(z.string().max(100_000)).max(128) }),
  z.object({ id, type: z.literal('detect'), language: z.string().max(35).nullable(), confidence: z.number().min(0).max(1) }),
  z.object({ id, type: z.literal('error'), code: z.enum(ERROR_CODES), message: z.string().max(2000) }),
])

export type HelperLine = z.infer<typeof helperLine>

export function parseHelperLine(text: string): HelperLine | null {
  try {
    const parsed = helperLine.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A failure the controller can show: the helper's code, with bad-request folded into failed. */
export class HelperError extends Error {
  constructor(
    readonly code: TranslateErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HelperError'
  }
}

const isScript = (path: string): boolean => /\.(m?js|cjs)$/.test(path)

export function translateHelperPath(o: { packaged: boolean; resourcesPath: string; appPath: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): string | null {
  const env = o.env ?? process.env
  const override = env.ATELIER_TRANSLATE_HELPER
  if (override) {
    // A fused build can't run a script as Node; only a smoke run that lends its own Node may.
    if (o.packaged && isScript(override) && !(env.ATELIER_SMOKE === '1' && env.ATELIER_SMOKE_NODE)) return null
    return existsSync(override) ? override : null
  }
  if ((o.platform ?? process.platform) !== 'darwin') return null
  const path = o.packaged ? join(o.resourcesPath, 'atelier-translate') : join(o.appPath, 'native', 'translate', 'build', 'atelier-translate')
  return existsSync(path) ? path : null
}

export interface HelperProcess {
  stdin: Writable
  stdout: Readable
  kill(): void
  once(event: 'exit', listener: () => void): unknown
}

export type HelperSpawner = (helper: string) => HelperProcess

/** The real process: a binary, or (tests' fake) a script under this process's Node. */
export const spawnHelper: HelperSpawner = (helper) => {
  if (isScript(helper)) {
    const node = process.env.ATELIER_SMOKE === '1' ? process.env.ATELIER_SMOKE_NODE : undefined
    if (node) return spawn(node, [helper], { stdio: ['pipe', 'pipe', 'ignore'] })
    return spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  }
  return spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] })
}

const TIMEOUT_MS = { status: 8000, translate: 45_000, detect: 5000 } as const
const IDLE_MS = 5 * 60_000
const STATUS_TTL_MS = 15_000
/** Crashes in a row before the helper counts as unavailable until Atelier restarts. */
const CRASHES_MAX = 3

interface Pending {
  resolve(line: HelperLine): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface TranslateHelperOptions {
  /** The helper's path, read on each start (null: unavailable). */
  path(): string | null
  spawner?: HelperSpawner
  idleMs?: number
  now?: () => number
}

export class TranslateHelper {
  readonly #opts: TranslateHelperOptions
  #proc: HelperProcess | null = null
  #buffer = ''
  #nextId = 1
  readonly #pending = new Map<number, Pending>()
  #idle: ReturnType<typeof setTimeout> | null = null
  #crashes = 0
  readonly #statuses = new Map<string, { status: AppleStatus; at: number }>()

  constructor(opts: TranslateHelperOptions) {
    this.#opts = opts
  }

  get broken(): boolean {
    return this.#crashes >= CRASHES_MAX
  }

  /** Whether Apple can translate the pair here; 'unavailable' without a helper. Never throws. */
  async status(source: string, target: string): Promise<AppleStatus> {
    const key = `${source}>${target}`
    const now = (this.#opts.now ?? Date.now)()
    const cached = this.#statuses.get(key)
    if (cached && now - cached.at < STATUS_TTL_MS) return cached.status
    try {
      const line = await this.#request({ op: 'status', source, target }, TIMEOUT_MS.status)
      const status: AppleStatus = line.type === 'status' ? line.status : 'unavailable'
      this.#statuses.set(key, { status, at: now })
      return status
    } catch {
      return 'unavailable'
    }
  }

  async translate(source: string, target: string, texts: string[]): Promise<string[]> {
    const line = await this.#request({ op: 'translate', source, target, texts }, TIMEOUT_MS.translate)
    if (line.type === 'result' && line.texts.length === texts.length) return line.texts
    if (line.type === 'error') {
      // The pair stopped being usable (a download was removed): ask again next time.
      this.#statuses.delete(`${source}>${target}`)
      throw new HelperError(line.code === 'bad-request' ? 'failed' : line.code, line.message)
    }
    throw new HelperError('failed', `The translation helper gave an answer ${BRAND_NAME} does not expect.`)
  }

  /** NaturalLanguage's guess, or null when the helper is missing or unsure. */
  async detect(text: string): Promise<{ language: string; confidence: number } | null> {
    try {
      const line = await this.#request({ op: 'detect', text: text.slice(0, 4000) }, TIMEOUT_MS.detect)
      return line.type === 'detect' && line.language ? { language: line.language, confidence: line.confidence } : null
    } catch {
      return null
    }
  }

  dispose(): void {
    this.#stop()
  }

  #request(body: Record<string, unknown>, timeoutMs: number): Promise<HelperLine> {
    const proc = this.#ensure()
    if (!proc) return Promise.reject(new HelperError('unavailable', 'On-device translation is not available here.'))
    const requestId = this.#nextId++
    return new Promise<HelperLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(new HelperError('failed', 'The translation helper took too long.'))
      }, timeoutMs)
      this.#pending.set(requestId, { resolve, reject, timer })
      try {
        proc.stdin.write(`${JSON.stringify({ id: requestId, ...body })}\n`)
      } catch (err) {
        clearTimeout(timer)
        this.#pending.delete(requestId)
        reject(new HelperError('unavailable', err instanceof Error ? err.message : String(err)))
      }
      this.#touch()
    })
  }

  #ensure(): HelperProcess | null {
    if (this.#proc) return this.#proc
    if (this.broken) return null
    const path = this.#opts.path()
    if (!path) return null
    let proc: HelperProcess
    try {
      proc = (this.#opts.spawner ?? spawnHelper)(path)
    } catch (err) {
      log.warn('translate', 'Could not start the translation helper', { error: err instanceof Error ? err.message : String(err) })
      this.#crashes = CRASHES_MAX
      return null
    }
    this.#proc = proc
    this.#buffer = ''
    proc.stdout.setEncoding?.('utf8')
    proc.stdout.on('data', (chunk: string | Buffer) => this.#read(String(chunk)))
    proc.stdin.on('error', () => undefined)
    proc.once('exit', () => {
      if (this.#proc !== proc) return
      const hadWork = this.#pending.size > 0
      this.#proc = null
      if (hadWork) this.#crashes++
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer)
        p.reject(new HelperError('failed', 'The translation helper stopped.'))
      }
      this.#pending.clear()
    })
    return proc
  }

  #read(chunk: string): void {
    this.#buffer += chunk
    let nl = this.#buffer.indexOf('\n')
    while (nl >= 0) {
      const text = this.#buffer.slice(0, nl).trim()
      this.#buffer = this.#buffer.slice(nl + 1)
      nl = this.#buffer.indexOf('\n')
      if (!text) continue
      const line = parseHelperLine(text)
      if (!line) {
        log.debug('translate', 'The translation helper printed a line outside the protocol')
        continue
      }
      const p = this.#pending.get(line.id)
      if (!p) continue
      this.#pending.delete(line.id)
      clearTimeout(p.timer)
      this.#crashes = 0
      p.resolve(line)
    }
    // A runaway line without an end is not something the helper sends.
    if (this.#buffer.length > 8 * 1024 * 1024) this.#buffer = ''
  }

  #touch(): void {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = setTimeout(() => {
      if (this.#pending.size === 0) this.#stop()
      else this.#touch()
    }, this.#opts.idleMs ?? IDLE_MS)
    this.#idle.unref?.()
  }

  #stop(): void {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = null
    const proc = this.#proc
    this.#proc = null
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(new HelperError('failed', 'The translation helper was stopped.'))
    }
    this.#pending.clear()
    try {
      proc?.stdin.end()
      proc?.kill()
    } catch {
      // Already gone.
    }
  }
}
