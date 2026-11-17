/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  SpeechError,
  type HelperCommand,
  type HelperLine,
  type SpeechAssetState,
  type SpeechBeginOptions,
  type SpeechBroker,
  type SpeechPermissions,
  type SpeechSession,
  type SpeechSessionEvent,
  type SpeechStatus,
} from '@shared/speech'
import type { HelperProcess, SpawnHelper } from './helper'

// Stand-ins for the atelier-speech helper, for tests and ATELIER_SMOKE: no
// microphone, no prompts, no audio. Voice, meeting capture and the meetings
// library can run their tests over them without the real broker. Under
// ATELIER_SMOKE the app's broker runs over createSmokeSpeechHelper(): scripted
// levels, and a real one-second .m4a wherever a recording was asked for.

/**
 * One scripted reply: when a command named `on` arrives, print `lines` (each
 * after `delayMs`). A line's `session: '$session'` becomes the session id of
 * the last start or transcribe command. Unscripted commands get the defaults.
 */
export interface FakeLine {
  on: HelperCommand['cmd']
  /** The lines, or a function of the command and the current session id. */
  lines: HelperLine[] | ((cmd: HelperCommand, session: string) => HelperLine[])
  delayMs?: number
  /** Used once, then the next script entry (or the default) answers. */
  once?: boolean
}

export const FAKE_PERMISSIONS: SpeechPermissions = { microphone: 'granted', speech: 'granted', screen: 'granted' }

function defaults(cmd: HelperCommand, session: string): HelperLine[] {
  switch (cmd.cmd) {
    case 'hello':
      return [{ type: 'ready', version: 2 }]
    case 'permissions':
    case 'request':
      return [{ type: 'permissions', ...FAKE_PERMISSIONS }]
    case 'devices':
      return [{ type: 'devices', items: [{ id: 'fake-mic', name: 'Built-in Microphone', builtIn: true, isDefault: true }] }]
    case 'locales':
      return [{ type: 'locales', system: 'en-US', items: [{ id: 'en-US', name: 'English (US)', onDevice: true, engine: 'analyzer' }] }]
    case 'start':
      return [{ type: 'started', session, mode: cmd.mode, onDevice: true, systemAudio: cmd.mode === 'meeting', deviceId: cmd.deviceId, locale: cmd.locale, fallbackDevice: false, engine: 'analyzer' }]
    case 'prepare':
      // B:transcription engine: the language's model is already on this Mac.
      return [{ type: 'assets', locale: cmd.locale, state: 'installed', fraction: 1 }]
    case 'pause':
      return [{ type: 'paused', session }]
    case 'resume':
      return [{ type: 'resumed', session }]
    case 'stop':
      return [{ type: 'stopped', session, durationMs: 1000, audio: null }]
    case 'transcribe':
      return [
        { type: 'progress', session, fraction: 1 },
        { type: 'stopped', session, durationMs: 1000, audio: null },
      ]
    case 'authenticate':
      return [{ type: 'auth', id: cmd.id, result: 'ok' }]
    case 'frontmost':
      return [{ type: 'frontmost', pid: null, bundleId: null }]
    case 'activate':
      return []
    case 'watch-calls':
      // Nothing is on a call: an empty snapshot, as the helper sends when the watch starts.
      return cmd.apps ? [{ type: 'calls', supported: true, audio: [], apps: [] }] : []
    case 'recover':
      return [{ type: 'recovered', id: cmd.id, audio: null, durationMs: 0 }]
  }
}

