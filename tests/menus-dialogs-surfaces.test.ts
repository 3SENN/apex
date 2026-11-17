/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

// The renderer modules read window.atelier when they load.
vi.hoisted(() => {
  const g = globalThis as { window?: unknown }
  g.window ??= { atelier: { invoke: () => Promise.resolve(), onAppEvent: () => () => undefined, overlay: {}, initial: {} } }
})

import type { ZodType } from 'zod'

// The surface modules are renderer code (TSX), outside the node project's
// type graph, so they load by a computed path.
interface Module {
  props: ZodType<unknown>
  policy: Record<string, unknown>
}
const MENUS = '../src/renderer/src/overlay/surfaces/menus'
const { MENUS_SURFACE_MAP } = (await import(/* @vite-ignore */ MENUS)) as { MENUS_SURFACE_MAP: Record<string, Module | undefined> }

// The menu overlay surfaces: registered, with props checked at open.

const area = { x: 0, y: 0, width: 800, height: 600 }
const parse = (id: string, props: unknown): boolean => MENUS_SURFACE_MAP[id]!.props.safeParse(props).success

describe('menu surfaces', () => {
  it('registers the toast, dialog, QR code and task manager', () => {
    for (const id of ['toast', 'dialog', 'qr-code', 'task-manager'] as const) expect(MENUS_SURFACE_MAP[id]).toBeDefined()
    expect(MENUS_SURFACE_MAP['toast']!.policy).toMatchObject({ focus: false, onTabSwitch: 'close', outsideClick: 'ignore' })
    expect(MENUS_SURFACE_MAP['dialog']!.policy).toMatchObject({ layer: 'modal', size: 'fill-tab', onTabSwitch: 'hide-until-return' })
    expect(MENUS_SURFACE_MAP['task-manager']!.policy['layer']).toBe('modal')
  })

  it('checks dialog props', () => {
    const spec = { title: 'Delete?', buttons: [{ id: 'ok', label: 'OK', style: 'primary', enter: true }] }
    expect(parse('dialog', { spec, scope: 'window', area })).toBe(true)
    expect(parse('dialog', { spec: { ...spec, buttons: [] }, scope: 'window', area })).toBe(false)
    expect(parse('dialog', { spec: { ...spec, buttons: [{ id: 'x', label: 'X', style: 'blink' }] }, scope: 'tab', area })).toBe(false)
    expect(parse('dialog', { spec, scope: 'window', area, extra: 1 })).toBe(false)
  })

  it('checks toast, QR and task manager props', () => {
    expect(parse('toast', { toast: { id: 't', kind: 'success', text: 'Copied' }, area })).toBe(true)
    expect(parse('toast', { toast: { id: 't', kind: 'warning', text: 'Copied' }, area })).toBe(false)
    expect(parse('qr-code', { url: 'https://a.test', title: 'A', svg: 'data:image/svg+xml;base64,AAAA', area })).toBe(true)
    expect(parse('qr-code', { url: 'https://a.test', title: 'A', svg: 'javascript:alert(1)', area })).toBe(false)
    expect(parse('task-manager', { area })).toBe(true)
    expect(parse('task-manager', {})).toBe(false)
  })
})
