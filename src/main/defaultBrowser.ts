/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, shell } from 'electron'
import type { DefaultBrowserStatus } from '@shared/services/settings'
import { mainT } from './i18n/mainT'
import { isDefaultBrowserLinuxSync, makeDefaultBrowserLinux } from './system/defaultBrowserLinux'

// Atelier as the default browser (ST-33). The status is read fresh each
// time (the page rechecks on focus); registering asks the system, which shows
// its own confirmation on macOS and its Default apps settings on Windows.

export interface DefaultBrowserDeps {
  platform: NodeJS.Platform
  packaged: boolean
  isDefault(protocol: 'http' | 'https'): boolean
  setDefault(protocol: 'http' | 'https'): boolean
  openExternal(url: string): Promise<void>
  // Linux: xdg-settings' default-web-browser, which covers http and https together.
  linux?: { isDefault(): boolean; make(): Promise<boolean> }
}

const electronDeps = (): DefaultBrowserDeps => ({
  platform: process.platform,
  packaged: app.isPackaged,
  isDefault: (p) => app.isDefaultProtocolClient(p),
  setDefault: (p) => app.setAsDefaultProtocolClient(p),
  openExternal: (url) => shell.openExternal(url),
  linux: process.platform === 'linux' ? { isDefault: () => isDefaultBrowserLinuxSync(), make: () => makeDefaultBrowserLinux() } : undefined,
})

export function defaultBrowserStatus(deps: Pick<DefaultBrowserDeps, 'platform' | 'packaged' | 'isDefault' | 'linux'> = electronDeps()): DefaultBrowserStatus {
  const isDefault = deps.platform === 'linux' && deps.linux ? deps.linux.isDefault() : deps.isDefault('https') && deps.isDefault('http')
  if (!deps.packaged) return { isDefault, canRegister: false, reason: 'dev-build' }
  if (!['darwin', 'win32', 'linux'].includes(deps.platform)) return { isDefault, canRegister: false, reason: 'unsupported' }
  return { isDefault, canRegister: true, reason: null }
}

export async function registerDefaultBrowser(deps: DefaultBrowserDeps = electronDeps()): Promise<DefaultBrowserStatus> {
  const status = defaultBrowserStatus(deps)
  if (status.isDefault) return status
  // An unpackaged run would register the Electron binary itself.
  if (status.reason === 'dev-build') throw new Error(mainT('settings.defaultBrowser.dev'))
  if (!status.canRegister) throw new Error(mainT('settings.defaultBrowser.unsupported'))
  // Linux: xdg-settings set, then check (it throws a readable message when the desktop refuses).
  if (deps.platform === 'linux' && deps.linux) {
    await deps.linux.make()
    return defaultBrowserStatus(deps)
  }
  deps.setDefault('http')
  deps.setDefault('https')
  // Windows hands the choice to its own settings page.
  if (deps.platform === 'win32') await deps.openExternal('ms-settings:defaultapps')
  return defaultBrowserStatus(deps)
}
