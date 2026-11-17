/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ScreenAccess } from '@shared/speech'
import { log } from '../log'

// Screen Recording on macOS. CGPreflightScreenCaptureAccess only says granted
// or not, so a first use would read as "denied" before macOS ever asked.
// Main remembers whether Atelier has asked (userData/speech/screen-access.json,
// not the renderer's storage), so the first use in context asks instead.
// A grant made in System Settings since launch shows up in a fresh helper
// first; this process (screenshots, sharing windows) sees it only after a
// relaunch, which is what 'relaunch' says.

/** Whether Atelier has asked macOS for Screen Recording, kept across launches. */
export interface ScreenPrompt {
  asked(): boolean
  markAsked(): void
  /** Back to never asked (the smoke run's fresh setup). */
  forget(): void
}

/** `path` null keeps it in memory (tests). */
export function screenPromptFile(path: string | null): ScreenPrompt {
  let asked = false
  if (path) {
    try {
      asked = (JSON.parse(readFileSync(path, 'utf8')) as { asked?: unknown } | null)?.asked === true
    } catch {
      // No file yet, or an unreadable one: never asked.
    }
  }
  const write = (): void => {
    if (!path) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.tmp`
      writeFileSync(temp, JSON.stringify({ asked, at: Date.now() }), { mode: 0o600 })
      renameSync(temp, path)
    } catch (err) {
      log.warn('speech', 'could not save the Screen Recording prompt state', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return {
    asked: () => asked,
    markAsked: () => {
      if (asked) return
      asked = true
      write()
    },
    forget: () => {
      asked = false
      write()
    },
  }
}

/**
 * The state from what each side sees. Pure. `main` is this process's own
 * check; `helper` a fresh helper's (null when there is no helper to ask).
 */
export function screenAccessFrom(o: { platform: NodeJS.Platform; main: boolean; helper: 'granted' | 'denied' | null; asked: boolean }): ScreenAccess {
  if (o.platform !== 'darwin') return 'unsupported'
  if (o.main) return 'granted'
  // The helper restarts to read a new grant; this process only reads it at launch.
  if (o.helper === 'granted') return 'relaunch'
  return o.asked ? 'denied' : 'not-determined'
}

export interface ScreenAccessHost {
  status(): Promise<ScreenAccess>
  /** Asks macOS (its prompt shows only the first time), then the new state. Never opens System Settings. */
  request(): Promise<ScreenAccess>
  /** Quits and reopens Atelier, so a grant made since launch takes effect. */
  relaunch(): void
  /** Back to never asked (the smoke run's fresh setup). */
  forgetAsked(): void
}

export interface ScreenAccessDeps {
  platform: NodeJS.Platform
  /** This process's own check (systemPreferences), which never prompts. */
  mainGranted(): boolean
  /** A fresh helper's report, or null without one. */
  helperScreen(): Promise<'granted' | 'denied' | null>
  /** Asks through the helper (CGRequestScreenCaptureAccess) and returns its report, or null without one. */
  requestScreen(): Promise<'granted' | 'denied' | null>
  prompt: ScreenPrompt
  relaunch(): void
}

export function createScreenAccess(deps: ScreenAccessDeps): ScreenAccessHost {
  const from = (helper: 'granted' | 'denied' | null): ScreenAccess =>
    screenAccessFrom({ platform: deps.platform, main: deps.mainGranted(), helper, asked: deps.prompt.asked() })
  return {
    status: async () => {
      if (deps.platform !== 'darwin' || deps.mainGranted()) return from(null)
      return from(await deps.helperScreen().catch(() => null))
    },
    request: async () => {
      if (deps.platform !== 'darwin' || deps.mainGranted()) return from(null)
      deps.prompt.markAsked()
      // The reply as it stands: no fresh helper now, so nothing restarts under the prompt.
      return from(await deps.requestScreen().catch(() => null))
    },
    relaunch: () => deps.relaunch(),
    forgetAsked: () => deps.prompt.forget(),
  }
}

// The speech feature sets the host up; screen sharing and voice read it here.
let host: ScreenAccessHost | null = null

export function setScreenAccess(next: ScreenAccessHost | null): void {
  host = next
}

/** Before the speech feature is up (or in tests) nothing can ask, so it reads as off. */
const NONE: ScreenAccessHost = {
  status: async () => (process.platform === 'darwin' ? 'denied' : 'unsupported'),
  request: async () => (process.platform === 'darwin' ? 'denied' : 'unsupported'),
  relaunch: () => undefined,
  forgetAsked: () => undefined,
}

export function screenAccess(): ScreenAccessHost {
  return host ?? NONE
}
