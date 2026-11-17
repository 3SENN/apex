/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// DS-94: one in-window popover serves every menu that opens from a control
// (the back and forward history list, the new-tab switcher, chat header and
// log menus, the card tabs, the sidebar rows, extensions, connectors and the
// skill editor all call showMenu). Native menus stay for context menus only.

const call = vi.fn(async () => 'native-pick')
const openInChrome = vi.fn(async () => ({ instanceId: 'chrome-1', value: 'popover-pick' }))

vi.mock('../src/renderer/src/api', () => ({ call }))
vi.mock('../src/renderer/src/overlay/kit/chromeHost', () => ({ openInChrome }))
vi.mock('../src/renderer/src/overlay/kit/PopoverMenu', () => ({
  popoverMenuSurface: { id: 'popover-menu' },
  fromSpec: (items: { id: string; label: string }[]) => items.map((i) => ({ id: i.id, label: i.label })),
}))

class FakeElement {
  attrs = new Map<string, string>()
  textContent: string | null = null
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; bottom: number } {
    return { left: 10, top: 20, width: 30, height: 28, bottom: 48 }
  }
  focus(): void {}
}
class FakeHTMLElement extends FakeElement {}
class FakeSVGElement extends FakeElement {}

// Loaded by a path tsc doesn't follow: the menu module pulls in TSX, which this project's test typecheck doesn't compile.
interface MenuModule {
  showMenu(items: unknown[], anchor: unknown): Promise<string | null>
  showContextMenu(event: { clientX: number; clientY: number; currentTarget?: unknown; preventDefault(): void }, items: unknown[]): Promise<string | null>
  menuLabel(anchor: unknown): string
}
const MENU_MODULE: string = '../src/renderer/src/ui/menu'
const load = (): Promise<MenuModule> => import(MENU_MODULE) as Promise<MenuModule>

const items = [
  { id: 'back-1', label: 'Earlier page' },
  { id: 'back-2', label: 'Earliest page' },
]

beforeEach(() => {
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('HTMLElement', FakeHTMLElement)
  vi.stubGlobal('window', { innerHeight: 800 })
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  call.mockClear()
  openInChrome.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('showMenu', () => {
  it('opens the in-window popover under a control, not a native menu', async () => {
    const { showMenu } = await load()
    const button = new FakeHTMLElement()
    button.setAttribute('aria-label', 'History')
    expect(await showMenu(items, button)).toBe('popover-pick')
    expect(call).not.toHaveBeenCalled()
    expect(openInChrome).toHaveBeenCalledTimes(1)
    const [surface, props, anchor, options] = openInChrome.mock.calls[0] as unknown as [{ id: string }, { label: string; items: unknown[]; side: string }, { kind: string; rect: unknown }, { anchorEl: unknown }]
    expect(surface.id).toBe('popover-menu')
    expect(props.label).toBe('History')
    expect(props.items).toHaveLength(2)
    expect(props.side).toBe('below')
    expect(anchor).toEqual({ kind: 'window', rect: { x: 10, y: 20, width: 30, height: 28 } })
    expect(options.anchorEl).toBe(button)
  })

  it('resolves null when the popover is dismissed', async () => {
    const { showMenu } = await load()
    openInChrome.mockResolvedValueOnce({ instanceId: 'chrome-2', dismissed: 'outside' } as never)
    expect(await showMenu(items, new FakeHTMLElement())).toBeNull()
  })

  it('keeps a native menu at a point, and for a non-HTML anchor', async () => {
    const { showMenu } = await load()
    expect(await showMenu(items, { x: 40.4, y: 60.6 })).toBe('native-pick')
    expect(call).toHaveBeenLastCalledWith('menu', 'popup', items, 40, 61)
    await showMenu(items, new FakeSVGElement())
    expect(call).toHaveBeenLastCalledWith('menu', 'popup', items, 10, 52)
    expect(openInChrome).not.toHaveBeenCalled()
  })
})

describe('showContextMenu', () => {
  it('stays native, even when opened from the keyboard on a control', async () => {
    const { showContextMenu } = await load()
    const row = new FakeHTMLElement()
    const preventDefault = vi.fn()
    await showContextMenu({ clientX: 0, clientY: 0, currentTarget: row, preventDefault }, items)
    expect(preventDefault).toHaveBeenCalled()
    expect(call).toHaveBeenLastCalledWith('menu', 'popup', items, 10, 52)
    await showContextMenu({ clientX: 5, clientY: 7, preventDefault }, items)
    expect(call).toHaveBeenLastCalledWith('menu', 'popup', items, 5, 7)
    expect(openInChrome).not.toHaveBeenCalled()
  })
})

describe('menuLabel', () => {
  it('names the menu after its control, with a fallback', async () => {
    const { menuLabel } = await load()
    const el = new FakeHTMLElement()
    el.textContent = '  Team\n notes '
    expect(menuLabel(el)).toBe('Team notes')
    el.setAttribute('title', 'Space options')
    expect(menuLabel(el)).toBe('Space options')
    expect(menuLabel(new FakeHTMLElement())).toBe('More options')
  })
})
