/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { UNLOCK_MS } from '@shared/passwords'
import type { Authenticator } from '../features/personalRuntime'

// The authenticator and the Passwords page's unlock window.
// Platform calls are injected so the fallbacks can be tested without a Mac.

export type AuthResult = 'ok' | 'cancelled' | 'unavailable'

export interface AuthDeps {
  platform: NodeJS.Platform
  /** ATELIER_SMOKE: every prompt says yes, and nothing real is shown. */
  smoke: boolean
  /** systemPreferences.canPromptTouchID / promptTouchID on macOS. */
  touchId?: { can(): boolean; prompt(reason: string): Promise<void> }
  /** The speech helper's device-owner check (Touch ID or the login password). */
  helper?: { authenticate(reason: string): Promise<AuthResult> }
  /** Off macOS: an Atelier confirm dialog. Resolves true for Continue; rejects when no window can show it. */
  confirm?(reason: string): Promise<boolean>
}

/** macOS reports a cancelled Touch ID sheet with an error whose message says so. */
function isCancel(err: unknown): boolean {
  return /cancel/i.test(err instanceof Error ? err.message : String(err))
}

/**
 * Touch ID when the Mac can prompt for it, then the helper's device-owner
 * check, then, on other platforms, an Atelier confirm dialog. 'ok' in smoke.
 * Prompts never stack: a second request while one is showing shares it.
 */
export function createAuthenticator(deps: AuthDeps): Authenticator {
  let pending: Promise<AuthResult> | null = null

  async function run(reason: string): Promise<AuthResult> {
    if (deps.smoke) return 'ok'
    if (deps.platform === 'darwin') {
      if (deps.touchId?.can()) {
        try {
          await deps.touchId.prompt(reason)
          return 'ok'
        } catch (err) {
          // A cancel is an answer; anything else (lockout, no enrolled finger) falls through to the password check.
          if (isCancel(err)) return 'cancelled'
        }
      }
      const result = await deps.helper?.authenticate(reason).catch((): AuthResult => 'unavailable')
      return result ?? 'unavailable'
    }
    const helper = await deps.helper?.authenticate(reason).catch((): AuthResult => 'unavailable')
    if (helper && helper !== 'unavailable') return helper
    if (!deps.confirm) return 'unavailable'
    try {
      return (await deps.confirm(reason)) ? 'ok' : 'cancelled'
    } catch {
      return 'unavailable'
    }
  }

  return {
    authenticate(reason: string): Promise<AuthResult> {
      pending ??= run(reason).finally(() => {
        pending = null
      })
      return pending
    },
  }
}

/**
 * How long the Passwords page stays open after you confirm it's you: five
 * minutes, then it locks itself. Lock-screen, suspend and quit lock it at once.
 */
export class UnlockWindow {
  #until: number | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  readonly #duration: number
  readonly #now: () => number
  readonly #onChange: (locked: boolean) => void

  constructor(onChange: (locked: boolean) => void, duration = UNLOCK_MS, now: () => number = Date.now) {
    this.#onChange = onChange
    this.#duration = duration
    this.#now = now
  }

  /** When it locks again, or null while locked. */
  until(): number | null {
    if (this.#until !== null && this.#now() >= this.#until) this.#expire()
    return this.#until
  }

  isUnlocked(): boolean {
    return this.until() !== null
  }

  open(): void {
    this.#until = this.#now() + this.#duration
    this.#arm()
    this.#onChange(false)
  }

  lock(): void {
    const was = this.#until !== null
    this.#clear()
    this.#until = null
    if (was) this.#onChange(true)
  }

  dispose(): void {
    this.#clear()
    this.#until = null
  }

  #arm(): void {
    this.#clear()
    this.#timer = setTimeout(() => this.#expire(), Math.max(0, (this.#until ?? 0) - this.#now()))
    // A pending relock never keeps the app alive on its own.
    this.#timer.unref?.()
  }

  #expire(): void {
    if (this.#until === null) return
    this.#clear()
    this.#until = null
    this.#onChange(true)
  }

  #clear(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}
