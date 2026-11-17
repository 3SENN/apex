/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { ChordTracker, matchesChord, readAloudHeld, tapText, type ChordTimers, type KeyInput } from '../src/main/voice/keys'
import { chordAccelerator, effectiveReadAloudModifier, freeReadAloudModifiers } from '../src/shared/voice'

function key(type: 'keyDown' | 'keyUp', k: string, mods: Partial<Pick<KeyInput, 'alt' | 'control' | 'shift' | 'meta' | 'isAutoRepeat'>> = {}): KeyInput {
  return { type, key: k, code: k === ' ' ? 'Space' : k, alt: false, control: false, shift: false, meta: false, isAutoRepeat: false, ...mods }
}
const space = (type: 'keyDown' | 'keyUp', mods: Parameters<typeof key>[2] = {}): KeyInput => key(type, ' ', mods)

function fakeTimers(): ChordTimers & { fire(): void; pending(): number } {
  const timers = new Map<number, () => void>()
  let next = 1
  return {
    set: (fn) => {
      const id = next++
      timers.set(id, fn)
      return id
    },
    clear: (h) => void timers.delete(h as number),
    fire: () => {
      const all = [...timers.values()]
      timers.clear()
      for (const fn of all) fn()
    },
    pending: () => timers.size,
  }
}

function setup() {
  const log: string[] = []
  const timers = fakeTimers()
  const tracker = new ChordTracker<string>(
    {
      start: (c, r) => log.push(`start:${c}:${r}`),
      readAloud: (c) => log.push(`read:${c}`),
      end: (c, r) => log.push(`end:${c}:${r}`),
      tap: (c) => log.push(`tap:${c}`),
    },
    timers,
  )
  const feed = (input: KeyInput) => tracker.input(input, 'alt+space', 'shift', 'wc')
  return { log, timers, tracker, feed }
}

describe('voice chord matching', () => {
  it('matches the chord with its own modifiers, plus only the read-aloud one', () => {
    expect(matchesChord(space('keyDown', { alt: true }), 'alt+space', 'shift')).toBe(true)
    expect(matchesChord(space('keyDown', { alt: true, shift: true }), 'alt+space', 'shift')).toBe(true)
    expect(matchesChord(space('keyDown', { alt: true, meta: true }), 'alt+space', 'shift')).toBe(false)
    expect(matchesChord(space('keyDown'), 'alt+space', 'shift')).toBe(false)
    expect(matchesChord(key('keyDown', 'a', { alt: true }), 'alt+space', 'shift')).toBe(false)
    expect(matchesChord(space('keyDown', { control: true, alt: true }), 'ctrl+alt+space', 'shift')).toBe(true)
    expect(matchesChord(space('keyDown', { control: true }), 'ctrl+alt+space', 'shift')).toBe(false)
  })

  it('never uses one of the chord’s own modifiers for read-aloud', () => {
    expect(freeReadAloudModifiers('alt+space')).toEqual(['shift', 'ctrl', 'cmd'])
    expect(freeReadAloudModifiers('ctrl+shift+space')).toEqual(['cmd'])
    expect(freeReadAloudModifiers('ctrl+alt+space')).toEqual(['shift', 'cmd'])
    expect(effectiveReadAloudModifier('ctrl+shift+space', 'shift')).toBe('cmd')
    expect(effectiveReadAloudModifier('ctrl+alt+space', 'ctrl')).toBe('shift')
    // With ctrl+shift held, shift no longer counts as the read-aloud key.
    expect(readAloudHeld(space('keyDown', { control: true, shift: true }), 'ctrl+shift+space', 'shift')).toBe(false)
    expect(readAloudHeld(key('keyDown', 'Meta', { meta: true }), 'ctrl+shift+space', 'shift')).toBe(true)
  })

  it('names the chord as an accelerator, and taps type a no-break space only for ⌥Space on a Mac', () => {
    expect(chordAccelerator('alt+space')).toBe('Alt+Space')
    expect(chordAccelerator('ctrl+shift+space')).toBe('Control+Shift+Space')
    expect(tapText('alt+space', 'darwin')).toBe(' ')
    expect(tapText('alt+space', 'linux')).toBe('')
    expect(tapText('ctrl+alt+space', 'darwin')).toBe('')
  })
})

describe('the hold state machine', () => {
  it('starts a turn after the hold time and ends it on key-up', () => {
    const { log, timers, tracker, feed } = setup()
    expect(feed(space('keyDown', { alt: true }))).toBe('handled')
    expect(tracker.phase).toBe('pending')
    expect(log).toEqual([])
    timers.fire()
    expect(log).toEqual(['start:wc:false'])
    // Auto-repeat while held is swallowed and starts nothing.
    expect(feed(space('keyDown', { alt: true, isAutoRepeat: true }))).toBe('handled')
    expect(feed(space('keyUp', { alt: true }))).toBe('handled')
    expect(log).toEqual(['start:wc:false', 'end:wc:false'])
    expect(tracker.phase).toBe('idle')
  })

  it('passes a short tap through as the chord’s character and opens no session', () => {
    const { log, timers, feed } = setup()
    feed(space('keyDown', { alt: true }))
    expect(feed(space('keyUp', { alt: true }))).toBe('handled')
    expect(log).toEqual(['tap:wc'])
    expect(timers.pending()).toBe(0)
  })

  it('marks the turn spoken when the read-aloud key goes down at any point', () => {
    const { log, timers, feed } = setup()
    feed(space('keyDown', { alt: true }))
    timers.fire()
    expect(feed(key('keyDown', 'Shift', { alt: true, shift: true }))).toBe('pass')
    feed(space('keyUp', { alt: true, shift: true }))
    expect(log).toEqual(['start:wc:false', 'read:wc', 'end:wc:true'])
  })

  it('starts spoken when the read-aloud key is already held', () => {
    const { log, timers, feed } = setup()
    feed(space('keyDown', { alt: true, shift: true }))
    timers.fire()
    expect(log).toEqual(['start:wc:true'])
  })

  it('ends the hold when a chord modifier is let go first, and swallows the trailing Space', () => {
    const { log, timers, tracker, feed } = setup()
    feed(space('keyDown', { alt: true }))
    timers.fire()
    expect(feed(key('keyUp', 'Alt'))).toBe('pass')
    expect(log).toEqual(['start:wc:false', 'end:wc:false'])
    expect(feed(space('keyDown', { isAutoRepeat: true }))).toBe('handled')
    expect(feed(space('keyUp'))).toBe('handled')
    expect(tracker.phase).toBe('idle')
    expect(feed(space('keyDown'))).toBe('pass')
  })

  it('ignores other keys and lets them through', () => {
    const { log, feed } = setup()
    expect(feed(key('keyDown', 'a'))).toBe('pass')
    expect(feed(space('keyDown'))).toBe('pass')
    expect(log).toEqual([])
  })

  it('on blur ends a hold but drops a pending tap', () => {
    const a = setup()
    a.feed(space('keyDown', { alt: true }))
    a.timers.fire()
    a.tracker.blur()
    expect(a.log).toEqual(['start:wc:false', 'end:wc:false'])
    const b = setup()
    b.feed(space('keyDown', { alt: true }))
    b.tracker.blur()
    expect(b.log).toEqual([])
    expect(b.timers.pending()).toBe(0)
    expect(b.tracker.phase).toBe('idle')
  })
})
