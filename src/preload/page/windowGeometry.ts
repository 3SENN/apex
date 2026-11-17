/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contextBridge, ipcRenderer } from 'electron'
import { PAGE, type PageWindowBounds } from '@shared/ipc'

// The window around the page (main/windowGeometry.ts): Chromium on macOS gives
// a page in a WebContentsView its window's frame only once the view has been
// laid out and drawn, so a fresh tab's first page (and a background tab until
// it is shown) reads window.outerWidth/outerHeight 0 and screenX/screenY 0,
// which no browser window does and sign-in risk scripts read as a headless or
// embedded tell. Only then, and before any page script runs, this asks main
// for the host window's bounds and stands in for those getters in the page's
// own world until Chromium's own value arrives; the native getters go back
// the moment it does. Every frame and every page, sign-in pages included, as
// no debugger is involved. A page Chromium already placed gets nothing.

export function installWindowGeometry(): void {
  // Chromium already knows the window (most pages after a tab's first): nothing to stand in for.
  if (window.outerWidth > 0) return
  let bounds: unknown = null
  try {
    bounds = ipcRenderer.sendSync(PAGE.window)
  } catch {
    // Main didn't answer (a page outside a window): the page keeps Chromium's value.
  }
  if (!isBounds(bounds)) return
  let update: ((next: PageWindowBounds) => boolean) | undefined
  try {
    update = contextBridge.executeInMainWorld({ func: standInWindowGeometry, args: [bounds] }) as typeof update
  } catch {
    // A world that can't be reached keeps Chromium's value.
  }
  if (typeof update !== 'function') return
  const settle = (): void => {
    ipcRenderer.off(PAGE.window, onBounds)
    ipcRenderer.send(PAGE.window, 'settled')
  }
  const onBounds = (_event: unknown, next: unknown): void => {
    if (isBounds(next) && update?.(next)) settle()
  }
  ipcRenderer.on(PAGE.window, onBounds)
}

export function isBounds(b: unknown): b is PageWindowBounds {
  if (!b || typeof b !== 'object') return false
  const { x, y, width, height } = b as Record<string, unknown>
  return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n)) && (width as number) > 0 && (height as number) > 0
}

/**
 * Runs in the page's world (executeInMainWorld serialises it, so it uses
 * nothing from outside). Wraps the window's own outerWidth, outerHeight,
 * screenX/Y and screenLeft/Top getters: each still calls Chromium's, and
 * answers with the host window's bounds only while Chromium's outerWidth is 0.
 * Once it is not, the original descriptors go back (unless the page replaced
 * one itself). Returns the updater main's moves and resizes go through; it
 * says true once Chromium has the window.
 */
export function standInWindowGeometry(initial: PageWindowBounds, target: object = globalThis): ((next: PageWindowBounds) => boolean) | undefined {
  const getDescriptor = Object.getOwnPropertyDescriptor
  const define = Object.defineProperty
  const apply = Reflect.apply
  const outer = getDescriptor(target, 'outerWidth')?.get
  if (typeof outer !== 'function') return undefined
  const fields: [string, keyof PageWindowBounds][] = [
    ['outerWidth', 'width'],
    ['outerHeight', 'height'],
    ['screenX', 'x'],
    ['screenY', 'y'],
    ['screenLeft', 'x'],
    ['screenTop', 'y'],
  ]
  let host = initial
  let settled = false
  const placed: [string, PropertyDescriptor, unknown][] = []
  const known = (): boolean => {
    try {
      return (apply(outer, target, []) as number) > 0
    } catch {
      return false
    }
  }
  const restore = (): boolean => {
    if (settled) return true
    if (!known()) return false
    settled = true
    for (const [name, original, mine] of placed) if (getDescriptor(target, name)?.get === mine) define(target, name, original)
    return true
  }
  for (const [name, key] of fields) {
    const original = getDescriptor(target, name)
    if (!original || typeof original.get !== 'function' || !original.configurable) continue
    // A Proxy keeps the native getter's name, length and [native code] source.
    const get = new Proxy(original.get, {
      apply(native, self, args) {
        const value = apply(native, self, args) as number
        return settled || restore() ? value : host[key]
      },
    })
    placed.push([name, original, get])
    define(target, name, { ...original, get })
  }
  return (next) => {
    host = next
    return restore()
  }
}
