/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { killTree, spawnProgram } from '../system/programs'
import { readDefaultValue } from '../system/registry'

// Native messaging: Chrome's protocol between an extension and a
// helper app. Each message is UTF-8 JSON behind a 4-byte little-endian
// length (bytes, not characters: the library this replaces got that wrong).
// A host's messages are capped at 1 MB, as in Chrome; the extension's own at
// Chrome's 64 MB message limit. A host lives exactly as long as its port.
// Hosts are found in Apex's own NativeMessagingHosts folder first, then
// (read-only) in Chrome's: its folders, or on Windows its registry keys.
// They start the way Chrome starts them: the caller's origin and
// --parent-window as arguments, the host's own folder as the working
// directory, and the browser's environment without Electron's own switches.
// Elsewhere that is without a shell; on Windows, as Chrome does there, a
// host that isn't a program (a .bat, a script) runs through cmd.exe.

/** The largest message a host may send (Chrome's kMaxMessageDataLength). */
export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024
/** The largest message an extension may send to a host (Chrome's extension message limit). */
export const NATIVE_MESSAGE_OUT_MAX_BYTES = 64 * 1024 * 1024
export const HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/

/** Frames one message. Throws when it isn't JSON-serializable or is over the cap. */
export function encodeMessage(message: unknown, max = NATIVE_MESSAGE_OUT_MAX_BYTES): Buffer {
  const json = JSON.stringify(message)
  if (json === undefined) throw new Error('The message must be JSON.')
  const body = Buffer.from(json, 'utf8')
  if (body.length > max) throw new Error(max === NATIVE_MESSAGE_MAX_BYTES ? 'The message is larger than 1 MB.' : 'The message is larger than 64 MB.')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/** Reassembles frames from a byte stream: chunks may split or join messages anywhere. */
export class FrameDecoder {
  #pending: Buffer = Buffer.alloc(0)

  /** Feeds bytes; returns every complete message. Throws on an oversized frame or bad JSON (the port then closes). */
  push(chunk: Buffer): unknown[] {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk
    const out: unknown[] = []
    while (this.#pending.length >= 4) {
      const size = this.#pending.readUInt32LE(0)
      if (size > NATIVE_MESSAGE_MAX_BYTES) throw new Error('The native app sent a message larger than 1 MB.')
      if (this.#pending.length < 4 + size) break
      const body = this.#pending.subarray(4, 4 + size)
      this.#pending = this.#pending.subarray(4 + size)
      try {
        out.push(JSON.parse(body.toString('utf8')))
      } catch {
        throw new Error('The native app sent a message that isn’t JSON.')
      }
    }
    return out
  }
}

/** The caller's origin, exactly as Chrome writes it: chrome-extension://<id>/ */
export function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}/`
}

/**
 * The arguments Chrome starts a host with: the caller's origin first, then
 * --parent-window (the calling window's handle on Windows; 0 elsewhere,
 * where Chrome has no handle to give).
 */
export function hostArgs(extensionId: string, platform: string = process.platform, windowHandle = 0): string[] {
  return [extensionOrigin(extensionId), `--parent-window=${platform === 'win32' ? windowHandle : 0}`]
}

/** Variables that belong to Electron or Node's own startup; a host started by Chrome never sees them. */
const ELECTRON_ONLY = /^(ELECTRON_|NODE_OPTIONS$|NODE_CHANNEL_FD$|NODE_UNIQUE_ID$|CHROME_CRASHPAD_PIPE_NAME$|ORIGINAL_XDG_CURRENT_DESKTOP$)/

/** The browser's environment for a host, without Electron's switches (ELECTRON_RUN_AS_NODE would turn an Electron-based host into plain Node). */
export function hostEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !ELECTRON_ONLY.test(k)) out[k] = v
  return out
}

/**
 * Whether a manifest's allowed_origins entry admits this extension. Chrome
 * reads each entry as a chrome-extension:// URL pattern with an exact id
 * (wildcard ids are refused); the path may be "/" or "/*".
 */
export function originAllowed(entry: unknown, extensionId: string): boolean {
  if (typeof entry !== 'string') return false
  const m = /^chrome-extension:\/\/([a-p]{32})(\/\*?)?$/i.exec(entry.trim())
  return !!m && m[1]?.toLowerCase() === extensionId
}

export interface HostManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

/** Chrome's host registrations on Windows, read-only, per user first and then for the machine. */
export const CHROME_HOST_KEYS = ['HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts', 'HKEY_LOCAL_MACHINE\\Software\\Google\\Chrome\\NativeMessagingHosts']

const REGISTRY_KEY = /^HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\/

/**
 * Where host manifests live, in the order they are read: Apex's own folder,
 * then Chrome's (read-only lookup). On Windows Chrome's are registry
 * keys, each naming a manifest file in a subkey per host.
 */
export function hostDirs(userData: string, platform: string = process.platform, home: string = homedir()): string[] {
  const own = join(userData, 'NativeMessagingHosts')
  if (platform === 'darwin') {
    return [own, join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'), '/Library/Google/Chrome/NativeMessagingHosts']
  }
  if (platform === 'linux') return [own, join(home, '.config/google-chrome/NativeMessagingHosts'), '/etc/opt/chrome/native-messaging-hosts']
  if (platform === 'win32') return [own, ...CHROME_HOST_KEYS]
  return [own]
}

/** A registry key's default value (system/registry.ts); tests pass their own. */
export type RegistryRead = (key: string) => string | null

/** The manifest files to try for a host, in order: <name>.json in each folder, and the file each registry key's <name> subkey names. */
export function manifestCandidates(name: string, sources: readonly string[], readRegistry: RegistryRead = readDefaultValue): string[] {
  const out: string[] = []
  for (const source of sources) {
    if (!REGISTRY_KEY.test(source)) out.push(join(source, `${name}.json`))
    else if (HOST_NAME.test(name)) {
      const file = readRegistry(`${source}\\${name}`)
      if (file) out.push(file)
    }
  }
  return out
}

/** The host a manifest names: an absolute path, or on Windows (as Chrome allows there) one relative to the manifest's folder. */
export function manifestHostPath(manifestFile: string, path: unknown, platform: string = process.platform): string | null {
  if (typeof path !== 'string' || !path) return null
  if (isAbsolute(path)) return path
  return platform === 'win32' ? join(dirname(manifestFile), path) : null
}

/**
 * Finds and checks a host's manifest: the name must match, it must be a
 * stdio host whose path is absolute (or, on Windows, relative to the
 * manifest), and it must list this extension's origin. Returns a plain
 * reason when it can't be used.
 */
export function findHost(name: string, extensionId: string, dirs: readonly string[], readRegistry?: RegistryRead): { ok: true; host: HostManifest } | { ok: false; reason: string } {
  if (!HOST_NAME.test(name)) return { ok: false, reason: 'Invalid native host name.' }
  for (const file of manifestCandidates(name, dirs, readRegistry)) {
    if (!existsSync(file)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return { ok: false, reason: 'The native host’s manifest is damaged.' }
    }
    const m = raw as Partial<HostManifest>
    const path = manifestHostPath(file, m.path)
    if (m.name !== name || m.type !== 'stdio' || !path) return { ok: false, reason: 'The native host’s manifest is invalid.' }
    const origins = Array.isArray(m.allowed_origins) ? m.allowed_origins : []
    if (!origins.some((o) => originAllowed(o, extensionId))) return { ok: false, reason: 'Access to the specified native messaging host is forbidden.' }
    if (!existsSync(path)) return { ok: false, reason: 'The native host isn’t installed where its manifest says.' }
    return { ok: true, host: { name, description: typeof m.description === 'string' ? m.description : '', path, type: 'stdio', allowed_origins: origins } }
  }
  return { ok: false, reason: 'Specified native messaging host not found.' }
}

export interface NativePortEvents {
  message: [message: unknown]
  /** Fires once; `error` is null when the extension closed it. */
  disconnect: [error: string | null]
}

/** How a host process ended on its own: what the Apple Passwords card reads a refused launch from (shared/applePasswords.ts). */
export interface NativeExit {
  code: number | null
  signal: string | null
  /** From spawn to exit. */
  ms: number
  /** It wrote anything at all, to stdout or stderr. */
  output: boolean
}

/** One connection to a host process. Closing the port ends the process. */
export class NativePort extends EventEmitter<NativePortEvents> {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #decoder = new FrameDecoder()
  readonly #started = Date.now()
  #output = false
  #exit: NativeExit | null = null
  #closed = false

  constructor(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    super()
    // The manifest's path runs as-is, from its own folder, as Chrome runs it (NativeProcessLauncher):
    // no shell, except cmd.exe on Windows for a host that isn't a program.
    this.#child = spawnProgram(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd ?? dirname(command), env: opts.env ?? hostEnv() }, { openAny: true }) as ChildProcessWithoutNullStreams
    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#output = true
      if (this.#closed) return
      try {
        for (const message of this.#decoder.push(chunk)) this.emit('message', message)
      } catch (err) {
        this.#finish(err instanceof Error ? err.message : String(err))
      }
    })
    // A host's stderr is its log; it never reaches the extension.
    this.#child.stderr.on('data', () => {
      this.#output = true
    })
    this.#child.on('error', (err) => this.#finish(`Could not start the native host: ${err.message}`))
    // 'close' (not 'exit'): it fires after stdout has delivered everything, so a host's last reply still arrives.
    this.#child.on('close', (code, signal) => {
      if (!this.#closed) this.#exit = { code, signal, ms: Date.now() - this.#started, output: this.#output }
      this.#finish('Native host has exited.')
    })
    this.#child.stdin.on('error', () => this.#finish('Native host has exited.'))
  }

  get closed(): boolean {
    return this.#closed
  }

  /** How the host ended by itself; null while it runs, or when Apex ended it. */
  get exit(): NativeExit | null {
    return this.#exit
  }

  postMessage(message: unknown): void {
    if (this.#closed) throw new Error('The port is closed.')
    this.#child.stdin.write(encodeMessage(message))
  }

  disconnect(): void {
    this.#finish(null)
  }

  #finish(error: string | null): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#child.stdin.end()
    } catch {
      // Already closed.
    }
    if (this.#child.exitCode === null) {
      // On Windows SIGTERM is already a hard stop: a host there gets the grace period
      // with its stdin closed, then its tree goes (cmd.exe's child with it).
      const windows = process.platform === 'win32'
      if (!windows) this.#child.kill('SIGTERM')
      // A host that ignores SIGTERM is stopped for good shortly after.
      const timer = setTimeout(() => {
        if (this.#child.exitCode !== null) return
        if (windows) killTree(this.#child)
        else this.#child.kill('SIGKILL')
      }, 2000)
      timer.unref()
    }
    this.emit('disconnect', error)
    this.removeAllListeners('message')
  }
}

/** chrome.runtime.sendNativeMessage: one message out, the first reply back, then the host ends. */
export function sendOnce(command: string, args: string[], message: unknown, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const port = new NativePort(command, args)
    let settled = false
    const timer = setTimeout(() => done(() => reject(new Error('The native host didn’t answer.'))), timeoutMs)
    timer.unref()
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      port.disconnect()
      fn()
    }
    port.on('message', (reply) => done(() => resolve(reply)))
    port.on('disconnect', (error) => done(() => reject(new Error(error ?? 'Native host has exited.'))))
    try {
      port.postMessage(message)
    } catch (err) {
      done(() => reject(err instanceof Error ? err : new Error(String(err))))
    }
  })
}