class FakeHelperProcess extends EventEmitter implements HelperProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  /** Every command Atelier wrote, for assertions. */
  readonly commands: HelperCommand[] = []
  readonly #script: FakeLine[]
  #session = ''
  #killed = false

  constructor(script: FakeLine[]) {
    super()
    this.#script = [...script]
    this.stdin.setEncoding('utf8')
    let rest = ''
    this.stdin.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) {
        try {
          this.#handle(JSON.parse(line) as HelperCommand)
        } catch {
          this.#print({ type: 'error', code: 'invalid', message: 'Unreadable command.', fatal: false })
        }
      }
    })
    this.stdin.on('end', () => this.#exit(0))
  }

  kill(): boolean {
    this.#exit(null)
    return true
  }

  /** Prints a line unprompted, as the helper's observers do (lid, calls). */
  push(line: HelperLine): void {
    setImmediate(() => this.#print(line))
  }

  #handle(cmd: HelperCommand): void {
    this.commands.push(cmd)
    if (cmd.cmd === 'start' || cmd.cmd === 'transcribe') this.#session = cmd.session
    const at = this.#script.findIndex((s) => s.on === cmd.cmd)
    const entry = at >= 0 ? this.#script[at] : undefined
    if (entry?.once) this.#script.splice(at, 1)
    const lines = entry ? (typeof entry.lines === 'function' ? entry.lines(cmd, this.#session) : entry.lines) : defaults(cmd, this.#session)
    const delay = entry?.delayMs ?? 0
    lines.forEach((line, i) => {
      const out = 'session' in line && line.session === '$session' ? { ...line, session: this.#session } : line
      if (delay > 0) setTimeout(() => this.#print(out), delay * (i + 1))
      else setImmediate(() => this.#print(out))
    })
  }

  #print(line: HelperLine): void {
    if (!this.#killed) this.stdout.write(`${JSON.stringify(line)}\n`)
  }

  #exit(code: number | null): void {
    if (this.#killed) return
    this.#killed = true
    this.stdout.end()
    this.emit('exit', code)
  }
}

/**
 * The smoke run's permission report: the checklist's states are scripted
 * through it, and an Allow grants that kind, the way a first OS prompt would.
 * Starts all granted so the other smoke checks never see the checklist.
 */
export const smokeSpeechPermissions = {
  current: { ...FAKE_PERMISSIONS } as SpeechPermissions,
  set(p: Partial<SpeechPermissions>): void {
    this.current = { ...this.current, ...p }
  },
  reset(): void {
    this.current = { ...FAKE_PERMISSIONS }
  },
}

/**
 * B:transcription engine: the smoke run's language model. 'supported' makes
 * Settings offer to prepare it; preparing then reports progress and installs.
 */
export const smokeSpeechAssets = {
  state: 'installed' as SpeechAssetState,
  set(state: SpeechAssetState): void {
    this.state = state
  },
  reset(): void {
    this.state = 'installed'
  },
}

/**
 * The smoke run's running helper, for lines nothing asked for (desktop
 * calls' `calls` snapshots) and the commands Atelier sent it.
 */
export const smokeSpeechHelper = {
  process: null as FakeHelperProcess | null,
  push(line: HelperLine): void {
    this.process?.push(line)
  },
  commands(): HelperCommand[] {
    return this.process?.commands ?? []
  },
}

/**
 * The smoke run's helper: the v2 defaults, plus level lines after each start
 * that asks for levels, and on stop a real one-second .m4a at the path the
 * start asked to record to (never a microphone, never a prompt).
 */
export function createSmokeSpeechHelper(audio: () => Buffer): ReturnType<typeof createFakeSpeechHelper> {
  let recording: string | null = null
  const level = (session: string, source: 'mic' | 'system', i: number): HelperLine => ({ type: 'level', session, source, rms: 0.05 + 0.04 * (i % 4), peak: 0.2 + 0.1 * (i % 5) })
  const spawn = createFakeSpeechHelper([
    { on: 'permissions', lines: () => [{ type: 'permissions', ...smokeSpeechPermissions.current }] },
    {
      on: 'request',
      lines: (cmd) => {
        if (cmd.cmd === 'request') smokeSpeechPermissions.set({ [cmd.what]: 'granted' })
        return [{ type: 'permissions', ...smokeSpeechPermissions.current }]
      },
    },
    {
      on: 'start',
      lines: (cmd, session) => {
        if (cmd.cmd !== 'start') return []
        recording = cmd.record?.path ?? null
        const started: HelperLine = { type: 'started', session, mode: cmd.mode, onDevice: true, systemAudio: cmd.mode === 'meeting', deviceId: cmd.deviceId, locale: cmd.locale, fallbackDevice: false, engine: 'analyzer' }
        if (!cmd.levels) return [started]
        const sources: Array<'mic' | 'system'> = cmd.mode === 'meeting' ? ['mic', 'system'] : ['mic']
        return [started, ...Array.from({ length: 8 }, (_, i) => sources.map((source) => level(session, source, i))).flat()]
      },
      delayMs: 40,
    },
    {
      on: 'stop',
      lines: (_cmd, session) => {
        let out: { path: string; bytes: number } | null = null
        if (recording) {
          const bytes = audio()
          mkdirSync(dirname(recording), { recursive: true })
          writeFileSync(recording, bytes)
          out = { path: recording, bytes: bytes.length }
          recording = null
        }
        return [{ type: 'stopped', session, durationMs: 1000, audio: out }]
      },
    },
    {
      // A recording left in parts (a crash mid-meeting): put back together as the one-second .m4a.
      on: 'recover',
      lines: (cmd) => {
        if (cmd.cmd !== 'recover') return []
        const dir = dirname(cmd.path)
        const prefix = `.${basename(cmd.path)}.`
        let parts: string[] = []
        try {
          parts = readdirSync(dir).filter((name) => name.startsWith(prefix) && /\.part\.(aac|m4a)$/.test(name))
        } catch {
          parts = []
        }
        if (parts.length === 0) return [{ type: 'recovered', id: cmd.id, audio: null, durationMs: 0 }]
        const bytes = audio()
        writeFileSync(cmd.path, bytes)
        for (const name of parts) rmSync(join(dir, name), { force: true })
        return [{ type: 'recovered', id: cmd.id, audio: { path: cmd.path, bytes: bytes.length }, durationMs: 1000 }]
      },
    },
    {
      // B:transcription engine: an install reports progress, then the model is ready.
      on: 'prepare',
      lines: (cmd) => {
        if (cmd.cmd !== 'prepare') return []
        const line = (state: SpeechAssetState, fraction: number | null): HelperLine => ({ type: 'assets', locale: cmd.locale, state, fraction })
        if (cmd.install && smokeSpeechAssets.state === 'supported') {
          smokeSpeechAssets.set('installed')
          return [line('downloading', 0), line('downloading', 0.5), line('installed', 1)]
        }
        return [line(smokeSpeechAssets.state, smokeSpeechAssets.state === 'installed' ? 1 : null)]
      },
      delayMs: 150,
    },
  ])
  return Object.assign(
    (path: string) => {
      const child = spawn(path) as FakeHelperProcess
      smokeSpeechHelper.process = child
      return child
    },
    { last: () => spawn.last() },
  )
}

/** A SpawnHelper that answers with `script`, then the protocol v2 defaults. */
export function createFakeSpeechHelper(script: FakeLine[] = []): SpawnHelper & { last(): FakeHelperProcess | null } {
  let last: FakeHelperProcess | null = null
  const spawn: SpawnHelper = () => {
    last = new FakeHelperProcess(script)
    return last
  }
  return Object.assign(spawn, { last: () => last })
}

export interface FakeBroker extends SpeechBroker {
  /** Sends an event to the open session, as the helper would. */
  emit(event: SpeechSessionEvent): void
  /** Every session begun, newest last, with the options it was begun with. */
  readonly sessions: Array<SpeechSession & { stopped: boolean; cancelled: boolean; paused: boolean; options: SpeechBeginOptions }>
  setPermissions(p: SpeechPermissions): void
}

/**
 * An in-memory SpeechBroker for unit tests of the features that use speech:
 * one session at a time (a second begin rejects SpeechError('busy') naming
 * the holder), events pushed with emit.
 */
export function createFakeBroker(options: { stopResult?: { durationMs: number; audio: { path: string; bytes: number } | null } } = {}): FakeBroker {
  let permissions = FAKE_PERMISSIONS
  let active: (SpeechSession & { stopped: boolean; cancelled: boolean; paused: boolean; options: SpeechBeginOptions }) | null = null
  const listeners = new Map<string, Set<(e: SpeechSessionEvent) => void>>()
  const sessions: FakeBroker['sessions'] = []
  const status = (): SpeechStatus => ({ available: true, reason: null, active: active ? { id: active.id, purpose: active.purpose, mode: active.purpose === 'meeting' ? 'meeting' : 'dictation' } : null })
  const end = (s: SpeechSession): void => {
    if (active === s) active = null
  }
  return {
    status,
    begin: async (o) => {
      if (active) throw new SpeechError('busy', 'Another recording is running.', active.purpose)
      const id = randomUUID()
      const set = new Set<(e: SpeechSessionEvent) => void>()
      listeners.set(id, set)
      const session: SpeechSession & { stopped: boolean; cancelled: boolean; paused: boolean; options: SpeechBeginOptions } = {
        id,
        purpose: o.purpose,
        options: o,
        stopped: false,
        cancelled: false,
        paused: false,
        on: (fn) => {
          set.add(fn)
          return () => set.delete(fn)
        },
        stop: async () => {
          session.stopped = true
          end(session)
          return options.stopResult ?? { durationMs: 1000, audio: null }
        },
        pause: () => {
          session.paused = true
        },
        resume: () => {
          session.paused = false
        },
        cancel: () => {
          session.cancelled = true
          end(session)
        },
      }
      active = session
      sessions.push(session)
      return session
    },
    permissions: async () => permissions,
    request: async () => permissions,
    devices: async () => [{ id: 'fake-mic', name: 'Built-in Microphone', builtIn: true, isDefault: true }],
    locales: async () => ({ system: 'en-US', items: [{ id: 'en-US', name: 'English (US)', onDevice: true }] }),
    transcribeFile: async (_path, onEvent) => onEvent({ type: 'progress', fraction: 1 }),
    recoverRecording: async () => ({ audio: null, durationMs: 0 }),
    authenticate: async () => 'ok',
    frontmost: async () => null,
    activate: () => undefined,
    onLine: () => () => undefined,
    watchCalls: () => undefined,
    emit: (event) => {
      if (!active) return
      for (const fn of listeners.get(active.id) ?? []) fn(event)
    },
    sessions,
    setPermissions: (p) => {
      permissions = p
    },
  }
}
