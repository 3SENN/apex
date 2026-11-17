/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Running pack tools (docs/packs.md › Tools). Each pack with tools gets one
// hidden window in its own sandbox, loading Atelier's tool host page, which
// imports the pack's tool modules and serves calls through atelier.tools.serve.
// Calls to one pack run one at a time, so "the page" a call reads is always
// that call's; each times out after a minute, and an idle host closes after
// five. A host that crashes fails its calls and starts afresh on the next.
import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { PACK_IPC, PACK_LIMITS, PACK_TOOL_HOST_PATH, packUrl, type PackToolCallMessage, type PackToolResultMessage } from '@shared/packs'
import type { PackContext } from './bridge'
import type { PackMode, PackSandbox } from './sandbox'

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string }

interface Host {
  key: string
  ctx: PackContext
  win: BrowserWindow
  ready: Promise<void>
  markReady(): void
  failReady(err: Error): void
  queue: Promise<unknown>
  target: WebContents | null
  pending: Map<string, (outcome: ToolOutcome) => void>
  idle: ReturnType<typeof setTimeout> | null
  /** The page's latest console error, for a host that won't start. */
  lastError: string | null
}

export interface ToolHostDeps {
  sandbox: PackSandbox
  log(ctx: PackContext, line: { level: 'info' | 'warn' | 'error'; source: string; message: string }): void
  timeoutMs?: number
  idleMs?: number
  readyMs?: number
}

const keyOf = (packId: string, mode: PackMode): string => `${mode}:${packId}`

export class PackToolHost {
  readonly #deps: ToolHostDeps
  readonly #hosts = new Map<string, Host>()
  readonly #byContents = new Map<number, Host>()

  constructor(deps: ToolHostDeps) {
    this.#deps = deps
    ipcMain.on(PACK_IPC.toolReady, this.#onReady)
    ipcMain.on(PACK_IPC.toolResult, this.#onResult)
  }

  readonly #onReady = (event: IpcMainEvent): void => {
    const host = this.#byContents.get(event.sender.id)
    if (host && event.senderFrame === event.sender.mainFrame) host.markReady()
  }

  readonly #onResult = (event: IpcMainEvent, raw: unknown): void => {
    const host = this.#byContents.get(event.sender.id)
    if (!host || event.senderFrame !== event.sender.mainFrame || !raw || typeof raw !== 'object') return
    const message = raw as PackToolResultMessage
    const settle = typeof message.callId === 'string' ? host.pending.get(message.callId) : undefined
    if (!settle) return
    host.pending.delete(message.callId)
    settle(message.ok ? { ok: true, value: message.value } : { ok: false, error: typeof message.error === 'string' ? message.error.slice(0, 4_000) : 'The tool failed.' })
  }

  /** Whether a webContents is a pack's tool host. */
  isHost(contents: WebContents): boolean {
    return this.#byContents.has(contents.id)
  }

  /** The page the current call on this host acts on. */
  targetFor(contents: WebContents): WebContents | null {
    return this.#byContents.get(contents.id)?.target ?? null
  }

