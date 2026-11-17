/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { SurfacePolicy } from '@shared/overlay'
import { EXIT_SAFETY_MS, clipRect, compareStacking, exitDuration, placeSurface, resolveAnchorRect, toCssPx, toWindowPx, unionRect, zIndexFor } from '@shared/overlayLayout'
import { OverlayState, defaultPolicy } from '../src/main/overlayState'

// The overlay host rules: the policy reducer, anchor maths, stacking
// and the exit timeout. The host itself is Electron; these are its rules.

const policy = (p: Partial<SurfacePolicy>): SurfacePolicy => ({ ...defaultPolicy('command-bar'), ...p })

function stateWith(...items: { id: string; surface: Parameters<OverlayState['add']>[0]['surface']; tabId?: string; policy?: Partial<SurfacePolicy>; anchorRect?: boolean }[]): OverlayState {
  const s = new OverlayState()
  for (const it of items) {
    const anchor = it.tabId ? { kind: 'tab' as const, tabId: it.tabId, rect: it.anchorRect ? { x: 10, y: 20, width: 30, height: 10 } : null } : { kind: 'window' as const, rect: { x: 0, y: 0, width: 10, height: 10 } }
    s.add({ id: it.id, surface: it.surface, anchor, props: {} })
    if (it.policy) s.mounted(it.id, policy(it.policy))
  }
  return s
}

