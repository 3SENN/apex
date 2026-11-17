/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HapticKind } from '@shared/haptics'
import type { HapticPattern, HapticsAddon, HapticsStubReason } from '../../../native/haptics'
import { errorMessage, log } from '../log'

// Trackpad haptics (SH-41): loads native/haptics' atelier_haptics.node
// with process.dlopen (macOS only), rate-limits to one tick per 80 ms and
// honours settings.haptics. Anywhere the addon can't load it is a no-op, so
// callers never branch. The loader mirrors native/haptics/index.js, which
// can't be bundled into main (it is CommonJS outside node_modules).

export const HAPTIC_MIN_INTERVAL_MS = 80
export const HAPTICS_BINARY = 'atelier_haptics.node'

// The service spells AppKit's levelChange in kebab case.
const PATTERN: Record<HapticKind, HapticPattern> = { alignment: 'alignment', 'level-change': 'levelChange', generic: 'generic' }

export type HapticsLoad = { addon: HapticsAddon; path: string } | { addon: null; reason: HapticsStubReason; error?: string }

/** Packaged: the release ships it unpacked at Resources/native. Dev: scripts/build-native.mjs's output. */
export function hapticsAddonPaths(o: { packaged: boolean; resourcesPath: string; appPath: string }): string[] {
  return o.packaged ? [join(o.resourcesPath, 'native', HAPTICS_BINARY)] : [join(o.appPath, 'native', 'haptics', 'build', HAPTICS_BINARY)]
}

export interface LoadHapticsOptions {
  platform: NodeJS.Platform | string
  paths: readonly string[]
  exists?(file: string): boolean
  dlopen?(module: { exports: unknown }, file: string): void
}

/** Loads the addon, or says why it couldn't. Never throws. */
export function loadHapticsAddon(o: LoadHapticsOptions): HapticsLoad {
  if (o.platform !== 'darwin') return { addon: null, reason: 'unsupported-platform' }
  const exists = o.exists ?? existsSync
  const file = o.paths.find((p) => {
    try {
      return exists(p)
    } catch {
      return false
    }
  })
  if (!file) return { addon: null, reason: 'missing' }
  const mod: { exports: unknown } = { exports: {} }
  try {
    ;(o.dlopen ?? ((m, f) => process.dlopen(m, f)))(mod, file)
  } catch (err) {
    return { addon: null, reason: 'load-failed', error: errorMessage(err) }
  }
  const addon = mod.exports as Partial<HapticsAddon> | null
  if (!addon || typeof addon.perform !== 'function') return { addon: null, reason: 'invalid-addon', error: `${file} has no perform function` }
  return { addon: addon as HapticsAddon, path: file }
}

export interface HapticsStats {
  /** Calls that reached perform(), whatever happened next (smoke counts seam crossings with it). */
  requested: number
  /** Ticks handed to macOS. */
  played: number
  available: boolean
  reason: 'loaded' | HapticsStubReason | 'not-loaded'
}

export interface Haptics {
  /** Plays one tick; false when it was dropped (off, rate-limited, no addon). */
  perform(kind: HapticKind): boolean
  stats(): HapticsStats
}

export interface HapticsOptions {
  /** Called once, on the first tick, so start-up never pays for dlopen. */
  load(): HapticsLoad
  /** settings.haptics. */
  enabled(): boolean
  now?(): number
  minIntervalMs?: number
}

export function createHaptics(o: HapticsOptions): Haptics {
  const now = o.now ?? Date.now
  const gap = o.minIntervalMs ?? HAPTIC_MIN_INTERVAL_MS
  let loaded: HapticsLoad | null = null
  let last = -Infinity
  let requested = 0
  let played = 0
  const addon = (): HapticsAddon | null => {
    if (!loaded) {
      loaded = o.load()
      if (!loaded.addon && loaded.reason !== 'unsupported-platform') log.info('native', 'Haptics addon unavailable', { reason: loaded.reason, error: loaded.error ?? null })
    }
    return loaded.addon
  }
  return {
    perform(kind) {
      requested++
      if (!o.enabled()) return false
      const t = now()
      if (t - last < gap) return false
      const native = addon()
      if (!native) return false
      try {
        if (native.perform(PATTERN[kind]) !== true) return false
      } catch {
        // A tick is never worth an exception in a drag handler.
        return false
      }
      last = t
      played++
      return true
    },
    stats: () => ({
      requested,
      played,
      available: Boolean(loaded?.addon),
      reason: !loaded ? 'not-loaded' : loaded.addon ? 'loaded' : loaded.reason,
    }),
  }
}

let shared: Haptics | null = null

/** setupNative installs the app's instance; tests and smoke read it back. */
export function installHaptics(h: Haptics | null): void {
  shared = h
}

export function sharedHaptics(): Haptics | null {
  return shared
}

/** The haptics.perform service: a no-op until setupNative has run, off macOS, or without the addon. */
export function performHaptic(kind: HapticKind): void {
  shared?.perform(kind)
}
