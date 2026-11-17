/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { SERVICE_SCHEMAS } from '../src/main/services'

describe('shell service schemas', () => {
  it('validate menus, tabs, window and pages calls', () => {
    const ok = (schema: { safeParse(v: unknown): { success: boolean } }, args: unknown[]): boolean => schema.safeParse(args).success
    expect(ok(SERVICE_SCHEMAS.menu.popup, [[{ id: 'a', label: 'A', submenu: [{ id: 'b', label: 'B', type: 'radio', checked: true }] }], 10, 20])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.menu.popup, [[], 10, 20])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.menu.popup, [[{ id: 'a', label: 'A', onClick: 'x' }], 10, 20])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.menu.popup, [[{ id: 'a', label: 'A' }], Number.NaN, 0])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.tabs.setOrder, [[{ kind: 'tab', id: 'tab-1' }, { kind: 'chat', id: 'c1' }]])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.tabs.setOrder, [[{ kind: 'group', id: 'g' }]])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.tabs.move, ['tab-1', 2])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.tabs.move, ['tab-1', -1])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.tabs.history, ['tab-1', 'sideways'])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.window.setButtonPosition, [{ x: 16, y: 18 }])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.window.setButtonPosition, [null])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.window.setButtonPosition, [{ x: 5000, y: 0 }])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.window.setName, [null])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.pages.open, ['atelier://chats'])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.pages.open, ['atelier://chat/abc', { newTab: true, background: true }])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.pages.open, ['atelier://chats', { focus: true }])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.pages.open, ['https://evil.example'])).toBe(false)
    expect(ok(SERVICE_SCHEMAS.pages.snapshot, ['tab-1'])).toBe(true)
    expect(ok(SERVICE_SCHEMAS.split.openWith, ['tab-1', 'tab-2'])).toBe(true)
  })
})