describe('the overlay policy reducer', () => {
  it('replaces an open surface with the same id, but stacks modals', () => {
    const s = stateWith({ id: 'a', surface: 'command-bar', policy: { layer: 'menu' } })
    expect(s.add({ id: 'b', surface: 'command-bar', anchor: { kind: 'point', x: 1, y: 1 }, props: {} }).replaced).toEqual(['a'])
    const m = stateWith({ id: 'd1', surface: 'dialog', policy: { layer: 'modal' } })
    expect(m.add({ id: 'd2', surface: 'dialog', anchor: { kind: 'point', x: 0, y: 0 }, props: {} }).replaced).toEqual([])
  })

  it('answers a tab switch per policy: close, stay, follow and hide-until-return', () => {
    const s = stateWith(
      { id: 'close', surface: 'command-bar', tabId: 't1', policy: { onTabSwitch: 'close' } },
      { id: 'stay', surface: 'downloads', tabId: 't1', policy: { onTabSwitch: 'stay' } },
      { id: 'follow', surface: 'find-bar', tabId: 't1', policy: { onTabSwitch: 'follow' } },
      { id: 'hide', surface: 'permission-prompt', tabId: 't1', policy: { onTabSwitch: 'hide-until-return' } },
    )
    const effects = s.tabSwitched('t2', ['t2'])
    expect(effects).toContainEqual({ kind: 'close', id: 'close', reason: 'tab-switch' })
    expect(effects.some((e) => e.id === 'stay')).toBe(false)
    expect(effects).toContainEqual(expect.objectContaining({ kind: 'reanchor', id: 'follow' }))
    expect(s.get('follow')?.tabId).toBe('t2')
    expect(effects).toContainEqual({ kind: 'hide', id: 'hide' })
    s.setHidden('hide', true)
    expect(s.tabSwitched('t1', ['t1'])).toContainEqual({ kind: 'show', id: 'hide' })
  })

  it('keeps a closing surface of a split pane that is still showing', () => {
    const s = stateWith({ id: 'a', surface: 'command-bar', tabId: 't1', policy: { onTabSwitch: 'close' } })
    expect(s.tabSwitched('t2', ['t1', 't2'])).toEqual([])
  })

  it('follows or closes page-anchored surfaces on scroll', () => {
    const s = stateWith(
      { id: 'follow', surface: 'link-preview', tabId: 't1', anchorRect: true, policy: { onScroll: 'follow' } },
      { id: 'close', surface: 'selection-chip', tabId: 't1', anchorRect: true, policy: { onScroll: 'close' } },
    )
    expect(s.scrolled('t1', 0, 0)).toEqual([])
    const effects = s.scrolled('t1', 0, 15)
    expect(effects).toContainEqual({ kind: 'close', id: 'close', reason: 'outside' })
    const moved = effects.find((e) => e.id === 'follow')
    expect(moved && moved.kind === 'reanchor' && moved.anchor.kind === 'tab' ? moved.anchor.rect?.y : null).toBe(5)
    expect(s.scrolled('t9', 0, 15)).toEqual([])
  })

  it('closes interactive surfaces on an outside press unless they ignore it', () => {
    const s = stateWith(
      { id: 'menu', surface: 'command-bar', policy: { outsideClick: 'close' } },
      { id: 'sheet', surface: 'shortcuts-sheet', policy: { outsideClick: 'ignore', layer: 'modal' } },
      { id: 'tip', surface: 'tooltip', policy: { tier: 'passive', outsideClick: 'close' } },
    )
    expect(s.outsidePress()).toEqual([{ kind: 'close', id: 'menu', reason: 'outside' }])
  })

  it('sizes the interactive view to the union of what is drawn, or the window for fill-window', () => {
    const s = stateWith({ id: 'a', surface: 'command-bar', policy: {} }, { id: 'b', surface: 'downloads', policy: {} })
    const viewport = { x: 0, y: 0, width: 800, height: 600 }
    expect(s.interactiveUnion(viewport)).toBeNull()
    s.setRect('a', { x: 10, y: 10, width: 100, height: 50 })
    s.setRect('b', { x: 300, y: 200, width: 40, height: 40 })
    expect(s.interactiveUnion(viewport)).toEqual({ x: 10, y: 10, width: 330, height: 230 })
    s.mounted('b', policy({ size: 'fill-window' }))
    expect(s.interactiveUnion(viewport)).toEqual(viewport)
  })

  it('gives focus to the newest focusable surface and reports modals and blockers', () => {
    const s = stateWith({ id: 'a', surface: 'command-bar', policy: { focus: true } }, { id: 'b', surface: 'downloads', policy: { focus: false } })
    expect(s.focusOwner()?.id).toBe('a')
    expect(s.modalOpen()).toBe(false)
    s.mounted('b', policy({ layer: 'modal', blocksPage: true, focus: true }))
    expect(s.focusOwner()?.id).toBe('b')
    expect(s.modalOpen()).toBe(true)
    expect(s.blocksPage()).toBe(true)
    s.beginClose('b')
    expect(s.focusOwner()?.id).toBe('a')
  })

  it('puts passive surfaces on the passive tier by default', () => {
    expect(defaultPolicy('tooltip').tier).toBe('passive')
    expect(defaultPolicy('tooltip').outsideClick).toBe('ignore')
    expect(defaultPolicy('dialog').tier).toBe('interactive')
  })
})

