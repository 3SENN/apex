/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutosave, type SaveState } from '../src/renderer/src/ui/logic/autosave'
import { cx, formatCount, menuAnchorPoint, resolveRename, ringGeometry } from '../src/renderer/src/ui/logic/format'
import { rovingIndex, trapFocusIndex } from '../src/renderer/src/ui/logic/keys'
import { createQueue, createRefCount } from '../src/renderer/src/ui/logic/queues'
import { clampSeam, seamDragValue, seamKeyValue, seamResetValue } from '../src/renderer/src/ui/logic/seam'
import { ariaKeyShortcut, formatShortcut, parseAccelerator, shortcutParts, tooltipText } from '../src/renderer/src/ui/logic/shortcut'
import { formatDuration, formatRelative } from '../src/renderer/src/ui/logic/time'

describe('seam', () => {
  const range = { min: 220, max: 360 }

  it('clamps, and gives the minimum when the container is too small', () => {
    expect(clampSeam(400, range)).toBe(360)
    expect(clampSeam(100, range)).toBe(220)
    expect(clampSeam(300, range)).toBe(300)
    expect(clampSeam(300, { min: 220, max: 180 })).toBe(220)
  })

  it('follows the pointer, reversed for elements after the seam', () => {
    expect(seamDragValue({ ...range, start: 260, deltaPx: 30 })).toBe(290)
    expect(seamDragValue({ ...range, start: 260, deltaPx: 30, reverse: true })).toBe(230)
    expect(seamDragValue({ ...range, start: 260, deltaPx: 500 })).toBe(360)
  })

  it('converts pixels to units and snaps (rows in the chats divider)', () => {
    const rows = { min: 1, max: 12, start: 5, pixelsPerUnit: 30, snap: 1 }
    expect(seamDragValue({ ...rows, deltaPx: 44 })).toBe(6)
    expect(seamDragValue({ ...rows, deltaPx: 46 })).toBe(7)
    expect(seamDragValue({ ...rows, deltaPx: -1000 })).toBe(1)
  })

  it('steps with arrows along its axis and jumps with Home and End', () => {
    const o = { ...range, orientation: 'vertical' as const, step: 8 }
    expect(seamKeyValue('ArrowRight', 260, o)).toBe(268)
    expect(seamKeyValue('ArrowLeft', 260, o)).toBe(252)
    expect(seamKeyValue('ArrowLeft', 260, { ...o, reverse: true })).toBe(268)
    expect(seamKeyValue('ArrowRight', 260, { ...o, shift: true })).toBe(292)
    expect(seamKeyValue('ArrowUp', 260, o)).toBeNull()
    expect(seamKeyValue('Home', 260, o)).toBe(220)
    expect(seamKeyValue('End', 260, o)).toBe(360)
    expect(seamKeyValue('ArrowRight', 358, o)).toBe(360)
    const rows = { min: 1, max: 9, orientation: 'horizontal' as const, step: 1 }
    expect(seamKeyValue('ArrowDown', 3, rows)).toBe(4)
    expect(seamKeyValue('ArrowUp', 3, rows)).toBe(2)
    expect(seamKeyValue('a', 3, rows)).toBeNull()
  })

  it('resets to a default or to a toggle of the current value', () => {
    expect(seamResetValue(300, 260, range)).toBe(260)
    const toggle = (current: number): number => (current === 5 ? 12 : 5)
    expect(seamResetValue(5, toggle, { min: 1, max: 12 })).toBe(12)
    expect(seamResetValue(12, toggle, { min: 1, max: 12 })).toBe(5)
  })
})

describe('relative time', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime()
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour

  it('reads the past in long and short styles', () => {
    expect(formatRelative(now - 10_000, now)).toBe('just now')
    expect(formatRelative(now - 10_000, now, 'short')).toBe('now')
    expect(formatRelative(now - 50_000, now)).toBe('1 min ago')
    expect(formatRelative(now - 5 * min, now)).toBe('5 min ago')
    expect(formatRelative(now - 5 * min, now, 'short')).toBe('5m')
    expect(formatRelative(now - 3 * hour - 5 * min, now)).toBe('3 h ago')
    expect(formatRelative(now - 3 * hour, now, 'short')).toBe('3h')
    expect(formatRelative(now - day - hour, now)).toBe('yesterday')
    expect(formatRelative(now - day, now, 'short')).toBe('1d')
    expect(formatRelative(now - 4 * day, now)).toBe('4 days ago')
    expect(formatRelative(now - 8 * day, now)).toBe('1 week ago')
    expect(formatRelative(now - 15 * day, now, 'short')).toBe('2w')
  })

  it('falls back to a date after five weeks, with the year when it differs', () => {
    expect(formatRelative(new Date(2026, 2, 3).getTime(), now, 'long', 'en-US')).toBe('Mar 3')
    expect(formatRelative(new Date(2025, 2, 3).getTime(), now, 'long', 'en-US')).toBe('Mar 3, 2025')
  })

  it('reads the future', () => {
    expect(formatRelative(now + 5 * min, now)).toBe('in 5 min')
    expect(formatRelative(now + 2 * hour, now, 'short')).toBe('in 2h')
    expect(formatRelative(now + day + hour, now)).toBe('tomorrow')
    expect(formatRelative(now + 3 * day, now)).toBe('in 3 days')
  })

  it('formats countdowns in two units', () => {
    expect(formatDuration(20_000)).toBe('under a minute')
    expect(formatDuration(20_000, 'short')).toBe('<1m')
    expect(formatDuration(5 * min)).toBe('5 min')
    expect(formatDuration(2 * hour + 5 * min)).toBe('2 h 5 min')
    expect(formatDuration(2 * hour + 5 * min, 'short')).toBe('2h 5m')
    expect(formatDuration(3 * day + 4 * hour + 9 * min)).toBe('3 days 4 h')
    expect(formatDuration(hour)).toBe('1 h')
    expect(formatDuration(-5)).toBe('under a minute')
  })
})

