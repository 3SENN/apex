/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { SpeechError, type HelperCommand, type HelperLine } from '@shared/speech'
import { encodeCommand, helperVersionOk, parseHelperLine } from './protocol'

// Runs the native atelier-speech helper (protocol v2) and turns its JSON
// lines into parsed events. The helper starts on first use with a version
// handshake: an old binary is reported as outdated and never used. A helper
// that dies is started again once, on the spot; one that keeps dying is left
// alone for a few seconds. Ending its stdin makes it stop cleanly.

/** One helper line as a v2 line, or null (kept under its original name). */
export const parseSpeechLine = parseHelperLine

/** Splits a byte stream into complete lines, keeping the unfinished tail. */
export class LineSplitter {
  #rest = ''

  push(chunk: string): string[] {
    const lines = (this.#rest + chunk).split('\n')
    this.#rest = lines.pop() ?? ''
    return lines.map((l) => l.trim()).filter(Boolean)
  }
}

/** Where the helper lives: next to the app when packaged, in the build folder in development. */
export function speechHelperPath(opts: { platform: NodeJS.Platform; packaged: boolean; resourcesPath: string; appPath: string }): string | null {
  // Native/speech-win; built in CI on Windows only
  if (opts.platform === 'win32') return opts.packaged ? join(opts.resourcesPath, 'atelier-speech.exe') : join(opts.appPath, 'native', 'speech-win', 'build', 'atelier-speech.exe')
  if (opts.platform !== 'darwin') return null
  return opts.packaged ? join(opts.resourcesPath, 'atelier-speech') : join(opts.appPath, 'native', 'speech', 'build', 'atelier-speech')
}

/** The parts of a child process the link uses, so tests can fake it. */
export interface HelperProcess {
  stdin: Writable
  stdout: Readable
  kill(): boolean
  once(event: 'exit', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnHelper = (path: string) => HelperProcess

// windowsHide: atelier-speech.exe is a console program, which would otherwise open a window of its own.
export const spawnHelper: SpawnHelper = (path) => spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })

export type LinkState = 'idle' | 'starting' | 'ready' | 'missing' | 'outdated'

export interface HelperLinkOptions {
  /** The binary; null or a missing file makes the link 'missing'. */
  path: string | null
  spawn?: SpawnHelper
  /** Skips the file check (the fake helper has no file). */
  assumeExists?: boolean
  /** How long the helper has to answer `hello`. */
  handshakeMs?: number
  /** After a failed start, how long before trying again. */
  retryAfterMs?: number
  now?: () => number
}

interface Waiter {
  pick(line: HelperLine): boolean
  resolve(line: HelperLine): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class HelperLink extends EventEmitter<{ line: [HelperLine]; exit: [code: number | null, expected: boolean]; state: [LinkState] }> {
  readonly #path: string | null
  readonly #spawn: SpawnHelper
  readonly #handshakeMs: number
  readonly #retryAfterMs: number
  readonly #now: () => number
  #child: HelperProcess | null = null
  #state: LinkState
  #starting: Promise<void> | null = null
  #failedUntil = 0
  #waiters = new Set<Waiter>()
  #disposed = false
  /** Whether the last exit was one we asked for. */
  #ending = false

  constructor(options: HelperLinkOptions) {
    super()
    this.#path = options.path && (options.assumeExists || existsSync(options.path)) ? options.path : null
    this.#spawn = options.spawn ?? spawnHelper
    this.#handshakeMs = options.handshakeMs ?? 5_000
    this.#retryAfterMs = options.retryAfterMs ?? 5_000
    this.#now = options.now ?? Date.now
    this.#state = this.#path ? 'idle' : 'missing'
  }

  get state(): LinkState {
    return this.#state
  }

  /** Whether a helper process is up and answered the handshake. */
  get running(): boolean {
    return this.#state === 'ready' && this.#child !== null
  }

  /** Starts the helper if needed. Rejects SpeechError('helper-missing' | 'helper-outdated' | 'helper-failed'). */
  ensure(): Promise<void> {
    if (this.#disposed) return Promise.reject(new SpeechError('helper-failed', 'The speech helper has shut down.'))
    if (this.#state === 'missing') return Promise.reject(new SpeechError('helper-missing', 'The speech helper is not installed.'))
    if (this.#state === 'outdated') return Promise.reject(new SpeechError('helper-outdated', 'The speech helper is out of date.'))
    if (this.running) return Promise.resolve()
    if (this.#starting) return this.#starting
    if (this.#now() < this.#failedUntil) return Promise.reject(new SpeechError('helper-failed', 'The speech helper failed to start.'))
    this.#starting = this.#start().finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  /** Writes one command; the helper must be running. */
  send(cmd: HelperCommand): void {
    if (!this.#child) throw new SpeechError('helper-failed', 'The speech helper is not running.')
    this.#child.stdin.write(encodeCommand(cmd))
  }

  /** Starts the helper if needed, sends `cmd` and resolves with the first line `pick` accepts. */
  async request<T extends HelperLine>(cmd: HelperCommand, pick: (line: HelperLine) => line is T, timeoutMs: number): Promise<T> {
    await this.ensure()
    const reply = this.waitFor(pick, timeoutMs)
    this.send(cmd)
    return reply
  }

  /** Resolves with the next line `pick` accepts; rejects on timeout or when the helper exits. */
  waitFor<T extends HelperLine>(pick: (line: HelperLine) => line is T, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        pick,
        resolve: (line) => resolve(line as T),
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter)
          reject(new SpeechError('helper-failed', 'The speech helper did not answer.'))
        }, timeoutMs),
      }
      waiter.timer.unref?.()
      this.#waiters.add(waiter)
    })
  }

  /** Ends the running helper; the next ensure() starts a fresh one (macOS reads some grants only at launch). */
  recycle(): void {
    const child = this.#child
    if (!child) return
    this.#ending = true
    this.#detach(child)
    child.stdin.end()
    setTimeout(() => child.kill(), 2_000).unref()
  }

  dispose(): void {
    this.#disposed = true
    this.recycle()
  }

  async #start(): Promise<void> {
    const path = this.#path
    if (!path) throw new SpeechError('helper-missing', 'The speech helper is not installed.')
    this.#setState('starting')
    let child: HelperProcess
    try {
      child = this.#spawn(path)
    } catch {
      this.#fail()
      throw new SpeechError('helper-failed', 'The speech helper could not be started.')
    }
    this.#attach(child)
    try {
      const ready = await this.waitFor((l): l is Extract<HelperLine, { type: 'ready' }> => l.type === 'ready', this.#handshakeMs).catch((err: unknown) => {
        throw err instanceof SpeechError ? err : new SpeechError('helper-failed', String(err))
      })
      // A v1 helper also says `ready` (at launch, with no version): never use it.
      if (!helperVersionOk(ready.version)) {
        this.#ending = true
        this.#detach(child)
        child.stdin.end()
        child.kill()
        this.#setState('outdated')
        throw new SpeechError('helper-outdated', 'The speech helper is out of date.')
      }
      this.#setState('ready')
    } catch (err) {
      if (this.#state !== 'outdated') {
        this.#detach(child)
        child.kill()
        this.#fail()
      }
      throw err
    }
  }

