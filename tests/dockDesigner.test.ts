/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_DOCK_DESIGN, DOCK_SWATCHES, clampDockDesign, dockBackgroundHex, dockDesignKey, resetDockHandle, serializeDockDesign } from '@shared/onboarding'
import { CommandRegistry, setCommandFailureCue } from '../src/main/commands'
import { createDockIconService } from '../src/main/dockIcon'

describe('Dock design clamping', () => {
  it('clamps every value into its range and repairs bad input', () => {
    const d = clampDockDesign({ offset: { x: 3, y: -3 }, rotate: 900, turn: -100, scale: 9, gaze: { x: 2, y: NaN }, smile: 'yes', background: { kind: 'custom', hex: '#ABCDEF' } })
    expect(d.offset).toEqual({ x: 0.5, y: -0.5 })
    expect(d.rotate).toBe(180)
    expect(d.turn).toBe(-60)
    expect(d.scale).toBe(1.6)
    expect(d.gaze).toEqual({ x: 1, y: 0 })
    expect(d.smile).toBe(false)
    expect(d.background).toEqual({ kind: 'custom', hex: '#abcdef' })
    expect(clampDockDesign(null)).toEqual(DEFAULT_DOCK_DESIGN)
    expect(clampDockDesign({ background: { kind: 'swatch', id: 'unknown' } }).background).toEqual({ kind: 'match' })
    expect(clampDockDesign({ background: { kind: 'custom', hex: 'red' } }).background).toEqual({ kind: 'match' })
  })

  it('picks the background colour', () => {
    const swatch = DOCK_SWATCHES[0]!
    expect(dockBackgroundHex({ ...DEFAULT_DOCK_DESIGN, background: { kind: 'swatch', id: swatch.id } }, '#000000')).toBe(swatch.hex)
    expect(dockBackgroundHex(DEFAULT_DOCK_DESIGN, '#112233')).toBe('#112233')
  })

  it('maps the keys, with shift for bigger steps, and stays clamped', () => {
    const right = dockDesignKey(DEFAULT_DOCK_DESIGN, 'ArrowRight', false)!
    const bigRight = dockDesignKey(DEFAULT_DOCK_DESIGN, 'ArrowRight', true)!
    expect(bigRight.offset.x).toBeCloseTo(right.offset.x * 5)
    expect(dockDesignKey(DEFAULT_DOCK_DESIGN, ']', false)?.rotate).toBe(3)
    expect(dockDesignKey(DEFAULT_DOCK_DESIGN, ',', true)?.turn).toBe(-15)
    expect(dockDesignKey(DEFAULT_DOCK_DESIGN, '=', false)?.scale).toBeCloseTo(1.02)
    expect(dockDesignKey({ ...DEFAULT_DOCK_DESIGN, scale: 1.6 }, '=', true)?.scale).toBe(1.6)
    expect(dockDesignKey(DEFAULT_DOCK_DESIGN, 'q', false)).toBeNull()
    expect(resetDockHandle({ ...DEFAULT_DOCK_DESIGN, rotate: 40, turn: 9 }, 'rotate')).toMatchObject({ rotate: 0, turn: 9 })
  })

  it('serialises stably', () => {
    expect(serializeDockDesign({ ...DEFAULT_DOCK_DESIGN, rotate: 10 })).toBe(serializeDockDesign(clampDockDesign({ ...DEFAULT_DOCK_DESIGN, rotate: 10.00001 })))
    expect(serializeDockDesign(DEFAULT_DOCK_DESIGN)).not.toBe(serializeDockDesign({ ...DEFAULT_DOCK_DESIGN, smile: true }))
  })
})

describe('the Dock icon service', () => {
  it('saves, reloads, resets (keeping the companion) and applies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-dock-'))
    const set = vi.fn(() => true)
    const a = createDockIconService({ dataDir: dir, setIcon: set })
    a.save({ ...DEFAULT_DOCK_DESIGN, companionId: 'c1', rotate: 400, smile: true })
    const b = createDockIconService({ dataDir: dir, setIcon: set })
    expect(b.design()).toMatchObject({ companionId: 'c1', rotate: 180, smile: true })
    expect(b.reset()).toEqual({ ...DEFAULT_DOCK_DESIGN, companionId: 'c1' })
    expect(b.apply('data:image/png;base64,AAAA')).toBe(true)
    expect(set).toHaveBeenCalledWith('data:image/png;base64,AAAA')
    const failing = createDockIconService({ dataDir: dir, setIcon: () => { throw new Error('bad png') } })
    expect(failing.apply('data:image/png;base64,AAAA')).toBe(false)
  })

  it('ignores a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-dock-'))
    writeFileSync(join(dir, 'dock-icon.json'), 'nope')
    expect(createDockIconService({ dataDir: dir }).design()).toEqual(DEFAULT_DOCK_DESIGN)
  })
})

describe('NS-04: the failure beep', () => {
  it('plays when a command throws or reports failure, not when it works', async () => {
    const beep = vi.fn()
    const off = setCommandFailureCue(beep)
    const registry = new CommandRegistry()
    registry.register('reopen-closed', () => false)
    registry.register('new-tab', () => undefined)
    registry.register('close-tab', () => {
      throw new Error('nothing to close')
    })
    await registry.run('new-tab', null)
    expect(beep).not.toHaveBeenCalled()
    await registry.run('reopen-closed', null)
    await registry.run('close-tab', null)
    expect(beep).toHaveBeenCalledTimes(2)
    off()
    await registry.run('reopen-closed', null)
    expect(beep).toHaveBeenCalledTimes(2)
  })
})