  #start(ctx: PackContext): Host {
    const key = keyOf(ctx.packId, ctx.mode)
    const existing = this.#hosts.get(key)
    if (existing && !existing.win.isDestroyed()) {
      existing.ctx = ctx
      return existing
    }
    const win = new BrowserWindow({ show: false, width: 480, height: 320, webPreferences: { ...this.#deps.sandbox.viewPreferences(ctx.packId, ctx.mode), offscreen: true } })
    this.#deps.sandbox.harden(win.webContents, ctx.packId)
    win.webContents.setAudioMuted(true)
    let markReady: () => void = () => undefined
    let failReady: (err: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failReady = reject
    })
    ready.catch(() => undefined)
    const host: Host = { key, ctx, win, ready, markReady, failReady, queue: Promise.resolve(), target: null, pending: new Map(), idle: null, lastError: null }
    const id = win.webContents.id
    this.#hosts.set(key, host)
    this.#byContents.set(id, host)
    const gone = (why: string): void => {
      failReady(new Error(why))
      for (const settle of host.pending.values()) settle({ ok: false, error: why })
      host.pending.clear()
      this.#forget(host)
    }
    win.webContents.on('render-process-gone', () => gone('The pack’s tool host stopped.'))
    win.webContents.on('did-fail-load', (_e, _code, description, _url, isMainFrame) => {
      if (isMainFrame) gone(`The pack’s tool host didn’t load: ${description}`)
    })
    win.webContents.on('console-message', (event) => {
      const level = event.level === 'error' ? 'error' : event.level === 'warning' ? 'warn' : null
      if (level === 'error') host.lastError = event.message.slice(0, 500)
      if (level) this.#deps.log(host.ctx, { level, source: 'tool', message: event.message })
    })
    win.on('closed', () => this.#forget(host))
    const timer = setTimeout(() => {
      const why = host.lastError ? ` The tool host said: ${host.lastError}` : ''
      failReady(new Error(`The pack’s tools didn’t start in time. Check that each tool module loads without errors.${why}`))
      this.#forget(host)
    }, this.#deps.readyMs ?? 10_000)
    void ready.then(() => clearTimeout(timer), () => clearTimeout(timer))
    void win.loadURL(packUrl(ctx.packId, PACK_TOOL_HOST_PATH)).catch((err: unknown) => gone(err instanceof Error ? err.message : String(err)))
    return host
  }

  #forget(host: Host): void {
    if (host.idle) clearTimeout(host.idle)
    if (this.#hosts.get(host.key) === host) this.#hosts.delete(host.key)
    for (const [id, h] of this.#byContents) if (h === host) this.#byContents.delete(id)
    if (!host.win.isDestroyed()) host.win.destroy()
  }

  #touch(host: Host): void {
    if (host.idle) clearTimeout(host.idle)
    host.idle = setTimeout(() => this.#forget(host), this.#deps.idleMs ?? PACK_LIMITS.toolIdleMs)
  }

  /** Runs one tool call; calls to the same pack queue behind each other. */
  call(ctx: PackContext, tool: string, input: unknown, options: { chatId: string | null; companionId: string | null; target: WebContents | null; signal?: AbortSignal; timeoutMs?: number }): Promise<ToolOutcome> {
    const host = this.#start(ctx)
    const run = async (): Promise<ToolOutcome> => {
      if (options.signal?.aborted) return { ok: false, error: 'Stopped.' }
      try {
        await host.ready
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (host.win.isDestroyed()) return { ok: false, error: 'The pack’s tool host stopped.' }
      host.target = options.target
      const callId = randomUUID()
      const started = Date.now()
      const outcome = await new Promise<ToolOutcome>((resolve) => {
        const limit = options.timeoutMs ?? this.#deps.timeoutMs ?? PACK_LIMITS.toolTimeoutMs
        const timer = setTimeout(() => finish({ ok: false, error: `The tool took longer than ${Math.round(limit / 1000)} seconds.` }), limit)
        const onAbort = (): void => finish({ ok: false, error: 'Stopped.' })
        function finish(o: ToolOutcome): void {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          host.pending.delete(callId)
          resolve(o)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        host.pending.set(callId, finish)
        const message: PackToolCallMessage = { callId, name: tool, input, ctx: { chatId: options.chatId, companionId: options.companionId, test: ctx.mode === 'test' } }
        host.win.webContents.send(PACK_IPC.toolCall, message)
      })
      host.target = null
      this.#deps.log(ctx, { level: outcome.ok ? 'info' : 'warn', source: `tool:${tool}`, message: outcome.ok ? `ok in ${Date.now() - started} ms` : `failed: ${outcome.error}` })
      this.#touch(host)
      return outcome
    }
    const next = host.queue.then(run, run)
    host.queue = next.catch(() => undefined)
    return next
  }

  /** Closes a pack's host (it changed, turned off or went away); the next call starts a fresh one. */
  reset(packId: string, mode?: PackMode): void {
    for (const host of [...this.#hosts.values()]) if (host.ctx.packId === packId && (!mode || host.ctx.mode === mode)) this.#forget(host)
  }

  dispose(): void {
    ipcMain.off(PACK_IPC.toolReady, this.#onReady)
    ipcMain.off(PACK_IPC.toolResult, this.#onResult)
    for (const host of [...this.#hosts.values()]) this.#forget(host)
  }
}
