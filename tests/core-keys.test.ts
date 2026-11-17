/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { HOLD_PREFIX, SHORTCUTS, formatKeys } from '@shared/shortcuts'
import { CommandRegistry } from '../src/main/commands'
import { EDGE_OUTSIDE_PX, EDGE_ZONE_PX, EdgeRevealPoller, KeyStateMachine, NUMBER_HINTS_MS, RECENT_TABS_HOLD_MS, edgeActive, type KeyInput, type KeyTimers } from '../src/main/keyState'
import { inputAccelerators, matchShortcut, routeShortcut, shortcuts, type RouteContext } from '../src/main/shortcuts'

// The ShortcutRouter's decisions, the key-state machine (⌘ hold,
// ⌃Tab tap and hold) and edge reveal, all with fake timers and inputs.

class FakeTimers implements KeyTimers {
  now = 0
  #next = 1
  readonly #pending = new Map<number, { at: number; fn: () => void }>()
  set(fn: () => void, ms: number): unknown {
    const id = this.#next++
    this.#pending.set(id, { at: this.now + ms, fn })
    return id
  }
  clear(handle: unknown): void {
    this.#pending.delete(handle as number)
  }
  advance(ms: number): void {
    this.now += ms
    for (const [id, t] of [...this.#pending]) {
      if (t.at <= this.now) {
        this.#pending.delete(id)
        t.fn()
      }
    }
  }
}

const key = (type: 'keyDown' | 'keyUp', k: string, mods: Partial<Pick<KeyInput, 'control' | 'meta' | 'alt' | 'shift'>> = {}, code = ''): KeyInput & { code: string } => ({
  type,
  key: k,
  code,
  control: mods.control ?? false,
  meta: mods.meta ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
})

function machine(platform = 'darwin') {
  const timers = new FakeTimers()
  const events: unknown[] = []
  const taps: number[] = []
  const m = new KeyStateMachine({ emit: (e) => events.push(e), tap: (d) => taps.push(d) }, { platform, timers })
  return { m, timers, events, taps }
}

describe('number hints (⌘ held)', () => {
  it('show after about 300 ms and hide on release', () => {
    const { m, timers, events } = machine()
    m.input(key('keyDown', 'Meta', { meta: true }))
    timers.advance(NUMBER_HINTS_MS - 1)
    expect(events).toEqual([])
    timers.advance(1)
    expect(events).toEqual([{ type: 'number-hints', show: true }])
    m.input(key('keyUp', 'Meta'))
    expect(events.at(-1)).toEqual({ type: 'number-hints', show: false })
  })

  it('never show when another key comes first, and hide on another key or blur', () => {
    const { m, timers, events } = machine()
    m.input(key('keyDown', 'Meta', { meta: true }))
    m.input(key('keyDown', 't', { meta: true }))
    timers.advance(500)
    expect(events).toEqual([])
    m.input(key('keyUp', 't', { meta: true }))
    m.input(key('keyUp', 'Meta'))
    m.input(key('keyDown', 'Meta', { meta: true }))
    timers.advance(NUMBER_HINTS_MS)
    m.input(key('keyDown', '1', { meta: true }))
    expect(events).toEqual([
      { type: 'number-hints', show: true },
      { type: 'number-hints', show: false },
    ])
    m.input(key('keyDown', 'Meta', { meta: true }))
    timers.advance(NUMBER_HINTS_MS)
    m.blur()
    expect(events.at(-1)).toEqual({ type: 'number-hints', show: false })
  })

  it('use Control on Windows and Linux', () => {
    const { m, timers, events } = machine('win32')
    m.input(key('keyDown', 'Control', { control: true }))
    timers.advance(NUMBER_HINTS_MS)
    expect(events).toEqual([{ type: 'number-hints', show: true }])
  })
})

describe('⌃Tab', () => {
  it('flips to the previous tab on a quick tap', () => {
    const { m, timers, events, taps } = machine()
    expect(m.input(key('keyDown', 'Tab', { control: true }))).toBe(true)
    timers.advance(RECENT_TABS_HOLD_MS - 50)
    m.input(key('keyUp', 'Control'))
    expect(taps).toEqual([1])
    expect(events).toEqual([])
    expect(m.switcher).toBe('idle')
  })

  it('opens the switcher after a hold, steps on Tab, and commits on release', () => {
    const { m, timers, events, taps } = machine()
    m.input(key('keyDown', 'Tab', { control: true }))
    timers.advance(RECENT_TABS_HOLD_MS)
    m.input(key('keyDown', 'Tab', { control: true }))
    m.input(key('keyDown', 'Tab', { control: true, shift: true }))
    m.input(key('keyUp', 'Control'))
    expect(events).toEqual([
      { type: 'recent-tabs', phase: 'open', delta: 1 },
      { type: 'recent-tabs', phase: 'step', delta: 1 },
      { type: 'recent-tabs', phase: 'step', delta: -1 },
      { type: 'recent-tabs', phase: 'commit', delta: 1 },
    ])
    expect(taps).toEqual([])
  })

  it('opens at once on a second Tab within the hold time, and Esc cancels', () => {
    const { m, events } = machine()
    m.input(key('keyDown', 'Tab', { control: true }))
    m.input(key('keyDown', 'Tab', { control: true }))
    expect(m.input(key('keyDown', 'Escape', { control: true }))).toBe(true)
    expect(events).toEqual([
      { type: 'recent-tabs', phase: 'open', delta: 1 },
      { type: 'recent-tabs', phase: 'step', delta: 1 },
      { type: 'recent-tabs', phase: 'cancel', delta: 1 },
    ])
  })

  it('cancels an open switcher when the window loses focus; ⌃⇧Tab taps step back', () => {
    const { m, timers, events, taps } = machine()
    m.input(key('keyDown', 'Tab', { control: true }))
    timers.advance(RECENT_TABS_HOLD_MS)
    m.blur()
    expect(events.at(-1)).toEqual({ type: 'recent-tabs', phase: 'cancel', delta: 1 })
    m.input(key('keyDown', 'Tab', { control: true, shift: true }))
    m.input(key('keyUp', 'Control', { shift: true }))
    expect(taps).toEqual([-1])
  })
})

describe('edge reveal', () => {
  const content = { x: 100, y: 50, width: 800, height: 600 }
  it('activates at the left edge and stays while the pointer is over the revealed band', () => {
    expect(edgeActive({ x: 100 + EDGE_ZONE_PX, y: 300 }, content, false, 260)).toBe(true)
    expect(edgeActive({ x: 100 + EDGE_ZONE_PX + 1, y: 300 }, content, false, 260)).toBe(false)
    expect(edgeActive({ x: 300, y: 300 }, content, true, 260)).toBe(true)
    expect(edgeActive({ x: 400, y: 300 }, content, true, 260)).toBe(false)
    expect(edgeActive({ x: 101, y: 10 }, content, false, 260)).toBe(false)
    expect(edgeActive({ x: 100 - EDGE_OUTSIDE_PX - 1, y: 300 }, content, true, 260)).toBe(false)
  })

  it('also reveals from just outside a window short of the screen edge, where the pointer stops', () => {
    // A window 15 px from the screen's left edge: the pointer pushed left stops at x = 0.
    const window15 = { x: 15, y: 33, width: 1440, height: 900 }
    expect(edgeActive({ x: 0, y: 400 }, window15, false, 276)).toBe(true)
    expect(edgeActive({ x: 0, y: 400 }, window15, true, 276)).toBe(true)
    expect(edgeActive({ x: 100 - EDGE_OUTSIDE_PX, y: 300 }, content, false, 260)).toBe(true)
    expect(edgeActive({ x: 100 - EDGE_OUTSIDE_PX - 1, y: 300 }, content, false, 260)).toBe(false)
  })

  it('polls only while asked, and emits on changes only', () => {
    let cursor = { x: 500, y: 300 }
    const emitted: boolean[] = []
    let ticks: (() => void) | null = null
    const poller = new EdgeRevealPoller({
      cursor: () => cursor,
      content: () => content,
      exitWidth: () => 260,
      emit: (a) => emitted.push(a),
      every: (fn) => {
        ticks = fn
        return () => {
          ticks = null
        }
      },
    })
    expect(poller.polling).toBe(false)
    poller.setPolling(true)
    ticks!()
    cursor = { x: 102, y: 300 }
    ticks!()
    ticks!()
    expect(emitted).toEqual([true])
    poller.setPolling(false)
    expect(ticks).toBeNull()
    expect(emitted).toEqual([true, false])
  })

  it('asks again when the pointer comes back to the edge without leaving the band', () => {
    let cursor = { x: 102, y: 300 }
    const emitted: boolean[] = []
    let ticks: (() => void) | null = null
    const poller = new EdgeRevealPoller({
      cursor: () => cursor,
      content: () => content,
      exitWidth: () => 260,
      emit: (a) => emitted.push(a),
      every: (fn) => {
        ticks = fn
        return () => undefined
      },
    })
    poller.setPolling(true)
    ticks!()
    // Just past the sidebar (still in the band): the reveal went, main still counts it active.
    cursor = { x: 350, y: 300 }
    ticks!()
    expect(emitted).toEqual([true])
    cursor = { x: 101, y: 300 }
    ticks!()
    ticks!()
    expect(emitted).toEqual([true, true])
  })
})

describe('the shortcut router', () => {
  const ctx = (c: Partial<RouteContext> = {}): RouteContext => ({ source: 'page', platform: 'darwin', website: true, agentControlled: false, ...c })

  it('sends overridesPage keys to the browser even from a page', () => {
    expect(routeShortcut(key('keyDown', 't', { meta: true }, 'KeyT'), ctx())).toEqual({ kind: 'run', id: 'new-tab' })
    expect(routeShortcut(key('keyDown', 'l', { meta: true }, 'KeyL'), ctx())).toEqual({ kind: 'run', id: 'focus-address' })
    expect(routeShortcut(key('keyDown', 'Tab', { control: true }, 'Tab'), ctx())).toEqual({ kind: 'run', id: 'next-tab' })
    expect(routeShortcut(key('keyDown', '+', { meta: true, shift: true }, 'Equal'), ctx())).toEqual({ kind: 'run', id: 'zoom-in' })
    expect(routeShortcut(key('keyDown', '=', { meta: true }, 'Equal'), ctx())).toEqual({ kind: 'run', id: 'zoom-in-equal' })
  })

  it('lets the page (and text fields) have every other key first', () => {
    expect(routeShortcut(key('keyDown', 'f', { meta: true }, 'KeyF'), ctx())).toEqual({ kind: 'pass' })
    expect(routeShortcut(key('keyDown', 'ArrowLeft', { meta: true }, 'ArrowLeft'), ctx())).toEqual({ kind: 'pass' })
    expect(routeShortcut(key('keyDown', 'a', {}, 'KeyA'), ctx())).toEqual({ kind: 'pass' })
    expect(routeShortcut(key('keyUp', 't', { meta: true }, 'KeyT'), ctx())).toEqual({ kind: 'pass' })
  })

  it('holds reload, back and close on an agent-controlled tab', () => {
    const agent = ctx({ agentControlled: true })
    expect(routeShortcut(key('keyDown', 'r', { meta: true }, 'KeyR'), agent)).toEqual({ kind: 'wait', id: 'reload' })
    expect(routeShortcut(key('keyDown', 'w', { meta: true }, 'KeyW'), agent)).toEqual({ kind: 'wait', id: 'close-tab' })
    expect(routeShortcut(key('keyDown', '[', { meta: true }, 'BracketLeft'), agent)).toEqual({ kind: 'wait', id: 'back' })
    expect(routeShortcut(key('keyDown', 't', { meta: true }, 'KeyT'), agent)).toEqual({ kind: 'run', id: 'new-tab' })
    expect(routeShortcut(key('keyDown', 'r', { meta: true }, 'KeyR'), ctx({ source: 'chrome', agentControlled: true }))).toEqual({ kind: 'wait', id: 'reload' })
  })

  it('skips website-only keys on chrome-drawn pages', () => {
    expect(routeShortcut(key('keyDown', 'ArrowLeft', { meta: true }, 'ArrowLeft'), ctx({ website: false, agentControlled: true }))).toEqual({ kind: 'pass' })
    expect(routeShortcut(key('keyDown', 'ArrowLeft', { meta: true }, 'ArrowLeft'), ctx({ agentControlled: true }))).toEqual({ kind: 'wait', id: 'back-arrow' })
  })

  it('matches shifted punctuation on the physical key and uses Ctrl elsewhere', () => {
    expect(matchShortcut(key('keyDown', '}', { meta: true, shift: true }, 'BracketRight'), 'darwin')?.id).toBe('next-entry-bracket')
    expect(inputAccelerators(key('keyDown', 't', { control: true }, 'KeyT'), 'win32')).toContain('ctrl+t')
    expect(matchShortcut(key('keyDown', 't', { control: true }, 'KeyT'), 'win32')?.id).toBe('new-tab')
    expect(matchShortcut(key('keyDown', 'F11', {}, 'F11'), 'linux')?.id).toBe('toggle-fullscreen')
  })

  it('finds every table row from its own keys on each platform, and never a hold', () => {
    for (const platform of ['darwin', 'win32']) {
      for (const def of SHORTCUTS) {
        const keys = platform === 'darwin' ? def.keys.mac : def.keys.other
        if (keys.startsWith(HOLD_PREFIX)) continue
        const parts = keys.split('+')
        const last = parts.pop() ?? ''
        const mods = new Set(parts.map((p) => p.toLowerCase()))
        const named: Record<string, string> = { Left: 'ArrowLeft', Right: 'ArrowRight', Plus: '+', Backspace: 'Backspace', Escape: 'Escape', Tab: 'Tab', PageUp: 'PageUp', PageDown: 'PageDown' }
        const typed = named[last] ?? (last.length === 1 ? last.toLowerCase() : last)
        const input = key('keyDown', typed, { meta: mods.has('cmd'), control: mods.has('ctrl'), alt: mods.has('alt'), shift: mods.has('shift') || last === 'Plus' })
        expect(matchShortcut(input, platform)?.id, `${platform} ${keys}`).toBe(def.id)
      }
    }
    expect(SHORTCUTS.filter((s) => s.accelerator.startsWith(HOLD_PREFIX)).every((s) => formatKeys(s, 'darwin').length > 0)).toBe(true)
  })
})

describe('interceptors and command intercepts', () => {
  it('run interceptors before the table, stopping at handled', () => {
    const order: string[] = []
    const offA = shortcuts.addInputInterceptor(() => (order.push('low'), 'pass'), { priority: 1 })
    const offB = shortcuts.addInputInterceptor(() => (order.push('high'), 'handled'), { priority: 5 })
    expect(shortcuts.intercept(key('keyDown', 't', { meta: true }) as never, {} as never, null)).toBe(true)
    expect(order).toEqual(['high'])
    offA()
    offB()
    expect(shortcuts.intercept(key('keyDown', 't', { meta: true }) as never, {} as never, null)).toBe(false)
  })

  it('lets the last matching intercept take a command over', async () => {
    const reg = new CommandRegistry()
    const ran: string[] = []
    reg.register('close-tab', () => void ran.push('command'))
    const off = reg.intercept('close-tab', { when: () => true, run: () => void ran.push('order') })
    await reg.run('close-tab', null)
    off()
    await reg.run('close-tab', null)
    expect(ran).toEqual(['order', 'command'])
  })
})