describe('shortcuts', () => {
  it('parses accelerators per platform', () => {
    expect(parseAccelerator('CmdOrCtrl+Shift+E', true)).toEqual({ cmd: true, ctrl: false, alt: false, shift: true, key: 'E' })
    expect(parseAccelerator('CmdOrCtrl+Shift+E', false)).toEqual({ cmd: false, ctrl: true, alt: false, shift: true, key: 'E' })
    expect(parseAccelerator('Cmd++', true).key).toBe('+')
    expect(parseAccelerator('Option+Space', true)).toMatchObject({ alt: true, key: 'Space' })
  })

  it('formats in each platform’s order', () => {
    expect(formatShortcut('CmdOrCtrl+Shift+E', true)).toBe('⇧⌘E')
    expect(formatShortcut('Alt+CmdOrCtrl+Right', true)).toBe('⌥⌘→')
    expect(formatShortcut('Ctrl+Alt+Shift+Cmd+k', true)).toBe('⌃⌥⇧⌘K')
    expect(formatShortcut('CmdOrCtrl+Shift+E', false)).toBe('Ctrl+Shift+E')
    expect(formatShortcut('CmdOrCtrl+Backspace', false)).toBe('Ctrl+Backspace')
    expect(shortcutParts('CmdOrCtrl+[', true)).toEqual(['⌘', '['])
    expect(shortcutParts('Enter', true)).toEqual(['↩'])
  })

  it('builds aria-keyshortcuts and tooltips', () => {
    expect(ariaKeyShortcut('CmdOrCtrl+Shift+E', true)).toBe('Shift+Meta+E')
    expect(ariaKeyShortcut('CmdOrCtrl+Left', false)).toBe('Control+ArrowLeft')
    expect(tooltipText('Show sidebar', 'CmdOrCtrl+S', true)).toBe('Show sidebar (⌘S)')
    expect(tooltipText('Back', undefined, true)).toBe('Back')
  })
})

