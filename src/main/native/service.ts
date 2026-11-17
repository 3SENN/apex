/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HapticsServices, LidAction, LidPolicyEvent } from '@shared/haptics'
import type { MeetingRecorder } from '@shared/meetingCapture'
import type { HelperLine, SpeechBroker } from '@shared/speech'
import type { AppNotice } from '../features/personalRuntime'
import { mainT } from '../i18n/mainT'
import { errorMessage, log } from '../log'
import type { SettingsStore } from '../settings'
import { createHaptics, installHaptics, loadHapticsAddon, sharedHaptics, type Haptics, type HapticsStats } from './haptics'
import { LidPause } from './lid'

// The native extras: trackpad haptics and the lid pause. The lid arrives two
// ways: the speech helper's {type:'lid'} lines (Lid.swift, through the speech
// broker's onLine, only while the helper runs) and Electron's powerMonitor
// suspend and resume, which also cover Windows and a lid that sleeps the Mac.

/** The slice of Electron's powerMonitor this uses. */
export interface PowerEvents {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
  off(event: 'suspend' | 'resume', listener: () => void): unknown
}

export interface NativeDeps {
  settings: SettingsStore
  /** The SpeechBroker (ctx.personal.broker): `onLine` carries the helper's {type:'lid'} lines. */
  broker: SpeechBroker
  /** The MeetingRecorder (ctx.personal.recorder): pause('lid') and resume('lid'). */
  recorder: MeetingRecorder
  /** ctx.notify (category meetings). */
  notify?(n: AppNotice): void
  /** Electron's powerMonitor; absent in unit tests. */
  power?: PowerEvents
  /** Where atelier_haptics.node may be; resolved on the first tick. */
  addonPaths?(): string[]
  platform?: NodeJS.Platform
  /** Replaces the dlopen-backed instance (tests). */
  haptics?: Haptics
}

export interface NativeSetup {
  services: HapticsServices
  dispose(): void
}

/** What smoke drives: the same handlers the broker and powerMonitor feed. */
export interface NativeSmokeHooks {
  line(line: HelperLine): LidAction
  power(event: Extract<LidPolicyEvent, 'suspend' | 'resume'>): LidAction
  haptics(): HapticsStats
}

let hooks: NativeSmokeHooks | null = null

export function nativeSmokeHooks(): NativeSmokeHooks | null {
  return hooks
}

/** The speech and meeting runtime slots are stand-ins that throw until their features fill them; the rest still starts. */
function attempt<T>(what: string, fn: () => T): T | null {
  try {
    return fn()
  } catch (err) {
    log.warn('native', `Lid pause: ${what} unavailable`, { error: errorMessage(err) })
    return null
  }
}

export function setupNative(deps: NativeDeps): NativeSetup {
  const platform = deps.platform ?? process.platform
  const haptics =
    deps.haptics ??
    createHaptics({
      load: () => loadHapticsAddon({ platform, paths: deps.addonPaths?.() ?? [] }),
      enabled: () => deps.settings.get().haptics,
    })
  installHaptics(haptics)
  // The service plays through the installed instance, so smoke can swap in one without the addon.
  const current = (): Haptics => sharedHaptics() ?? haptics

  // Only macOS has a lid line; elsewhere the pause comes from sleeping.
  const mac = platform === 'darwin'
  const lid = new LidPause({
    recorder: deps.recorder,
    enabled: () => deps.settings.get().pauseMeetingsOnLidClose,
    notifyPaused: () =>
      deps.notify?.({
        category: 'meetings',
        title: mainT(mac ? 'native.lid.paused' : 'native.lid.pausedSleep'),
        body: mainT(mac ? 'native.lid.pausedBody' : 'native.lid.pausedSleepBody'),
        target: 'atelier://meetings',
      }),
  })
  const run = (what: string, fn: () => LidAction): LidAction => {
    const action = attempt(what, fn) ?? 'none'
    if (action !== 'none') log.info('native', `Lid pause: ${action}`, { via: what })
    return action
  }
  const onLine = (line: HelperLine): void => void run('helper line', () => lid.line(line))
  const onSuspend = (): void => void run('suspend', () => lid.handle('suspend'))
  const onResume = (): void => void run('resume', () => lid.handle('resume'))

  const offLine = attempt('broker.onLine', () => deps.broker.onLine(onLine))
  deps.power?.on('suspend', onSuspend)
  deps.power?.on('resume', onResume)

  hooks = {
    line: (line) => run('helper line', () => lid.line(line)),
    power: (event) => run(event, () => lid.handle(event)),
    haptics: () => current().stats(),
  }

  return {
    services: {
      haptics: {
        perform: (kind) => {
          current().perform(kind)
        },
      },
    },
    dispose: () => {
      offLine?.()
      deps.power?.off('suspend', onSuspend)
      deps.power?.off('resume', onResume)
      installHaptics(null)
      hooks = null
    },
  }
}
