/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app } from 'electron'
import { LAUNCH_AT_LOGIN_FLAG, UNSUPPORTED_LOGIN_ITEM, type LoginItemState, type OsPlatform } from '@shared/system'
import type { LinuxAutostart } from './autostartLinux'

// The login item (OV-09). The state is always read from the OS:
// macOS 13+ through SMAppService (`mainAppService`), Windows through the Run
// key, Linux through ~/.config/autostart (autostartLinux.ts). Smoke and
// unpackaged runs never register anything: smoke uses the fake, and a dev
// build would register the bare Electron binary.

/** What Electron's getLoginItemSettings reports, reduced to what the mapping reads. */
export interface RawLoginItem {
  openAtLogin: boolean
  /** macOS 13+: not-registered, enabled, requires-approval or not-found. */
  status?: string
  /** Windows: the Run key exists and is not switched off in Startup apps. */
  executableWillLaunchAtLogin?: boolean
  launchItems?: Array<{ enabled: boolean }>
}

/** The pure mapping from the OS's answer to Atelier's states. */
export function loginItemStateFrom(platform: OsPlatform, raw: RawLoginItem): LoginItemState {
  if (platform === 'darwin') {
    switch (raw.status) {
      case 'enabled':
        return { supported: true, openAtLogin: true, status: 'enabled' }
      // Asked for, but the person still has to allow it in System Settings.
      case 'requires-approval':
        return { supported: true, openAtLogin: true, status: 'requires-approval' }
      case 'not-found':
        return { supported: true, openAtLogin: false, status: 'not-found' }
      case 'not-registered':
        return { supported: true, openAtLogin: false, status: 'disabled' }
      // Before macOS 13 there is no status, only the flag.
      default:
        return { supported: true, openAtLogin: raw.openAtLogin, status: raw.openAtLogin ? 'enabled' : 'disabled' }
    }
  }
  if (platform === 'win32') {
    if (!raw.openAtLogin) return { supported: true, openAtLogin: false, status: 'disabled' }
    // The Run key is there but switched off in Task Manager or Startup apps.
    const switchedOff = raw.executableWillLaunchAtLogin === false || (raw.launchItems?.length ? raw.launchItems.every((i) => !i.enabled) : false)
    return { supported: true, openAtLogin: true, status: switchedOff ? 'requires-approval' : 'enabled' }
  }
  if (platform === 'linux') return { supported: true, openAtLogin: raw.openAtLogin, status: raw.openAtLogin ? 'enabled' : 'disabled' }
  return UNSUPPORTED_LOGIN_ITEM
}

export interface LoginItemBackend {
  read(): LoginItemState
  write(on: boolean): LoginItemState
  /** Whether this launch came from the login item. */
  openedAtLogin(): boolean
}

/** The real backend for one platform; only constructed for packaged builds outside smoke. */
export class ElectronLoginItem implements LoginItemBackend {
  readonly #platform: OsPlatform
  readonly #linux: LinuxAutostart | null
  readonly #argv: readonly string[]

  constructor(o: { platform: OsPlatform; linux: LinuxAutostart | null; argv: readonly string[] }) {
    this.#platform = o.platform
    this.#linux = o.linux
    this.#argv = o.argv
  }

  read(): LoginItemState {
    if (this.#platform === 'linux') {
      if (!this.#linux) return UNSUPPORTED_LOGIN_ITEM
      return loginItemStateFrom('linux', { openAtLogin: this.#linux.enabled() })
    }
    if (this.#platform !== 'darwin' && this.#platform !== 'win32') return UNSUPPORTED_LOGIN_ITEM
    return loginItemStateFrom(this.#platform, app.getLoginItemSettings(this.#options()))
  }

  write(on: boolean): LoginItemState {
    if (this.#platform === 'linux') {
      if (!this.#linux) return UNSUPPORTED_LOGIN_ITEM
      if (on) this.#linux.enable()
      else this.#linux.disable()
      return this.read()
    }
    if (this.#platform !== 'darwin' && this.#platform !== 'win32') return UNSUPPORTED_LOGIN_ITEM
    app.setLoginItemSettings({ ...this.#options(), openAtLogin: on })
    return this.read()
  }

  openedAtLogin(): boolean {
    if (this.#argv.includes(LAUNCH_AT_LOGIN_FLAG)) return true
    if (this.#platform !== 'darwin') return false
    try {
      return app.getLoginItemSettings(this.#options()).wasOpenedAtLogin
    } catch {
      return false
    }
  }

  // Windows reads the Run key only with the same arguments it was written with.
  #options(): { type?: 'mainAppService'; args?: string[] } {
    return this.#platform === 'darwin' ? { type: 'mainAppService' } : { args: [LAUNCH_AT_LOGIN_FLAG] }
  }
}

/** Smoke's login item: in memory, and never touches the OS. A seeded status sticks until the next write. */
export class FakeLoginItem implements LoginItemBackend {
  #state: LoginItemState = { supported: true, openAtLogin: false, status: 'disabled' }
  #next: LoginItemState | null = null

  read(): LoginItemState {
    return { ...this.#state }
  }

  write(on: boolean): LoginItemState {
    this.#state = this.#next ?? { supported: true, openAtLogin: on, status: on ? 'enabled' : 'disabled' }
    this.#next = null
    return this.read()
  }

  openedAtLogin(): boolean {
    return false
  }

  /** The state now, or (with `onNextWrite`) the answer to the next write, e.g. requires-approval. */
  seed(state: LoginItemState, onNextWrite = false): void {
    if (onNextWrite) this.#next = { ...state }
    else this.#state = { ...state }
  }
}

/** Unpackaged runs: the row explains it works once Atelier is installed. */
export const unpackagedLoginItem: LoginItemBackend = {
  read: () => UNSUPPORTED_LOGIN_ITEM,
  write: () => UNSUPPORTED_LOGIN_ITEM,
  openedAtLogin: () => process.argv.includes(LAUNCH_AT_LOGIN_FLAG),
}
