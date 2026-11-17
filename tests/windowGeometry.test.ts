/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, ipcMain: {}, webContents: {}, contextBridge: {}, ipcRenderer: {} }))

import { windowBounds } from '../src/main/windowGeometry'
import { isBounds, standInWindowGeometry } from '../src/preload/page/windowGeometry'

// Window geometry (main/windowGeometry.ts): while Chromium reports no window
// frame for a page (outerWidth 0), the page reads the host window's bounds;
// once Chromium has its own, its getters go back.

const FIELDS = ['outerWidth', 'outerHeight', 'screenX', 'screenY', 'screenLeft', 'screenTop'] as const

/** A stand-in for a page's window: Chromium's getters read `native`. */
function fakeWindow(native: Record<(typeof FIELDS)[number], number>): Record<string, number> {
  const w = {}
  for (const name of FIELDS) Object.defineProperty(w, name, { get: () => native[name], set: () => undefined, configurable: true, enumerable: true })
  return w as Record<string, number>
}

const host = { x: 15, y: 33, width: 1440, height: 900 }
const zero = { outerWidth: 0, outerHeight: 0, screenX: 0, screenY: 0, screenLeft: 0, screenTop: 0 }

describe('window geometry stand-in', () => {
  it('reports the host window while Chromium says 0, then Chromium’s own getters', () => {
    const native = { ...zero }
    const w = fakeWindow(native)
    const originals = FIELDS.map((n) => Object.getOwnPropertyDescriptor(w, n)?.get)
    const update = standInWindowGeometry(host, w)
    expect(typeof update).toBe('function')
    expect(FIELDS.map((n) => w[n])).toEqual([1440, 900, 15, 33, 15, 33])
    // A move or resize while still waiting.
    expect(update?.({ x: 40, y: 50, width: 1200, height: 800 })).toBe(false)
    expect([w.outerWidth, w.outerHeight, w.screenX, w.screenY]).toEqual([1200, 800, 40, 50])
    // Chromium places the window (at x 0, a real position): its values, and its getters back.
    Object.assign(native, { outerWidth: 1300, outerHeight: 850, screenX: 0, screenY: 25, screenLeft: 0, screenTop: 25 })
    expect([w.outerWidth, w.screenX, w.screenY]).toEqual([1300, 0, 25])
    expect(FIELDS.map((n) => Object.getOwnPropertyDescriptor(w, n)?.get)).toEqual(originals)
    expect(update?.(host)).toBe(true)
  })

  it('keeps native names and source shape on the getters it stands in for', () => {
    const w = fakeWindow({ ...zero })
    const before = Object.getOwnPropertyDescriptor(w, 'outerWidth')
    standInWindowGeometry(host, w)
    const after = Object.getOwnPropertyDescriptor(w, 'outerWidth')
    expect(after?.get).not.toBe(before?.get)
    expect(after?.get?.name).toBe(before?.get?.name)
    expect([after?.enumerable, after?.configurable, after?.set]).toEqual([before?.enumerable, before?.configurable, before?.set])
  })

  it('leaves a property the page replaced itself alone when Chromium arrives', () => {
    const native = { ...zero }
    const w = fakeWindow(native)
    const update = standInWindowGeometry(host, w)
    Object.defineProperty(w, 'screenX', { value: 7, writable: true, configurable: true, enumerable: true })
    native.outerWidth = 1300
    expect(update?.(host)).toBe(true)
    expect(w.screenX).toBe(7)
  })

  it('does nothing without a native outerWidth getter', () => {
    expect(standInWindowGeometry(host, {})).toBeUndefined()
  })

  it('accepts only finite bounds with a size', () => {
    expect(isBounds(host)).toBe(true)
    expect(isBounds({ ...host, width: 0 })).toBe(false)
    expect(isBounds({ ...host, x: Number.NaN })).toBe(false)
    expect(isBounds(null)).toBe(false)
    expect(isBounds('1440x900')).toBe(false)
  })
})

describe('window bounds', () => {
  const win = (b: { x: number; y: number; width: number; height: number }, destroyed = false) => ({ isDestroyed: () => destroyed, getBounds: () => b }) as unknown as Electron.BrowserWindow

  it('is the window’s outer frame', () => {
    expect(windowBounds(win(host))).toEqual(host)
  })

  it('is null for no window, a destroyed one or an empty frame', () => {
    expect(windowBounds(null)).toBeNull()
    expect(windowBounds(win(host, true))).toBeNull()
    expect(windowBounds(win({ ...host, width: 0 }))).toBeNull()
  })
})
