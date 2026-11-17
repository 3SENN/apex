/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticator, UnlockWindow, type AuthDeps } from '../src/main/passwords/auth'

// The authenticator's fallbacks and the Passwords page's unlock window.

const deps = (over: Partial<AuthDeps>): AuthDeps => ({ platform: 'darwin', smoke: false, ...over })

describe('createAuthenticator', () => {
  it('says ok in smoke without asking anything', async () => {
    const prompt = vi.fn()
    const auth = createAuthenticator(deps({ smoke: true, touchId: { can: () => true, prompt } }))
    expect(await auth.authenticate('x')).toBe('ok')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('uses Touch ID when the Mac can prompt for it', async () => {
    const helper = { authenticate: vi.fn(async () => 'ok' as const) }
    const auth = createAuthenticator(deps({ touchId: { can: () => true, prompt: async () => undefined }, helper }))
    expect(await auth.authenticate('see passwords')).toBe('ok')
    expect(helper.authenticate).not.toHaveBeenCalled()
  })

  it('treats a cancelled Touch ID sheet as an answer', async () => {
    const helper = { authenticate: vi.fn(async () => 'ok' as const) }
    const auth = createAuthenticator(deps({ touchId: { can: () => true, prompt: async () => Promise.reject(new Error('User canceled Touch ID')) }, helper }))
    expect(await auth.authenticate('x')).toBe('cancelled')
    expect(helper.authenticate).not.toHaveBeenCalled()
  })

  it('falls back to the helper without Touch ID, or after a Touch ID failure', async () => {
    const helper = { authenticate: vi.fn(async () => 'ok' as const) }
    expect(await createAuthenticator(deps({ touchId: { can: () => false, prompt: vi.fn() }, helper })).authenticate('x')).toBe('ok')
    expect(await createAuthenticator(deps({ touchId: { can: () => true, prompt: async () => Promise.reject(new Error('Lockout')) }, helper })).authenticate('x')).toBe('ok')
    expect(helper.authenticate).toHaveBeenCalledTimes(2)
  })

  it('is unavailable on a Mac with neither Touch ID nor the helper, and never shows the plain confirm there', async () => {
    const confirm = vi.fn(async () => true)
    const auth = createAuthenticator(deps({ touchId: { can: () => false, prompt: vi.fn() }, helper: { authenticate: async () => 'unavailable' }, confirm }))
    expect(await auth.authenticate('x')).toBe('unavailable')
    const crashing = createAuthenticator(deps({ helper: { authenticate: async () => Promise.reject(new Error('gone')) }, confirm }))
    expect(await crashing.authenticate('x')).toBe('unavailable')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks with an Apex confirm dialog off macOS', async () => {
    const yes = createAuthenticator(deps({ platform: 'win32', confirm: async () => true }))
    expect(await yes.authenticate('x')).toBe('ok')
    const no = createAuthenticator(deps({ platform: 'linux', confirm: async () => false }))
    expect(await no.authenticate('x')).toBe('cancelled')
    const nowhere = createAuthenticator(deps({ platform: 'linux', confirm: async () => Promise.reject(new Error('no window')) }))
    expect(await nowhere.authenticate('x')).toBe('unavailable')
    expect(await createAuthenticator(deps({ platform: 'linux' })).authenticate('x')).toBe('unavailable')
  })

  it('shares one prompt between overlapping requests', async () => {
    let release: () => void = () => undefined
    const prompt = vi.fn(() => new Promise<void>((r) => (release = r)))
    const auth = createAuthenticator(deps({ touchId: { can: () => true, prompt } }))
    const a = auth.authenticate('x')
    const b = auth.authenticate('y')
    release()
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok'])
    expect(prompt).toHaveBeenCalledTimes(1)
    // A later request prompts again.
    const c = auth.authenticate('z')
    release()
    expect(await c).toBe('ok')
    expect(prompt).toHaveBeenCalledTimes(2)
  })
})

describe('UnlockWindow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays open for five minutes, then locks itself and says so', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const changes: boolean[] = []
    const unlock = new UnlockWindow((locked) => changes.push(locked))
    expect(unlock.isUnlocked()).toBe(false)
    unlock.open()
    expect(unlock.until()).toBe(1_000_000 + 5 * 60_000)
    vi.advanceTimersByTime(5 * 60_000 - 1)
    expect(unlock.isUnlocked()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(unlock.isUnlocked()).toBe(false)
    expect(changes).toEqual([false, true])
  })

  it('locks at once on lock(), and only reports a real change', () => {
    const changes: boolean[] = []
    let now = 0
    const unlock = new UnlockWindow((locked) => changes.push(locked), 1000, () => now)
    unlock.lock()
    expect(changes).toEqual([])
    unlock.open()
    unlock.lock()
    expect(changes).toEqual([false, true])
    unlock.open()
    now = 5000
    // A sleeping Mac's timer may fire late; reading it still says locked.
    expect(unlock.until()).toBeNull()
    unlock.dispose()
  })
})