describe('roving focus', () => {
  it('moves along its orientation and wraps', () => {
    expect(rovingIndex('ArrowRight', 0, 3)).toBe(1)
    expect(rovingIndex('ArrowRight', 2, 3)).toBe(0)
    expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(rovingIndex('ArrowDown', 0, 3)).toBeNull()
    expect(rovingIndex('ArrowDown', 0, 3, { orientation: 'vertical' })).toBe(1)
    expect(rovingIndex('ArrowUp', 1, 3, { orientation: 'both' })).toBe(0)
    expect(rovingIndex('ArrowRight', 2, 3, { loop: false })).toBeNull()
    expect(rovingIndex('Enter', 0, 3)).toBeNull()
  })

  it('skips disabled items, including for Home and End', () => {
    const disabled = (i: number): boolean => i === 1 || i === 3
    expect(rovingIndex('ArrowRight', 0, 4, { disabled })).toBe(2)
    expect(rovingIndex('ArrowRight', 2, 4, { disabled })).toBe(0)
    expect(rovingIndex('End', 0, 4, { disabled })).toBe(2)
    expect(rovingIndex('Home', 2, 4, { disabled: (i) => i === 0 })).toBe(1)
    expect(rovingIndex('ArrowRight', 0, 2, { disabled: () => true })).toBeNull()
  })

  it('wraps Tab inside a focus trap', () => {
    expect(trapFocusIndex(2, 3, false)).toBe(0)
    expect(trapFocusIndex(0, 3, true)).toBe(2)
    expect(trapFocusIndex(-1, 3, false)).toBe(0)
    expect(trapFocusIndex(-1, 3, true)).toBe(2)
    expect(trapFocusIndex(0, 0, false)).toBe(-1)
  })
})

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (save: (value: string) => Promise<unknown>) => {
    const states: SaveState[] = []
    const autosave = createAutosave({ save, onState: (s) => states.push(s), delay: 500, savedFor: 1000 })
    return { autosave, states }
  }

  it('waits for a pause, writes only the newest value, then settles back to idle', async () => {
    const save = vi.fn(async () => undefined)
    const { autosave, states } = setup(save)
    autosave.change('a')
    await vi.advanceTimersByTimeAsync(300)
    autosave.change('ab')
    await vi.advanceTimersByTimeAsync(499)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledExactlyOnceWith('ab')
    expect(states).toEqual(['saving', 'saved'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(states).toEqual(['saving', 'saved', 'idle'])
  })

  it('keeps a failed value for Retry', async () => {
    let fail = true
    const save = vi.fn(async () => {
      if (fail) throw new Error('disk full')
    })
    const { autosave, states } = setup(save)
    autosave.change('x')
    await autosave.flush()
    expect(autosave.state).toBe('error')
    fail = false
    await autosave.retry()
    expect(save).toHaveBeenLastCalledWith('x')
    expect(states).toEqual(['saving', 'error', 'saving', 'saved'])
  })

  it('writes a change made during a save right after it', async () => {
    let finish: () => void = () => undefined
    const save = vi.fn((_value: string) => new Promise<void>((resolve) => (finish = resolve)))
    const { autosave } = setup(save)
    autosave.change('one')
    const first = autosave.flush()
    autosave.change('two')
    const second = autosave.flush()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    finish()
    await Promise.all([first, second])
    expect(save.mock.calls.map((c) => c[0])).toEqual(['one', 'two'])
    expect(autosave.state).toBe('saved')
  })

  it('a newer value replaces a failed one', async () => {
    const save = vi.fn(async (v: string) => {
      if (v === 'bad') throw new Error('nope')
    })
    const { autosave } = setup(save)
    autosave.change('bad')
    await autosave.flush()
    autosave.change('good')
    await autosave.retry()
    expect(save.mock.calls.map((c) => c[0])).toEqual(['bad', 'good'])
    expect(autosave.state).toBe('saved')
  })

  it('writes pending work on dispose without further state updates', async () => {
    const save = vi.fn(async () => undefined)
    const { autosave, states } = setup(save)
    autosave.change('last')
    autosave.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledWith('last')
    expect(states).toEqual([])
  })
})

describe('queues and holds', () => {
  it('caps the list, dropping the oldest, and replaces by id', () => {
    const q = createQueue<{ id: string; n: number }>(2)
    const seen: number[] = []
    q.subscribe(() => seen.push(q.items().length))
    q.push({ id: 'a', n: 1 })
    q.push({ id: 'b', n: 2 })
    const { dropped } = q.push({ id: 'c', n: 3 })
    expect(dropped.map((t) => t.id)).toEqual(['a'])
    const { replaced } = q.push({ id: 'b', n: 4 })
    expect(replaced?.n).toBe(2)
    expect(q.items().map((t) => t.n)).toEqual([4, 3])
    expect(q.remove('c')?.n).toBe(3)
    expect(q.remove('zzz')).toBeNull()
    expect(seen).toEqual([1, 2, 2, 2, 1])
  })

  it('reports the overlay open on the first hold and closed after the last', () => {
    const changes: boolean[] = []
    const holds = createRefCount((open) => changes.push(open))
    const a = holds.acquire()
    const b = holds.acquire()
    a()
    a() // a second release is ignored
    expect(changes).toEqual([true])
    expect(holds.count).toBe(1)
    b()
    expect(changes).toEqual([true, false])
  })
})

describe('format helpers', () => {
  it('joins classes and caps counts', () => {
    expect(cx('a', false, null, undefined, 'b')).toBe('a b')
    expect(formatCount(7)).toBe('7')
    expect(formatCount(120)).toBe('99+')
    expect(formatCount(12, 9)).toBe('9+')
  })

  it('resolves inline renames', () => {
    expect(resolveRename('Trip plan', '  Trip   ideas ')).toBe('Trip ideas')
    expect(resolveRename('Trip plan', 'Trip plan')).toBeNull()
    expect(resolveRename('Trip plan', '   ')).toBeNull()
    expect(resolveRename('a', 'abcdef', 3)).toBe('abc')
  })

  it('anchors menus under an element and draws rings', () => {
    expect(menuAnchorPoint({ left: 10.4, top: 20, right: 40, bottom: 50.6 })).toEqual({ x: 10, y: 55 })
    const ring = ringGeometry(20, 2, 0.5)
    expect(ring.radius).toBe(9)
    expect(ring.offset).toBeCloseTo(ring.circumference / 2)
    expect(ringGeometry(20, 2, 7).offset).toBe(0)
    expect(ringGeometry(20, 2, Number.NaN).offset).toBeCloseTo(ring.circumference)
  })
})
