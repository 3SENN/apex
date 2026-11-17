/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHaptics, hapticsAddonPaths, loadHapticsAddon, type HapticsLoad } from '../src/main/native/haptics'
import { NATIVE_SCHEMAS } from '../src/main/native/schemas'
import { setupNative } from '../src/main/native/service'
import { seamSnapCrossings } from '../src/renderer/src/ui/logic/seam'

// SH-41: the addon loader, the 80 ms rate limit, the
// settings switch, the no-addon fallback and the seam's snap crossings.

function fakeAddon(result: boolean | Error = true) {
  const calls: string[] = []
  const load: HapticsLoad = {
    addon: {
      perform: (p) => {
        calls.push(p)
        if (result instanceof Error) throw result
        return result
      },
    },
    path: '/x/atelier_haptics.node',
  }
  return { calls, load }
}

describe('loadHapticsAddon', () => {
  const dlopenWith = (exports: unknown) => (m: { exports: unknown }) => {
    m.exports = exports
  }

  it('stubs every platform but macOS without looking for the file', () => {
    const exists = vi.fn(() => true)
    expect(loadHapticsAddon({ platform: 'win32', paths: ['/a'], exists })).toEqual({ addon: null, reason: 'unsupported-platform' })
    expect(loadHapticsAddon({ platform: 'linux', paths: ['/a'], exists }).addon).toBeNull()
    expect(exists).not.toHaveBeenCalled()
  })

  it('reports a missing binary', () => {
    expect(loadHapticsAddon({ platform: 'darwin', paths: ['/a', '/b'], exists: () => false })).toEqual({ addon: null, reason: 'missing' })
    expect(loadHapticsAddon({ platform: 'darwin', paths: [], exists: () => true }).addon).toBeNull()
  })

  it('loads the first file that exists', () => {
    const perform = () => true
    const opened: string[] = []
    const out = loadHapticsAddon({
      platform: 'darwin',
      paths: ['/a', '/b', '/c'],
      exists: (f) => f !== '/a',
      dlopen: (m, f) => {
        opened.push(f)
        m.exports = { perform }
      },
    })
    expect(opened).toEqual(['/b'])
    expect(out).toEqual({ addon: { perform }, path: '/b' })
  })

  it('turns a failed dlopen or a wrong export into a stub reason', () => {
    const fail = loadHapticsAddon({
      platform: 'darwin',
      paths: ['/a'],
      exists: () => true,
      dlopen: () => {
        throw new Error('wrong architecture')
      },
    })
    expect(fail).toEqual({ addon: null, reason: 'load-failed', error: 'wrong architecture' })
    expect(loadHapticsAddon({ platform: 'darwin', paths: ['/a'], exists: () => true, dlopen: dlopenWith({}) })).toMatchObject({ addon: null, reason: 'invalid-addon' })
    expect(loadHapticsAddon({ platform: 'darwin', paths: ['/a'], exists: () => true, dlopen: dlopenWith(null) })).toMatchObject({ addon: null, reason: 'invalid-addon' })
  })

  it('treats a throwing existence check as missing', () => {
    const exists = () => {
      throw new Error('EACCES')
    }
    expect(loadHapticsAddon({ platform: 'darwin', paths: ['/a'], exists }).addon).toBeNull()
  })
})

describe('hapticsAddonPaths', () => {
  it('uses Resources/native when packaged and the build folder in development', () => {
    const o = { resourcesPath: '/App/Contents/Resources', appPath: '/src/atelier' }
    expect(hapticsAddonPaths({ ...o, packaged: true })).toEqual([join('/App/Contents/Resources/native/atelier_haptics.node')])
    expect(hapticsAddonPaths({ ...o, packaged: false })).toEqual([join('/src/atelier/native/haptics/build/atelier_haptics.node')])
  })
})

