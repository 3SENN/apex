/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { editCommandFor, keyEvents, modifierMask, parseKeyCombo, parseKeySequence, parseModifiers, wheelDelta } from '../src/main/input'

describe('parseKeyCombo', () => {
  it('normalizes key names and modifiers', () => {
    expect(parseKeyCombo('Enter')).toEqual({ key: 'Enter', modifiers: [] })
    expect(parseKeyCombo('Return')).toEqual({ key: 'Enter', modifiers: [] })
    expect(parseKeyCombo('ctrl+a')).toEqual({ key: 'a', modifiers: ['control'] })
    expect(parseKeyCombo('cmd+shift+T')).toEqual({ key: 'T', modifiers: ['meta', 'shift'] })
    expect(parseKeyCombo('shift+Tab')).toEqual({ key: 'Tab', modifiers: ['shift'] })
    expect(parseKeyCombo('ArrowDown')).toEqual({ key: 'Down', modifiers: [] })
    expect(parseKeyCombo('Page_Down')).toEqual({ key: 'PageDown', modifiers: [] })
    expect(parseKeyCombo('f5')).toEqual({ key: 'F5', modifiers: [] })
  })

  it('handles a literal plus key', () => {
    expect(parseKeyCombo('ctrl++')).toEqual({ key: '+', modifiers: ['control'] })
  })

  it('rejects unknown keys and modifiers', () => {
    expect(() => parseKeyCombo('hyper+a')).toThrow(/Unknown modifier/)
    expect(() => parseKeyCombo('Banana')).toThrow(/Unknown key/)
  })
})

describe('parseKeySequence', () => {
  it('splits on whitespace', () => {
    expect(parseKeySequence('ctrl+a  Delete')).toEqual([
      { key: 'a', modifiers: ['control'] },
      { key: 'Delete', modifiers: [] },
    ])
  })

  it('rejects empty input', () => {
    expect(() => parseKeySequence('   ')).toThrow()
  })
})

describe('parseModifiers', () => {
  it('parses click modifiers', () => {
    expect(parseModifiers('ctrl+shift')).toEqual(['control', 'shift'])
    expect(parseModifiers(undefined)).toEqual([])
  })
})

describe('editCommandFor', () => {
  it('maps platform edit shortcuts to webContents commands', () => {
    expect(editCommandFor({ key: 'a', modifiers: ['control'] })).toBe('selectAll')
    expect(editCommandFor({ key: 'A', modifiers: ['meta'] })).toBe('selectAll')
    expect(editCommandFor({ key: 'v', modifiers: ['meta'] })).toBe('paste')
    expect(editCommandFor({ key: 'z', modifiers: ['meta', 'shift'] })).toBe('redo')
  })

  it('leaves other keys alone', () => {
    expect(editCommandFor({ key: 'a', modifiers: [] })).toBeNull()
    expect(editCommandFor({ key: 'l', modifiers: ['control'] })).toBeNull()
    expect(editCommandFor({ key: 'a', modifiers: ['control', 'alt'] })).toBeNull()
  })
})

describe('wheelDelta', () => {
  it('uses DOM wheel convention, as CDP expects', () => {
    expect(wheelDelta('down', 3)).toEqual({ deltaX: 0, deltaY: 300 })
    expect(wheelDelta('up', 1)).toEqual({ deltaX: 0, deltaY: -100 })
    expect(wheelDelta('right', 2)).toEqual({ deltaX: 200, deltaY: 0 })
  })
})

describe('modifierMask', () => {
  it('uses CDP modifier bits', () => {
    expect(modifierMask([])).toBe(0)
    expect(modifierMask(['alt', 'control', 'meta', 'shift'])).toBe(15)
    expect(modifierMask(['shift'])).toBe(8)
  })
})

describe('keyEvents', () => {
  it('sends text with printable keys', () => {
    const [down, up] = keyEvents({ key: 'a', modifiers: [] })
    expect(down).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' })
    expect(up).toMatchObject({ type: 'keyUp', key: 'a', code: 'KeyA' })
  })

  it('uppercases shifted letters', () => {
    expect(keyEvents({ key: 'a', modifiers: ['shift'] })[0]).toMatchObject({ key: 'A', text: 'A', modifiers: 8 })
  })

  it('sends Enter as a key press with a carriage return', () => {
    expect(keyEvents({ key: 'Enter', modifiers: [] })[0]).toMatchObject({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  })

  it('sends non-text keys and chords as raw key downs', () => {
    expect(keyEvents({ key: 'Tab', modifiers: ['shift'] })[0]).toMatchObject({ type: 'rawKeyDown', key: 'Tab', modifiers: 8 })
    const selectAll = keyEvents({ key: 'a', modifiers: ['meta'] })[0]
    expect(selectAll).toMatchObject({ type: 'rawKeyDown', commands: ['selectAll'], modifiers: 4 })
    expect(selectAll).not.toHaveProperty('text')
    expect(keyEvents({ key: 'Down', modifiers: [] })[0]).toMatchObject({ key: 'ArrowDown', windowsVirtualKeyCode: 40 })
  })
})
