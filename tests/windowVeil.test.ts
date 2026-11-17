/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { SurfacePolicy } from '@shared/overlay'
import { OverlayState } from '../src/main/overlayState'

// A whole-window dialog veils the chrome while it is open, and the
// veil lifts as soon as the dialog starts closing (the chrome's blur eases out
// with the dialog's exit).

const MODAL: SurfacePolicy = { tier: 'interactive', size: 'fill-window', outsideClick: 'ignore', blocksPage: true, onTabSwitch: 'stay', layer: 'modal', focus: true, exitMs: 160 }
const anchor = { kind: 'window' as const, rect: { x: 0, y: 0, width: 0, height: 0 } }

describe('window veil', () => {
  it('is off until a veiling surface has mounted', () => {
    const s = new OverlayState()
    s.add({ id: 'r', surface: 'problem-report', anchor, props: {} })
    expect(s.veiled()).toBe(false)
    s.mounted('r', { ...MODAL, veil: true })
    expect(s.veiled()).toBe(true)
  })

  it('stays off for plain modals', () => {
    const s = new OverlayState()
    s.add({ id: 'd', surface: 'dialog', anchor, props: {} })
    s.mounted('d', MODAL)
    expect(s.veiled()).toBe(false)
  })

  it('lifts when the dialog starts closing or hides', () => {
    const s = new OverlayState()
    s.add({ id: 'r', surface: 'problem-report', anchor, props: {} })
    s.mounted('r', { ...MODAL, veil: true })
    s.setHidden('r', true)
    expect(s.veiled()).toBe(false)
    s.setHidden('r', false)
    expect(s.veiled()).toBe(true)
    s.beginClose('r')
    expect(s.veiled()).toBe(false)
  })
})
