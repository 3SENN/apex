/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Input, Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANCHOR_GAP, EDGE_MARGIN, POPUP_MAX, anchorBelow, clampPopupSize } from '@shared/extensions'
import type { ExtensionsAdapter, LoadedExtension } from '../src/main/extensions/adapter'
import { NATIVE_APIS } from '../src/main/extensions/compat'
import { EXECUTE_ACTION, inputAccelerator, manifestCommands, toAccelerator } from '../src/main/extensions/commands'
import { ExtensionsHost, unpackedId, type HostDeps } from '../src/main/extensions/host'
import { readManifest } from '../src/main/extensions/manifest'
import { shortcuts } from '../src/main/shortcuts'

// Manifest commands become Apex runtime shortcuts unless a
// built-in already holds the key, and the clash shows on the extension's
// row. Also the popup's anchor geometry under its toolbar button.

const FIXTURE = join(__dirname, 'fixtures/extensions/mv3-basic')

describe('toAccelerator', () => {
  it('reads Ctrl as Command on a Mac and MacCtrl as Control', () => {
    expect(toAccelerator('Ctrl+Shift+Y', 'darwin')).toBe('Command+Shift+Y')
    expect(toAccelerator('MacCtrl+Shift+Y', 'darwin')).toBe('Ctrl+Shift+Y')
    expect(toAccelerator('Ctrl+Shift+Y', 'linux')).toBe('Ctrl+Shift+Y')
    expect(toAccelerator('Alt+Comma', 'win32')).toBe('Alt+,')
  })

  it('refuses keys Chrome refuses', () => {
    expect(toAccelerator('Shift+Y', 'darwin')).toBeNull()
    expect(toAccelerator('Y', 'darwin')).toBeNull()
    expect(toAccelerator('Ctrl+Shift+Tab', 'darwin')).toBeNull()
    expect(toAccelerator('MacCtrl+Y', 'linux')).toBeNull()
    expect(toAccelerator('Search+Y', 'linux')).toBeNull()
  })
})

describe('manifestCommands', () => {
  it('picks the platform key, keeps keyless commands and renames legacy actions', () => {
    const m = readManifest(FIXTURE)!
    expect(manifestCommands(m, 'darwin')).toEqual([
      { name: EXECUTE_ACTION, description: '', accelerator: 'Command+Shift+Y' },
      { name: 'new-note', description: 'Start a note', accelerator: 'Command+Shift+N' },
      { name: 'quiet', description: 'No key', accelerator: null },
    ])
    expect(manifestCommands({ commands: { _execute_browser_action: { suggested_key: { default: 'Alt+Shift+P' } } } }, 'linux')[0]).toEqual({ name: EXECUTE_ACTION, description: '', accelerator: 'Alt+Shift+P' })
  })

  it('gives at most four commands a key, as Chrome does', () => {
    const commands = Object.fromEntries(['1', '2', '3', '4', '5'].map((k) => [`c${k}`, { suggested_key: { default: `Alt+Shift+${k}` } }]))
    expect(manifestCommands({ commands }, 'linux').filter((c) => c.accelerator).length).toBe(4)
  })
})

describe('inputAccelerator', () => {
  const key = (over: Partial<Input>): Input => ({ type: 'keyDown', key: 'y', code: 'KeyY', meta: false, control: false, alt: false, shift: false, ...over }) as Input

  it('spells a key press the way shortcuts compare them', () => {
    expect(inputAccelerator(key({ meta: true, shift: true, key: 'Y' }), 'darwin')).toBe('cmd+shift+y')
    expect(inputAccelerator(key({ alt: true, key: 'Ω' }), 'darwin')).toBe('alt+y')
    expect(inputAccelerator(key({ control: true, key: ',', code: 'Comma' }), 'linux')).toBe('ctrl+,')
  })

  it('ignores bare keys, lone modifiers and key-ups', () => {
    expect(inputAccelerator(key({}), 'darwin')).toBeNull()
    expect(inputAccelerator(key({ meta: true, key: 'Meta', code: 'MetaLeft' }), 'darwin')).toBeNull()
    expect(inputAccelerator(key({ type: 'keyUp', meta: true }), 'darwin')).toBeNull()
  })
})

