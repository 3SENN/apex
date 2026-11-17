/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { BackgroundDecision, OsPlatform } from '../src/shared/system'
import { backgroundMode, backgroundPolicy, keepsRunning } from '../src/main/system/background'

// The background policy for every platform and state.

const PLATFORMS: OsPlatform[] = ['darwin', 'win32', 'linux']

function expected(o: { platform: OsPlatform; runInBackground: boolean; windowCount: number; quitting: boolean; openedAtLogin: boolean }): BackgroundDecision {
  if (o.quitting) return 'quit'
  if (o.windowCount > 0) return 'none'
  if (o.runInBackground) return o.platform === 'darwin' ? 'hide-dock' : 'stay-in-tray'
  return o.openedAtLogin ? 'none' : 'quit'
}

describe('backgroundPolicy', () => {
  for (const platform of PLATFORMS) {
    for (const runInBackground of [false, true]) {
      for (const windowCount of [0, 1, 3]) {
        for (const quitting of [false, true]) {
          for (const openedAtLogin of [false, true]) {
            const input = { platform, runInBackground, windowCount, quitting, openedAtLogin }
            it(JSON.stringify(input), () => {
              expect(backgroundPolicy(input)).toBe(expected(input))
            })
          }
        }
      }
    }
  }

  it('always quits on ⌘Q, even in background mode with windows open', () => {
    for (const platform of PLATFORMS) expect(backgroundPolicy({ platform, runInBackground: true, windowCount: 2, quitting: true, openedAtLogin: false })).toBe('quit')
  })

  it('hides the Dock only on macOS and keeps a tray elsewhere', () => {
    const base = { runInBackground: true, windowCount: 0, quitting: false, openedAtLogin: false }
    expect(backgroundPolicy({ ...base, platform: 'darwin' })).toBe('hide-dock')
    expect(backgroundPolicy({ ...base, platform: 'win32' })).toBe('stay-in-tray')
    expect(backgroundPolicy({ ...base, platform: 'linux' })).toBe('stay-in-tray')
  })

  it('starts a login launch without a window only in background mode', () => {
    const base = { windowCount: 0, quitting: false, openedAtLogin: true }
    expect(keepsRunning(backgroundPolicy({ ...base, platform: 'darwin', runInBackground: true }))).toBe(true)
    expect(backgroundPolicy({ ...base, platform: 'win32', runInBackground: false })).toBe('none')
  })

  it('quits when the last window closes without background mode, on every platform', () => {
    for (const platform of PLATFORMS) expect(backgroundPolicy({ platform, runInBackground: false, windowCount: 0, quitting: false, openedAtLogin: false })).toBe('quit')
  })
})

describe('backgroundMode hooks', () => {
  it('fall back to the default behaviour until the runtime is installed', () => {
    let quit = 0
    backgroundMode.install(null)
    backgroundMode.windowAllClosed(() => quit++)
    expect(quit).toBe(1)
    expect(backgroundMode.startHidden()).toBe(false)
  })

  it('delegate to the runtime, which can keep Apex running', () => {
    let quit = 0
    backgroundMode.install({ windowAllClosed: () => true, startHidden: () => true })
    backgroundMode.windowAllClosed(() => quit++)
    expect(quit).toBe(0)
    expect(backgroundMode.startHidden()).toBe(true)
    backgroundMode.install({ windowAllClosed: () => false, startHidden: () => false })
    backgroundMode.windowAllClosed(() => quit++)
    expect(quit).toBe(1)
    backgroundMode.install(null)
  })
})