describe('createHaptics', () => {
  it('maps the service kinds onto AppKit pattern names', () => {
    const { calls, load } = fakeAddon()
    let t = 0
    const h = createHaptics({ load: () => load, enabled: () => true, now: () => (t += 100) })
    h.perform('alignment')
    h.perform('level-change')
    h.perform('generic')
    expect(calls).toEqual(['alignment', 'levelChange', 'generic'])
  })

  it('plays at most one tick per 80 ms', () => {
    const { calls, load } = fakeAddon()
    let t = 1000
    const h = createHaptics({ load: () => load, enabled: () => true, now: () => t })
    expect(h.perform('alignment')).toBe(true)
    t += 79
    expect(h.perform('alignment')).toBe(false)
    t += 1
    expect(h.perform('alignment')).toBe(true)
    // A dropped tick doesn't push the window back.
    t += 40
    expect(h.perform('alignment')).toBe(false)
    t += 40
    expect(h.perform('alignment')).toBe(true)
    expect(calls).toHaveLength(3)
    expect(h.stats()).toMatchObject({ requested: 5, played: 3, available: true, reason: 'loaded' })
  })

  it('does nothing, and never loads the addon, while settings.haptics is off', () => {
    const { calls, load } = fakeAddon()
    const loader = vi.fn(() => load)
    let enabled = false
    const h = createHaptics({ load: loader, enabled: () => enabled, now: () => 0 })
    expect(h.perform('alignment')).toBe(false)
    expect(loader).not.toHaveBeenCalled()
    expect(h.stats().reason).toBe('not-loaded')
    enabled = true
    expect(h.perform('alignment')).toBe(true)
    expect(calls).toEqual(['alignment'])
  })

  it('falls back to a no-op without the addon, loading only once', () => {
    const loader = vi.fn((): HapticsLoad => ({ addon: null, reason: 'missing' }))
    let t = 0
    const h = createHaptics({ load: loader, enabled: () => true, now: () => (t += 200) })
    expect(h.perform('alignment')).toBe(false)
    expect(h.perform('generic')).toBe(false)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(h.stats()).toEqual({ requested: 2, played: 0, available: false, reason: 'missing' })
  })

  it('swallows a native failure and a false return', () => {
    let t = 0
    const now = () => (t += 200)
    expect(createHaptics({ load: () => fakeAddon(new Error('boom')).load, enabled: () => true, now }).perform('alignment')).toBe(false)
    expect(createHaptics({ load: () => fakeAddon(false).load, enabled: () => true, now }).perform('alignment')).toBe(false)
  })
})

describe('the haptics service', () => {
  const settings = (haptics: boolean) => ({ get: () => ({ haptics, pauseMeetingsOnLidClose: true }) }) as never
  const broker = { onLine: () => () => undefined } as never
  const recorder = {} as never

  it('has a schema for perform that accepts only the three kinds', () => {
    const schema = NATIVE_SCHEMAS.haptics.perform
    expect(schema.safeParse(['alignment']).success).toBe(true)
    expect(schema.safeParse(['level-change']).success).toBe(true)
    expect(schema.safeParse(['levelChange']).success).toBe(false)
    expect(schema.safeParse([]).success).toBe(false)
  })

  it('resolves without the addon, off macOS and with the setting off', () => {
    for (const [platform, on] of [['darwin', true], ['darwin', false], ['win32', true], ['linux', true]] as const) {
      const native = setupNative({ settings: settings(on), broker, recorder, platform, addonPaths: () => ['/nowhere/atelier_haptics.node'] })
      expect(native.services.haptics.perform('alignment')).toBeUndefined()
      native.dispose()
    }
  })

  it('routes perform through the installed instance', () => {
    const { calls, load } = fakeAddon()
    const native = setupNative({ settings: settings(true), broker, recorder, haptics: createHaptics({ load: () => load, enabled: () => true }) })
    native.services.haptics.perform('level-change')
    expect(calls).toEqual(['levelChange'])
    native.dispose()
  })
})

describe('seamSnapCrossings', () => {
  const points = [1 / 3, 1 / 2, 2 / 3]

  it('reports a point crossed in either direction', () => {
    expect(seamSnapCrossings(0.45, 0.55, points)).toEqual([0.5])
    expect(seamSnapCrossings(0.55, 0.45, points)).toEqual([0.5])
    expect(seamSnapCrossings(0.3, 0.34, points)).toEqual([1 / 3])
  })

  it('reports nothing while the seam stays on one side', () => {
    expect(seamSnapCrossings(0.4, 0.45, points)).toEqual([])
    expect(seamSnapCrossings(0.55, 0.6, points)).toEqual([])
    expect(seamSnapCrossings(0.5, 0.5, points)).toEqual([])
  })

  it('counts landing on a point once, not again when moving off it', () => {
    expect(seamSnapCrossings(0.45, 0.5, points)).toEqual([0.5])
    expect(seamSnapCrossings(0.5, 0.55, points)).toEqual([])
    expect(seamSnapCrossings(0.5, 0.45, points)).toEqual([])
  })

  it('lists every point a fast drag jumps over, in travel order', () => {
    expect(seamSnapCrossings(0.2, 0.8, points)).toEqual([1 / 3, 1 / 2, 2 / 3])
    expect(seamSnapCrossings(0.8, 0.2, points)).toEqual([2 / 3, 1 / 2, 1 / 3])
  })

  it('fires once per crossing over a whole drag, with no repeats', () => {
    // A pointer drag that wobbles around the even split, then carries on.
    const path = [0.4, 0.45, 0.49, 0.5, 0.5, 0.51, 0.52, 0.49, 0.48, 0.53, 0.6, 0.7, 0.68, 0.66]
    const fired: number[] = []
    for (let i = 1; i < path.length; i++) fired.push(...seamSnapCrossings(path[i - 1]!, path[i]!, points))
    expect(fired).toEqual([0.5, 0.5, 0.5, 2 / 3, 2 / 3])
  })
})