// A fake runtime: loading succeeds and records what is loaded, nothing touches Electron.
function fakeAdapter(): ExtensionsAdapter & { loaded: Map<string, LoadedExtension> } {
  const loaded = new Map<string, LoadedExtension>()
  return {
    name: 'fake',
    apis: NATIVE_APIS,
    loaded,
    async load(_s, dir) {
      const m = readManifest(dir)!
      const ext = { id: unpackedId(dir, m), name: String(m.name), version: String(m.version), path: dir, url: '', manifest: m }
      loaded.set(ext.id, ext)
      return ext
    },
    unload: (_s, id) => void loaded.delete(id),
    get: (_s, id) => loaded.get(id) ?? null,
    all: () => [...loaded.values()],
    onUnloaded: () => () => {},
    installPreloads: () => {},
  }
}

const fakeSession = (): Session => ({ serviceWorkers: { on: () => {} }, clearStorageData: async () => {} }) as unknown as Session

describe('ExtensionsHost commands', () => {
  let dir = ''
  let disposed: string[] = []
  let registered: string[] = []
  let host: ExtensionsHost

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apex-ext-cmd-'))
    disposed = []
    registered = []
    const deps: HostDeps = {
      adapter: fakeAdapter(),
      preloads: null,
      extensionsDir: (p) => join(dir, p, 'Extensions'),
      nativeHostDirs: [],
      windows: () => [],
      openTab: () => null,
      changed: () => {},
      askInstall: async () => false,
      askNative: async () => 'deny',
      toast: () => {},
      // The real registry decides clashes against Apex's own shortcuts.
      registerShortcut: (def) => {
        const result = shortcuts.registerRuntime(def)
        if (result.ok) {
          registered.push(def.accelerator)
          return { ok: true, dispose: () => (disposed.push(def.accelerator), result.dispose()) }
        }
        return result
      },
      clashesWith: (a) => shortcuts.clashesWith(a),
      chromeVersion: '140.0.0.0',
    }
    host = new ExtensionsHost(deps)
    host.attach(fakeSession(), 'default')
  })

  afterEach(() => {
    host.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers free keys and shows the clash on the row when Apex owns the key', async () => {
    const id = await host.loadUnpacked('default', FIXTURE)
    const item = host.list('default').find((e) => e.id === id)!
    const accel = (name: string) => item.commands.find((c) => c.name === name)
    // ⇧⌘N (or Ctrl+Shift+N) opens a private window in Apex, so the extension's command doesn't get it.
    expect(accel('Start a note')).toMatchObject({ clash: 'new-private-window' })
    expect(accel('Open the extension')).toMatchObject({ clash: null })
    expect(accel('No key')).toEqual({ name: 'No key', shortcut: null, clash: null })
    expect(registered).toHaveLength(1)
    expect(item.source).toBe('unpacked')
    expect(item.storeUrl).toBeNull()
  })

  it('lets the extension go of its keys when it is turned off', async () => {
    const id = await host.loadUnpacked('default', FIXTURE)
    await host.setEnabled('default', id, false)
    expect(disposed).toEqual(registered)
    expect(host.list('default')[0]).toMatchObject({ enabled: false })
  })
})

describe('popup anchor geometry', () => {
  const viewport = { width: 1200, height: 800 }

  it('hangs under the button with right edges aligned', () => {
    const anchor = { x: 1100, y: 6, width: 28, height: 28 }
    expect(anchorBelow(anchor, { width: 300, height: 200 }, viewport)).toEqual({ x: 828, y: 6 + 28 + ANCHOR_GAP, width: 300, height: 200 })
  })

  it('flips to the left edge when the right-aligned box would leave the window', () => {
    const anchor = { x: 20, y: 6, width: 28, height: 28 }
    expect(anchorBelow(anchor, { width: 300, height: 200 }, viewport).x).toBe(20)
  })

  it('stays inside the window on both axes', () => {
    const box = anchorBelow({ x: 1180, y: 700, width: 28, height: 28 }, { width: 2000, height: 400 }, viewport)
    expect(box.x).toBeGreaterThanOrEqual(EDGE_MARGIN)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - EDGE_MARGIN)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - EDGE_MARGIN)
    expect(box.width).toBe(viewport.width - EDGE_MARGIN * 2)
  })

  it('clamps a popup to Chrome’s size limits', () => {
    expect(clampPopupSize({ width: 2, height: 9000 })).toEqual({ width: 25, height: POPUP_MAX.height })
    expect(clampPopupSize({ width: Number.NaN, height: 320.6 })).toEqual({ width: 25, height: 321 })
  })
})