  #attach(child: HelperProcess): void {
    this.#child = child
    this.#ending = false
    const lines = new LineSplitter()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.#child !== child) return
      for (const raw of lines.push(chunk)) {
        const line = parseHelperLine(raw)
        if (line) this.#deliver(line)
      }
    })
    // A broken pipe surfaces as the exit below.
    child.stdin.on('error', () => {})
    child.once('error', () => {
      if (this.#child === child) this.#lost(child, null)
    })
    child.once('exit', (code) => {
      if (this.#child === child) this.#lost(child, code)
    })
    try {
      child.stdin.write(encodeCommand({ cmd: 'hello' }))
    } catch {
      // The exit or error above reports it.
    }
  }

  #detach(child: HelperProcess): void {
    if (this.#child !== child) return
    this.#child = null
    if (this.#state === 'ready' || this.#state === 'starting') this.#setState('idle')
  }

  #lost(child: HelperProcess, code: number | null): void {
    const expected = this.#ending
    this.#detach(child)
    for (const waiter of [...this.#waiters]) {
      clearTimeout(waiter.timer)
      this.#waiters.delete(waiter)
      waiter.reject(new SpeechError('helper-failed', 'The speech helper stopped.'))
    }
    this.emit('exit', code, expected)
    // A crash gets one immediate restart, so the next request finds it ready.
    if (!expected && !this.#disposed && this.#state === 'idle' && !this.#starting) void this.ensure().catch(() => undefined)
  }

  #deliver(line: HelperLine): void {
    for (const waiter of [...this.#waiters]) {
      if (!waiter.pick(line)) continue
      clearTimeout(waiter.timer)
      this.#waiters.delete(waiter)
      waiter.resolve(line)
    }
    this.emit('line', line)
  }

  #fail(): void {
    this.#failedUntil = this.#now() + this.#retryAfterMs
    if (this.#state === 'starting') this.#setState('idle')
  }

  #setState(state: LinkState): void {
    if (state === this.#state) return
    this.#state = state
    this.emit('state', state)
  }
}
