/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { pickAutoUpdater } from '../src/main/updates/backend'

// electron-updater is CommonJS with a lazy `autoUpdater` getter. Imported from
// Electron's main process, the named export is undefined and only `default`
// has it; every release up to 1.6.0 read the named one and could never check.

const updater = { checkForUpdates: () => Promise.resolve(null) }

describe('loading electron-updater', () => {
  it('takes autoUpdater from module.exports when the named export is missing (Node importing CommonJS)', () => {
    expect(pickAutoUpdater({ autoUpdater: undefined, default: { autoUpdater: updater } })).toBe(updater)
    expect(pickAutoUpdater({ default: { autoUpdater: updater } })).toBe(updater)
  })

  it('takes the named export when a bundler gives one', () => {
    expect(pickAutoUpdater({ autoUpdater: updater })).toBe(updater)
  })

  it('fails loudly when neither has a usable updater', () => {
    expect(() => pickAutoUpdater({})).toThrow(/no autoUpdater/)
    expect(() => pickAutoUpdater({ default: { autoUpdater: {} } })).toThrow(/no autoUpdater/)
    expect(() => pickAutoUpdater(null)).toThrow(/no autoUpdater/)
  })
})
