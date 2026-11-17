/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import { RebuildScheduler, type RebuildTimers } from '../src/main/menuRebuild'

// SH-59: native menus rebuild debounced, and never while a menu is open.

function fakeTimers(): RebuildTimers & { tick(ms: number): void } {
  let now = 0
  let seq = 0
  const queue = new Map<number, { at: number; fn: () => void }>()
  return {
    set(fn, ms) {
      const id = ++seq
      queue.set(id, { at: now + ms, fn })
      return id
    },
    clear(handle) {
      queue.delete(handle as number)
    },
    tick(ms) {
      now += ms
      for (const [id, t] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue
        queue.delete(id)
        t.fn()
      }
    },
  }
}

describe('menu rebuilds', () => {
  it('debounces a burst of changes into one rebuild', () => {
    const timers = fakeTimers()
    const build = vi.fn()
    const s = new RebuildScheduler(build, 100, timers)
    s.request()
    s.request()
    s.request()
    timers.tick(99)
    expect(build).not.toHaveBeenCalled()
    timers.tick(1)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('waits while a menu is open and rebuilds once it closes', () => {
    const timers = fakeTimers()
    const build = vi.fn()
    const s = new RebuildScheduler(build, 100, timers)
    s.menuOpened()
    s.request()
    timers.tick(500)
    expect(build).not.toHaveBeenCalled()
    expect(s.menuOpen).toBe(true)
    s.menuClosed()
    timers.tick(100)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('defers a pending rebuild when a menu opens before it fires', () => {
    const timers = fakeTimers()
    const build = vi.fn()
    const s = new RebuildScheduler(build, 100, timers)
    s.request()
    s.menuOpened()
    timers.tick(100)
    expect(build).not.toHaveBeenCalled()
    s.menuClosed()
    timers.tick(100)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('waits for nested submenus to close too', () => {
    const timers = fakeTimers()
    const build = vi.fn()
    const s = new RebuildScheduler(build, 100, timers)
    s.menuOpened()
    s.menuOpened()
    s.request()
    s.menuClosed()
    timers.tick(200)
    expect(build).not.toHaveBeenCalled()
    s.menuClosed()
    timers.tick(100)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('does not rebuild after a close when nothing changed', () => {
    const timers = fakeTimers()
    const build = vi.fn()
    const s = new RebuildScheduler(build, 100, timers)
    s.menuOpened()
    s.menuClosed()
    timers.tick(500)
    expect(build).not.toHaveBeenCalled()
  })

  it('rebuilds anyway when a close event is lost', () => {
    const timers = fakeTimers()
    const build = vi.fn()
    const s = new RebuildScheduler(build, 100, timers, 1000)
    s.menuOpened()
    s.request()
    timers.tick(1000)
    timers.tick(100)
    expect(build).toHaveBeenCalledTimes(1)
    expect(s.menuOpen).toBe(false)
  })
})
