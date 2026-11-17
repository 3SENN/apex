/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { builderConfig } from '../scripts/release/builderConfig.mjs'
import { describe, expect, it, vi } from 'vitest'
import { GROUND } from '../src/shared/profile'
import { readFileSync } from 'node:fs'
import { APP_USER_MODEL_ID, LINUX_DESKTOP_ENTRY, TITLE_BAR_HEIGHT } from '../src/shared/system'
import { checkAnswer, isDefaultBrowserLinux, isDefaultBrowserLinuxSync, makeDefaultBrowserLinux } from '../src/main/system/defaultBrowserLinux'
import { defaultBrowserStatus, registerDefaultBrowser, type DefaultBrowserDeps } from '../src/main/defaultBrowser'
import { linuxTrayAvailable } from '../src/main/system/linuxTray'
import { titleBarOverlayFor, titleBarWindowOptions } from '../src/main/system/titleBar'

vi.mock('electron', () => ({ app: { isPackaged: false, isDefaultProtocolClient: () => false, setAsDefaultProtocolClient: () => false }, shell: { openExternal: async () => undefined } }))

// The Windows and Linux runtime pieces: the title bar overlay, Linux tray
// detection and the xdg default browser.

describe('title bar overlay', () => {
  it('paints the controls in whatever sits under them, with ink symbols', () => {
    const sidebar = titleBarOverlayFor({ mode: 'light', layout: 'sidebar', hue: 'stone' })
    const horizontal = titleBarOverlayFor({ mode: 'dark', layout: 'horizontal', hue: 'stone' })
    expect(sidebar.height).toBe(TITLE_BAR_HEIGHT)
    expect(horizontal.color).toBe(GROUND.dark)
    expect(sidebar.color).not.toBe(horizontal.color)
    expect(sidebar.symbolColor).not.toBe(horizontal.symbolColor)
    // The profile hue washes the ground.
    expect(titleBarOverlayFor({ mode: 'light', layout: 'horizontal', hue: 'tide' }).color).not.toBe(GROUND.light)
  })

  it('applies only on Windows and Linux', () => {
    const look = { mode: 'light' as const, layout: 'sidebar' as const, hue: 'stone' as const }
    expect(titleBarWindowOptions('darwin', look)).toEqual({})
    expect(titleBarWindowOptions('win32', look)).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: TITLE_BAR_HEIGHT } })
    expect(titleBarWindowOptions('linux', look).titleBarStyle).toBe('hidden')
  })
})

describe('linuxTrayAvailable', () => {
  it('trusts the StatusNotifier watcher, then the desktop', () => {
    expect(linuxTrayAvailable({ watcher: true, desktop: 'GNOME' })).toBe(true)
    expect(linuxTrayAvailable({ watcher: false, desktop: 'ubuntu:GNOME' })).toBe(false)
    expect(linuxTrayAvailable({ watcher: null, desktop: 'GNOME' })).toBe(false)
    expect(linuxTrayAvailable({ watcher: false, desktop: 'XFCE' })).toBe(true)
    expect(linuxTrayAvailable({ watcher: null, desktop: 'KDE' })).toBe(true)
    expect(linuxTrayAvailable({ watcher: null, desktop: 'SomethingNew' })).toBe(true)
    expect(linuxTrayAvailable({ watcher: null, desktop: '' })).toBe(false)
  })
})

describe('Linux default browser', () => {
  it('checks and sets through xdg-settings with the desktop entry', async () => {
    const calls: string[][] = []
    let isDefault = false
    const exec = async (file: string, args: string[]): Promise<string> => {
      calls.push([file, ...args])
      if (args[0] === 'set') isDefault = true
      return isDefault ? 'yes\n' : 'no\n'
    }
    expect(await isDefaultBrowserLinux(exec)).toBe(false)
    expect(await makeDefaultBrowserLinux(exec)).toBe(true)
    expect(calls).toContainEqual(['xdg-settings', 'set', 'default-web-browser', LINUX_DESKTOP_ENTRY])
    expect(calls).toContainEqual(['xdg-settings', 'check', 'default-web-browser', LINUX_DESKTOP_ENTRY])
  })

  it('reports a missing tool as not default, and a refusal as a readable error', async () => {
    const fail = async (): Promise<string> => {
      throw new Error('ENOENT')
    }
    expect(await isDefaultBrowserLinux(fail)).toBe(false)
    await expect(makeDefaultBrowserLinux(fail)).rejects.toThrow('Default Applications')
  })
})

describe('Linux default browser, synchronous check and the default-browser service', () => {
  it('reads yes, no and anything else', () => {
    expect(checkAnswer('yes\n')).toBe(true)
    expect(checkAnswer(' YES ')).toBe(true)
    expect(checkAnswer('no\n')).toBe(false)
    expect(checkAnswer('xdg-settings: unknown desktop environment')).toBe(false)
    expect(isDefaultBrowserLinuxSync(() => 'yes\n')).toBe(true)
    expect(
      isDefaultBrowserLinuxSync(() => {
        throw new Error('ENOENT')
      }),
    ).toBe(false)
  })

  const linuxDeps = (start: boolean): DefaultBrowserDeps & { set: string[] } => {
    let isDefault = start
    const set: string[] = []
    return {
      set,
      platform: 'linux',
      packaged: true,
      // Electron's per-scheme answers are never asked on Linux.
      isDefault: () => {
        throw new Error('not on Linux')
      },
      setDefault: (p) => {
        set.push(p)
        return true
      },
      openExternal: async () => undefined,
      linux: {
        isDefault: () => isDefault,
        make: async () => {
          isDefault = true
          return true
        },
      },
    }
  }

  it('reads the status through xdg-settings on Linux', () => {
    expect(defaultBrowserStatus(linuxDeps(true))).toEqual({ isDefault: true, canRegister: true, reason: null })
    expect(defaultBrowserStatus(linuxDeps(false)).isDefault).toBe(false)
  })

  it('registers through xdg-settings, not the per-scheme protocol calls', async () => {
    const deps = linuxDeps(false)
    expect((await registerDefaultBrowser(deps)).isDefault).toBe(true)
    expect(deps.set).toEqual([])
  })

  it('passes the desktop\'s refusal on as the readable message', async () => {
    const deps = linuxDeps(false)
    deps.linux = { isDefault: () => false, make: () => makeDefaultBrowserLinux(async () => Promise.reject(new Error('refused'))) }
    await expect(registerDefaultBrowser(deps)).rejects.toThrow('Default Applications')
  })
})

describe('Windows AppUserModelId', () => {
  it('matches electron-builder\'s appId, so notifications group under the app', () => {
    // The branding's bundle id (scripts/branding.mjs), as electron-builder.config.mjs packages it.
    const { appId } = builderConfig({ ...process.env, ATELIER_BUNDLE_ID: '' }, { platform: 'win32' }) as { appId: string }
    expect(APP_USER_MODEL_ID).toBe(appId)
  })
})
