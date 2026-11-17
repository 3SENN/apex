/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { SettingsView } from '@shared/ipc'
import { DEFAULT_PROFILE_ID } from '@shared/profiles'
import type { AppEvent } from '@shared/services'
import { resolveAccent, type AccentChoice, type ThemeMode, type ThemePreference, type ThemeState } from '@shared/theme'

// SH-64: which profile a piece of work belongs to. A service call from
// a profile's window runs inside that profile's scope, so the stores that are
// reached through an accessor (bookmarkStore(), downloadManager()) answer with
// that profile's own instance. Outside any scope they keep the default
// profile's, the single-profile behaviour.

const scope = new AsyncLocalStorage<string>()

/** Runs `fn` (and the async work it starts) as the given profile. */
export function runInProfile<T>(profileId: string, fn: () => T): T {
  return scope.run(profileId, fn)
}

/** The profile of the work running now, or undefined outside any profile's scope. */
export function scopedProfile(): string | undefined {
  return scope.getStore()
}

/** A non-default profile's own instance, or null so the caller keeps the default one. */
export function scopedInstance<T>(resolve: ((profileId: string) => T | null) | null): T | null {
  const id = scope.getStore()
  return id !== undefined && id !== DEFAULT_PROFILE_ID && resolve ? resolve(id) : null
}

type Methods = Record<string, unknown>

/** The given namespaces of a services object, each method wrapped so it runs as the profile. */
export function scopeNamespaces<T extends object>(services: T, names: readonly (keyof T & string)[], profileId: string): Partial<T> {
  const out: Record<string, Methods> = {}
  for (const name of names) {
    const methods = services[name] as Methods | undefined
    if (!methods || typeof methods !== 'object') continue
    const wrapped: Methods = {}
    for (const [key, fn] of Object.entries(methods)) {
      wrapped[key] = typeof fn === 'function' ? (...args: unknown[]) => runInProfile(profileId, () => (fn as (...a: unknown[]) => unknown)(...args)) : fn
    }
    out[name] = wrapped
  }
  return out as Partial<T>
}

/** A window's theme: its own profile's preference and accent; 'system' reads the OS mode. */
export function profileThemeState(prefs: { theme: ThemePreference; accent: AccentChoice }, systemMode: ThemeMode, companionAccent: string): ThemeState {
  return {
    preference: prefs.theme,
    mode: prefs.theme === 'system' ? systemMode : prefs.theme,
    accentChoice: prefs.accent,
    accent: resolveAccent(prefs.accent, companionAccent),
  }
}

/** Events about the default profile's own lists: other profiles' windows hear their own instead. */
const DEFAULT_PROFILE_LISTS = new Set<AppEvent['type']>(['bookmarks', 'bookmark-tree', 'downloads', 'download-started'])

export interface ProfileEventSource {
  theme(profileId: string): ThemeState
  settings(profileId: string): SettingsView
}

/**
 * An app-wide event as one window of `profileId` should see it: the theme and
 * settings become that profile's, the default profile's bookmark and download
 * lists stay with its windows (null: not for this window), the rest pass.
 */
export function eventForProfile(event: AppEvent, profileId: string, source: ProfileEventSource): AppEvent | null {
  if (event.type === 'theme') return { type: 'theme', theme: source.theme(profileId) }
  if (event.type === 'settings') return profileId === DEFAULT_PROFILE_ID ? event : { type: 'settings', view: source.settings(profileId) }
  if (DEFAULT_PROFILE_LISTS.has(event.type) && profileId !== DEFAULT_PROFILE_ID) return null
  return event
}
