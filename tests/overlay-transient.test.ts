/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import type { SurfaceId, SurfacePolicy } from '@shared/overlay'
import { OverlayState, defaultPolicy, isTransient, isWindowModal } from '../src/main/overlayState'

// The renderer modules read window.apex when they load.
vi.hoisted(() => {
  const g = globalThis as { window?: unknown }
  g.window ??= { apex: { invoke: () => Promise.resolve(), onAppEvent: () => () => undefined, overlay: {}, initial: {} } }
})

// The update surfaces are renderer code (TSX), outside the node project's type graph, so they load by a computed path.
const UPDATES = '../src/renderer/src/overlay/surfaces/updates'
const { UPDATES_SURFACE_MAP } = (await import(/* @vite-ignore */ UPDATES)) as { UPDATES_SURFACE_MAP: Record<string, { policy: SurfacePolicy } | undefined> }

// Popovers of different kinds don't stack (a-menus-main-menu, a-sites-info-dark):
// the newest transient popover wins, a window modal clears the popovers under
// it, and a popover can't open over a window modal.

const MENU: SurfacePolicy = { ...defaultPolicy('command-bar'), layer: 'menu', outsideClick: 'close' }
const CASCADE: SurfacePolicy = { ...MENU, size: 'fill-window' }
const WINDOW_MODAL: SurfacePolicy = { ...MENU, size: 'fill-window', outsideClick: 'ignore', blocksPage: true, layer: 'modal', onTabSwitch: 'stay' }
const TAB_MODAL: SurfacePolicy = { ...WINDOW_MODAL, size: 'fill-tab', onTabSwitch: 'hide-until-return' }
const TOAST: SurfacePolicy = { ...MENU, outsideClick: 'ignore', layer: 'hint', focus: false }
const FIND_BAR: SurfacePolicy = { ...MENU, outsideClick: 'ignore', onTabSwitch: 'hide-until-return' }

const anchor = { kind: 'window' as const, rect: { x: 0, y: 0, width: 10, height: 10 } }

function open(s: OverlayState, id: string, surface: SurfaceId): void {
  s.add({ id, surface, anchor, props: {} })
}

describe('transient popovers', () => {
  it('classifies policies', () => {
    expect(isTransient(MENU)).toBe(true)
    expect(isTransient(CASCADE)).toBe(true)
    expect(isTransient({ ...MENU, layer: 'modal' })).toBe(true) // universal search, recent tabs
    expect(isTransient(TOAST)).toBe(false)
    expect(isTransient(FIND_BAR)).toBe(false)
    expect(isWindowModal(WINDOW_MODAL)).toBe(true)
    expect(isWindowModal({ ...WINDOW_MODAL, size: 'fixed' })).toBe(true)
    expect(isWindowModal(TAB_MODAL)).toBe(false)
  })

  it('the main menu dismisses the downloads popover', () => {
    const s = new OverlayState()
    open(s, 'dl', 'downloads')
    expect(s.mounted('dl', MENU)).toEqual([])
    open(s, 'menu', 'main-menu')
    expect(s.mounted('menu', CASCADE)).toEqual(['dl'])
  })

  it('the command bar dismisses site info', () => {
    const s = new OverlayState()
    open(s, 'info', 'site-info')
    s.mounted('info', MENU)
    open(s, 'bar', 'command-bar')
    expect(s.mounted('bar', MENU)).toEqual(['info'])
  })

  it('the newest wins when an older popover mounts late', () => {
    const s = new OverlayState()
    open(s, 'old', 'site-info')
    open(s, 'new', 'command-bar')
    expect(s.mounted('new', MENU)).toEqual([])
    expect(s.mounted('old', MENU)).toEqual(['old'])
  })

  it('a popover cannot open over a window modal; a window modal clears popovers', () => {
    const s = new OverlayState()
    open(s, 'menu', 'main-menu')
    s.mounted('menu', CASCADE)
    open(s, 'clear', 'clear-data')
    expect(s.mounted('clear', WINDOW_MODAL)).toEqual(['menu'])
    s.beginClose('menu')
    open(s, 'menu2', 'main-menu')
    expect(s.mounted('menu2', CASCADE)).toEqual(['menu2'])
  })

  it('leaves toasts, bars, tab dialogs and closing instances alone', () => {
    const s = new OverlayState()
    open(s, 'toast', 'toast')
    s.mounted('toast', TOAST)
    open(s, 'find', 'find-bar')
    s.mounted('find', FIND_BAR)
    open(s, 'alert', 'dialog')
    s.mounted('alert', TAB_MODAL)
    open(s, 'gone', 'site-info')
    s.mounted('gone', MENU)
    s.beginClose('gone')
    open(s, 'menu', 'main-menu')
    expect(s.mounted('menu', CASCADE)).toEqual([])
    open(s, 'toast2', 'toast')
    expect(s.mounted('toast2', TOAST)).toEqual([])
  })
})

describe("what's new beside other surfaces", () => {
  const card = UPDATES_SURFACE_MAP['whats-new']!.policy

  it('is a corner card, not a dialog: it takes no focus and hides nothing', () => {
    expect(isWindowModal(card)).toBe(false)
    expect(isTransient(card)).toBe(false)
    expect(card).toMatchObject({ focus: false, blocksPage: false, outsideClick: 'ignore', onTabSwitch: 'stay' })
  })

  it('a popover opens beside it and stays open', () => {
    const s = new OverlayState()
    open(s, 'news', 'whats-new')
    expect(s.mounted('news', card)).toEqual([])
    expect(s.focusOwner()).toBeNull()
    open(s, 'dl', 'downloads')
    expect(s.mounted('dl', MENU)).toEqual([])
    expect(s.open().map((i) => i.id)).toEqual(['news', 'dl'])
    expect(s.modalOpen()).toBe(false)
    expect(s.focusOwner()?.id).toBe('dl')
  })
})
