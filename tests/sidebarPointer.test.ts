/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_POINTER_POLL_MS, SidebarPointerWatch, pointerWithin, type PollTimers, type SidebarPointerHost } from '../src/main/sidebarPointer'

// DS-14: main polls the cursor while the pointer is in the sidebar, says once
// it has left, and never keeps polling after a leave, a blur or a hide.

const SIDEBAR = { x: 0, y: 0, width: 300, height: 800 }

function harness(over: Partial<SidebarPointerHost> = {}) {
  const state = { cursor: { x: 150, y: 80 }, alive: true, visible: true }
  const left = vi.fn()
  const host: SidebarPointerHost = {
    alive: () => state.alive,
    visible: () => state.visible,
    cursor: () => state.cursor,
    content: () => ({ x: 100, y: 0, width: 1200, height: 800 }),
    zoom: () => 1,
    left,
    ...over,
  }
  return { state, left, watch: new SidebarPointerWatch(host) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('sidebar pointer watch', () => {
  it('polls about every 100 ms while the pointer is inside', () => {
    vi.useFakeTimers()
    const { state, left, watch } = harness()
    state.cursor = { x: 150, y: 80 } // 50 px into the sidebar
    watch.track(SIDEBAR)
    expect(watch.active).toBe(true)
    vi.advanceTimersByTime(SIDEBAR_POINTER_POLL_MS * 5)
    expect(left).not.toHaveBeenCalled()
    expect(watch.active).toBe(true)
    expect(SIDEBAR_POINTER_POLL_MS).toBe(100)
  })

  it('tells the chrome once the cursor leaves, then stops polling', () => {
    vi.useFakeTimers()
    const { state, left, watch } = harness()
    watch.track(SIDEBAR)
    vi.advanceTimersByTime(SIDEBAR_POINTER_POLL_MS)
    state.cursor = { x: 700, y: 80 } // over the page view
    vi.advanceTimersByTime(SIDEBAR_POINTER_POLL_MS)
    expect(left).toHaveBeenCalledTimes(1)
    expect(watch.active).toBe(false)
    vi.advanceTimersByTime(SIDEBAR_POINTER_POLL_MS * 10)
    expect(left).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops on a blur or hide and tells the chrome once', () => {
    vi.useFakeTimers()
    const { left, watch } = harness()
    watch.track(SIDEBAR)
    watch.release()
    expect(watch.active).toBe(false)
    expect(left).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    // A second blur while not watching says nothing.
    watch.release()
    expect(left).toHaveBeenCalledTimes(1)
  })

  it('counts a hidden window as left', () => {
    vi.useFakeTimers()
    const { state, left, watch } = harness()
    watch.track(SIDEBAR)
    state.visible = false
    vi.advanceTimersByTime(SIDEBAR_POINTER_POLL_MS)
    expect(left).toHaveBeenCalledTimes(1)
    expect(watch.active).toBe(false)
  })

  it('stops quietly when the chrome reports the leave itself or the window goes away', () => {
    vi.useFakeTimers()
    const { state, left, watch } = harness()
    watch.track(SIDEBAR)
    watch.track(null)
    expect(watch.active).toBe(false)
    watch.track(SIDEBAR)
    state.alive = false
    vi.advanceTimersByTime(SIDEBAR_POINTER_POLL_MS)
    expect(watch.active).toBe(false)
    expect(left).not.toHaveBeenCalled()
    // A dead window never starts polling.
    watch.track(SIDEBAR)
    expect(watch.active).toBe(false)
  })

  it('re-arming with a new rect keeps a single poll', () => {
    const handles: number[] = []
    const cancelled: number[] = []
    let next = 0
    const timers: PollTimers = {
      every: () => {
        handles.push(++next)
        return next
      },
      cancel: (h) => cancelled.push(h as number),
    }
    const left = vi.fn()
    const watch = new SidebarPointerWatch({ alive: () => true, visible: () => true, cursor: () => ({ x: 0, y: 0 }), content: () => SIDEBAR, zoom: () => 1, left }, timers)
    watch.track(SIDEBAR)
    watch.track({ ...SIDEBAR, width: 280 })
    expect(handles).toEqual([1, 2])
    expect(cancelled).toEqual([1])
    watch.stop()
    expect(cancelled).toEqual([1, 2])
  })

  it('treats a cursor read that throws as a leave', () => {
    vi.useFakeTimers()
    const { left, watch } = harness({
      cursor: () => {
        throw new Error('no screen')
      },
    })
    watch.track(SIDEBAR)
    vi.advanceTimersByTime(SIDEBAR_POINTER_POLL_MS)
    expect(left).toHaveBeenCalledTimes(1)
  })

  it('maps the cursor into the chrome with the zoom', () => {
    const content = { x: 100, y: 0, width: 1200, height: 800 }
    expect(pointerWithin({ x: 150, y: 80 }, content, 1, SIDEBAR)).toBe(true)
    expect(pointerWithin({ x: 400, y: 80 }, content, 1, SIDEBAR)).toBe(false)
    expect(pointerWithin({ x: 650, y: 80 }, content, 2, SIDEBAR)).toBe(true)
  })
})