describe('anchor maths', () => {
  const pane = { x: 240, y: 52, width: 900, height: 700 }
  it('resolves window, point and tab anchors', () => {
    expect(resolveAnchorRect({ kind: 'window', rect: { x: 1, y: 2, width: 3, height: 4 } }, () => null)).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(resolveAnchorRect({ kind: 'point', x: 5, y: 6 }, () => null)).toEqual({ x: 5, y: 6, width: 0, height: 0 })
    expect(resolveAnchorRect({ kind: 'tab', tabId: 't', rect: { x: 10, y: 20, width: 30, height: 40 } }, () => pane)).toEqual({ x: 250, y: 72, width: 30, height: 40 })
    expect(resolveAnchorRect({ kind: 'tab', tabId: 't', rect: null }, () => pane)).toEqual(pane)
    expect(resolveAnchorRect({ kind: 'tab', tabId: 't', rect: null }, () => null)).toBeNull()
  })

  it('converts chrome CSS px to window px with the chrome zoom and back', () => {
    const css = { x: 10, y: 20, width: 100, height: 50 }
    expect(toWindowPx(css, 1.25)).toEqual({ x: 13, y: 25, width: 125, height: 63 })
    expect(toCssPx({ x: 25, y: 50, width: 250, height: 125 }, 1.25)).toEqual({ x: 20, y: 40, width: 200, height: 100 })
    expect(toWindowPx(css, 0)).toEqual(css)
  })

  it('places a surface inside the window, flipping when there is no room below', () => {
    const viewport = { x: 0, y: 0, width: 400, height: 300 }
    const below = placeSurface({ x: 100, y: 20, width: 40, height: 20 }, { width: 80, height: 30 }, viewport, 'below', 6)
    expect(below.y).toBe(46)
    const flipped = placeSurface({ x: 100, y: 280, width: 40, height: 16 }, { width: 80, height: 60 }, viewport, 'below', 6)
    expect(flipped.y + flipped.height).toBeLessThanOrEqual(280)
    const edge = placeSurface({ x: 390, y: 20, width: 10, height: 10 }, { width: 120, height: 30 }, viewport, 'below', 6)
    expect(edge.x + edge.width).toBeLessThanOrEqual(viewport.width)
  })

  it("puts a 'corner' surface in the window's bottom-right corner whatever its anchor, and keeps it inside", () => {
    const viewport = { x: 0, y: 0, width: 1000, height: 800 }
    const anywhere = { x: 0, y: 0, width: 640, height: 480 }
    expect(placeSurface(anywhere, { width: 380, height: 300 }, viewport, 'corner', 16)).toEqual({ x: 604, y: 484, width: 380, height: 300 })
    // A resize moves it with the window's corner.
    expect(placeSurface(anywhere, { width: 380, height: 300 }, { ...viewport, width: 1400 }, 'corner', 16).x).toBe(1004)
    // A window smaller than the card keeps its top-left edge in view.
    expect(placeSurface(anywhere, { width: 380, height: 300 }, { x: 0, y: 0, width: 300, height: 200 }, 'corner', 16)).toMatchObject({ x: 8, y: 8 })
  })

  it('unions and clips rects', () => {
    expect(unionRect([null, { x: 0, y: 0, width: 0, height: 10 }])).toBeNull()
    expect(clipRect({ x: -10, y: -10, width: 30, height: 30 }, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 20, height: 20 })
    expect(clipRect({ x: 200, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 })).toBeNull()
  })
})

describe('stacking and exits', () => {
  it('stacks modal over menu over hint, newer on top within a layer (OV-02)', () => {
    const items = [
      { id: 'modal', layer: 'modal' as const, seq: 1 },
      { id: 'hint', layer: 'hint' as const, seq: 5 },
      { id: 'menu-new', layer: 'menu' as const, seq: 4 },
      { id: 'menu-old', layer: 'menu' as const, seq: 2 },
    ]
    expect([...items].sort(compareStacking).map((i) => i.id)).toEqual(['hint', 'menu-old', 'menu-new', 'modal'])
    expect(zIndexFor('modal', 1)).toBeGreaterThan(zIndexFor('menu', 9999))
  })

  it('plays exits for their policy, instantly under reduced motion, within the safety timeout (DS-82/83)', () => {
    expect(exitDuration({ exitMs: 160 }, false)).toBe(160)
    expect(exitDuration({ exitMs: 160 }, true)).toBe(0)
    expect(exitDuration({ exitMs: 5000 }, false)).toBeLessThan(EXIT_SAFETY_MS)
    expect(exitDuration({ exitMs: -5 }, false)).toBe(0)
  })
})

describe('overlay crash recovery (SS-08)', () => {
  it('reloads a crashed tier a few times a minute, then stops', async () => {
    const { CrashBudget } = await import('../src/main/window')
    const budget = new CrashBudget(3, 60_000)
    expect([0, 1000, 2000].map((t) => budget.record(t))).toEqual([true, true, true])
    expect(budget.record(3000)).toBe(false)
    expect(budget.exhausted).toBe(true)
    // A minute later the old crashes are forgotten.
    expect(budget.record(70_000)).toBe(true)
  })
})
