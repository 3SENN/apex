/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import { log } from '../log'

// The seam between the update machine and whatever fetches updates, so tests
// and smoke never touch the network. ElectronUpdaterBackend (electron-updater
// on GitHub Releases) is the real one; the fake is chosen when APEX_SMOKE=1
// and in tests.
//
// Failures always arrive as an 'error' event; check() and download() resolve
// either way, so the controller has one place that handles them.

export type UpdaterBackendEvents = {
  checking: []
  available: [{ version: string; size: number }]
  'not-available': []
  progress: [{ percent: number; bytesPerSecond: number }]
  downloaded: [{ version: string }]
  error: [Error]
}

export interface UpdaterBackend extends EventEmitter<UpdaterBackendEvents> {
  check(): Promise<void>
  download(): Promise<void>
  quitAndInstall(): void
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

// ── the fake ──

export interface FakeScript {
  /** What checks find; null is up to date. */
  available: { version: string; size: number } | null
  /** The next this many checks fail with `checkError`. */
  failChecks: number
  checkError: string
  /** The download fails with this message after its progress steps. */
  failDownload: string | null
  /** Progress ticks (percent) a download reports. */
  steps: number[]
  /** Holds a download after its last step until release(). */
  hold: boolean
  /** Holds a check after 'checking' until release(), so smoke can see the checking state. */
  holdCheck: boolean
}

const DEFAULT_SCRIPT: FakeScript = {
  available: null,
  failChecks: 0,
  checkError: 'net::ERR_INTERNET_DISCONNECTED',
  failDownload: null,
  steps: [12, 42, 77, 100],
  hold: false,
  holdCheck: false,
}

/** A scriptable backend: no network, and quitAndInstall never quits (smoke counts the calls). */
export class FakeUpdaterBackend extends EventEmitter<UpdaterBackendEvents> implements UpdaterBackend {
  script: FakeScript = { ...DEFAULT_SCRIPT, steps: [...DEFAULT_SCRIPT.steps] }
  checks = 0
  downloads = 0
  installs = 0
  #release: (() => void) | null = null

  configure(patch: Partial<FakeScript>): void {
    this.script = { ...this.script, ...patch }
  }

  /** Lets a held check or download finish. */
  release(): void {
    const go = this.#release
    this.#release = null
    go?.()
  }

  get holding(): boolean {
    return this.#release !== null
  }

  async check(): Promise<void> {
    this.checks++
    await Promise.resolve()
    this.emit('checking')
    if (this.script.holdCheck) await new Promise<void>((resolve) => (this.#release = resolve))
    await Promise.resolve()
    if (this.script.failChecks > 0) {
      this.script.failChecks--
      this.emit('error', new Error(this.script.checkError))
      return
    }
    if (this.script.available) this.emit('available', { ...this.script.available })
    else this.emit('not-available')
  }

  async download(): Promise<void> {
    this.downloads++
    const target = this.script.available
    if (!target) {
      this.emit('error', new Error('No update to download.'))
      return
    }
    for (const percent of this.script.steps) {
      await Promise.resolve()
      this.emit('progress', { percent, bytesPerSecond: 2_400_000 })
    }
    if (this.script.hold) await new Promise<void>((resolve) => (this.#release = resolve))
    await Promise.resolve()
    if (this.script.failDownload) this.emit('error', new Error(this.script.failDownload))
    else this.emit('downloaded', { version: target.version })
  }

  quitAndInstall(): void {
    // Smoke never quits for an update; the watchdog sees a "stuck" install.
    this.installs++
  }
}

// ── electron-updater ──

/** The largest file in the release: what this platform downloads, as a conservative size. */
export function updateSize(info: Pick<UpdateInfo, 'files'>): number {
  return Math.max(0, ...info.files.map((f) => (typeof f.size === 'number' ? f.size : 0)))
}

class ElectronUpdaterBackend extends EventEmitter<UpdaterBackendEvents> implements UpdaterBackend {
  readonly #updater: AppUpdater
  #errored = false

  constructor(updater: AppUpdater) {
    super()
    this.#updater = updater
    updater.on('checking-for-update', () => this.emit('checking'))
    updater.on('update-available', (info: UpdateInfo) => this.emit('available', { version: info.version, size: updateSize(info) }))
    updater.on('update-not-available', () => this.emit('not-available'))
    updater.on('download-progress', (p: ProgressInfo) => this.emit('progress', { percent: p.percent, bytesPerSecond: p.bytesPerSecond }))
    updater.on('update-downloaded', (info: UpdateInfo) => this.emit('downloaded', { version: info.version }))
    updater.on('error', (err: Error) => {
      this.#errored = true
      this.emit('error', asError(err))
    })
  }

  async check(): Promise<void> {
    await this.#run(() => this.#updater.checkForUpdates())
  }

  async download(): Promise<void> {
    await this.#run(() => this.#updater.downloadUpdate())
  }

  quitAndInstall(): void {
    // Not silent, and relaunch afterwards (Windows); macOS relaunches through Squirrel.
    this.#updater.quitAndInstall(false, true)
  }

  // electron-updater both emits 'error' and rejects; report each failure once.
  async #run(fn: () => Promise<unknown>): Promise<void> {
    this.#errored = false
    try {
      await fn()
    } catch (err) {
      if (!this.#errored) this.emit('error', asError(err))
    }
  }
}

/**
 * The real backend: electron-updater with GitHub Releases from the packaged
 * app-update.yml. It never downloads on its own (Apex asks first unless
 * autoDownloadUpdates is on), installs a ready update on quit, never
 * downgrades, and logs through Apex's redacting log.
 */
export async function createElectronUpdaterBackend(): Promise<UpdaterBackend> {
  // Loaded lazily so tests and unpackaged runs never load electron-updater.
  const { autoUpdater } = await import('electron-updater')
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    info: (m?: unknown) => log.info('updater', String(m)),
    warn: (m?: unknown) => log.warn('updater', String(m)),
    error: (m?: unknown) => log.error('updater', String(m)),
    debug: (m: string) => log.debug('updater', m),
  }
  return new ElectronUpdaterBackend(autoUpdater)
}
