/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { FLOAT_KINDS, FLOAT_METHODS, FLOAT_SPECS, floatMayCall, type FloatKind } from '../src/shared/float'
import { checkFloatAccess, parseFloatMethod } from '../src/main/float/access'
import { anchorRect, clampSize, clampToWorkArea, pickDisplay, placeFloat, rememberPosition } from '../src/main/float/placement'

const area = { x: 0, y: 25, width: 1470, height: 900 }
const display = { id: 1, workArea: area }

describe('float placement', () => {
  it('centres the launcher and HUD at the bottom, inside the work area', () => {
    const r = anchorRect({ width: 560, height: 120 }, area, 'bottom-center', 96)
    expect(r).toEqual({ x: 455, y: 25 + 900 - 96 - 120, width: 560, height: 120 })
  })

  it('puts the meeting card bottom right and the widget on the right edge', () => {
    expect(anchorRect({ width: 360, height: 150 }, area, 'bottom-right', 16)).toMatchObject({ x: 1470 - 16 - 360, y: 25 + 900 - 16 - 150 })
    const widget = anchorRect({ width: 220, height: 48 }, area, 'right-edge', 16)
    expect(widget.x).toBe(1470 - 16 - 220)
    expect(widget.y).toBeGreaterThan(area.y)
    expect(widget.y + widget.height).toBeLessThan(area.y + area.height)
  })

  it('clamps to the work area, including negative coordinates on a left display', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1050 }
    expect(clampToWorkArea({ x: -2500, y: -40, width: 400, height: 100 }, left)).toEqual({ x: -1920, y: 0, width: 400, height: 100 })
    expect(clampToWorkArea({ x: 100, y: 2000, width: 400, height: 100 }, left)).toEqual({ x: -400, y: 950, width: 400, height: 100 })
    // Larger than the area: shrunk to fit.
    expect(clampToWorkArea({ x: 0, y: 0, width: 5000, height: 5000 }, area)).toEqual(area)
  })

  it('remembers the dragged widget by edge and height and places it there again', () => {
    const remembered = rememberPosition({ x: 20, y: 25 + 426, width: 220, height: 48 }, display)
    expect(remembered).toEqual({ displayId: 1, edge: 'left', yFraction: 0.5 })
    expect(placeFloat({ width: 220, height: 48 }, display, 'right-edge', 16, remembered)).toEqual({ x: 16, y: 25 + 426, width: 220, height: 48 })
  })

  it('falls back to the preferred display when the remembered one is gone', () => {
    const other = { id: 2, workArea: { x: 1470, y: 0, width: 1000, height: 800 } }
    expect(pickDisplay([display, other], display, { displayId: 2, edge: 'right', yFraction: 0 })).toBe(other)
    expect(pickDisplay([display], display, { displayId: 2, edge: 'right', yFraction: 0 })).toBe(display)
  })

  it('keeps requested sizes between the base size and the kind maximum', () => {
    const spec = FLOAT_SPECS.recording
    expect(clampSize({ width: 1000, height: 1000 }, spec, spec.max)).toEqual(spec.max)
    expect(clampSize({ width: 10, height: 10 }, spec, spec.max)).toEqual({ width: 220, height: 32 })
    expect(clampSize({ width: Number.NaN, height: 60 }, spec, spec.max)).toEqual({ width: 220, height: 60 })
  })
})

describe('float access', () => {
  const owners = new Map<number, FloatKind>([
    [10, 'voice-hud'],
    [11, 'recording'],
  ])

  it('lets a float call only the methods its kind lists', () => {
    expect(checkFloatAccess(owners, { senderId: 10, mainFrame: true }, 'voice.hudAction')).toEqual({ ok: true, kind: 'voice-hud' })
    expect(checkFloatAccess(owners, { senderId: 10, mainFrame: true }, 'meetingCapture.stop')).toMatchObject({ ok: false })
    expect(checkFloatAccess(owners, { senderId: 11, mainFrame: true }, 'meetingCapture.stop')).toMatchObject({ ok: true })
    expect(checkFloatAccess(owners, { senderId: 11, mainFrame: true }, 'passwords.reveal')).toMatchObject({ ok: false })
  })

  it('rejects other windows, subframes and junk method names', () => {
    expect(checkFloatAccess(owners, { senderId: 99, mainFrame: true }, 'voice.status')).toEqual({ ok: false, error: 'Rejected IPC from an untrusted sender.' })
    expect(checkFloatAccess(owners, { senderId: 10, mainFrame: false }, 'voice.status')).toMatchObject({ ok: false })
    expect(checkFloatAccess(owners, { senderId: 10, mainFrame: true }, 42)).toMatchObject({ ok: false })
    expect(checkFloatAccess(owners, { senderId: 10, mainFrame: true }, 'x'.repeat(200))).toMatchObject({ ok: false })
  })

  it('never lists a vault, wallet or chat method for any float', () => {
    for (const kind of FLOAT_KINDS) {
      for (const method of FLOAT_METHODS[kind]) expect(method).not.toMatch(/^(passwords|wallet|chats|settings|autofill)\./)
      expect(floatMayCall(kind, 'passwords.reveal')).toBe(false)
    }
  })

  it('splits service calls from kind-local actions', () => {
    expect(parseFloatMethod('voice.status')).toEqual({ kind: 'service', service: 'voice', method: 'status' })
    expect(parseFloatMethod('card:action')).toEqual({ kind: 'local', name: 'card:action' })
  })
})
