/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import { z } from 'zod'
import type { Perm, SpeechBroker, SpeechPermissions } from '@shared/speech'
import { SYSTEM_PERMISSIONS, SYSTEM_PRIVACY_PANES, SYSTEM_REQUESTABLE, type SystemPermissionsReport, type SystemPermissionsServices } from '@shared/systemPermissions'
import type { Feature } from './features/types'
import { log } from './log'
import { systemNotificationStatus } from './notificationPresenter'

// This Mac's permissions for Settings › Privacy › Permissions: one report of
// what macOS says about each permission Apex uses, read without prompting,
// plus the asks and System Settings links behind that page's buttons. A
// prompt only ever follows a click on Allow there. Calendars and Reminders
// stay with the calendar service, which has its own helper.

export interface SystemPermissionsDeps {
  platform: NodeJS.Platform
  /** Electron's view for Apex itself (never prompts). */
  mediaStatus(kind: 'camera' | 'microphone' | 'screen'): string
  /** Prompts only when macOS never asked; resolves at once otherwise. */
  askForMedia(kind: 'camera' | 'microphone'): Promise<boolean>
  /** Without the helper: the first screen capture is what makes macOS ask. */
  askForScreen(): Promise<void>
  /** The speech helper's broker; null before it exists or off macOS. */
  broker(): SpeechBroker | null
  fullDisk(): SystemPermissionsReport['fullDisk']
  notifications(): SystemPermissionsReport['notifications']
  openExternal(url: string): void
}

const PERMS: readonly string[] = ['granted', 'denied', 'restricted', 'not-determined']

function asPerm(value: string): Perm | 'unknown' {
  return PERMS.includes(value) ? (value as Perm) : 'unknown'
}

/** Full Disk Access, seen the way the importer needs it: listing Safari's folder fails without it. */
export function fullDiskAccess(home: string): SystemPermissionsReport['fullDisk'] {
  try {
    readdirSync(join(home, 'Library', 'Safari'))
    return 'granted'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown'
  }
}

export function createSystemPermissions(deps: SystemPermissionsDeps): SystemPermissionsServices['systemPermissions'] {
  const mac = deps.platform === 'darwin'

  const media = (kind: 'camera' | 'microphone' | 'screen'): string => {
    try {
      return deps.mediaStatus(kind)
    } catch {
      return 'unknown'
    }
  }

  /** The broker when its helper is here, else null. */
  const broker = (): SpeechBroker | null => {
    try {
      const b = deps.broker()
      return b && b.status().available ? b : null
    } catch {
      return null
    }
  }

  const helperPermissions = async (): Promise<SpeechPermissions | null> => {
    const b = broker()
    if (!b) return null
    try {
      return await b.permissions()
    } catch (err) {
      log.warn('permissions', 'The speech helper did not report its permissions', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  const status = async (): Promise<SystemPermissionsReport> => {
    if (!mac) {
      return { supported: false, microphone: 'unknown', camera: 'unknown', speech: null, screen: { app: 'denied', helper: null }, location: null, notifications: deps.notifications(), fullDisk: 'unknown' }
    }
    const helper = await helperPermissions()
    return {
      supported: true,
      microphone: asPerm(media('microphone')),
      camera: asPerm(media('camera')),
      speech: helper?.speech ?? null,
      screen: { app: media('screen') === 'granted' ? 'granted' : 'denied', helper: helper?.screen ?? null },
      location: helper?.location ?? null,
      notifications: deps.notifications(),
      fullDisk: deps.fullDisk(),
    }
  }

  return {
    status,
    async request(kind) {
      if (!mac) return status()
      try {
        if (kind === 'camera' || kind === 'microphone') await deps.askForMedia(kind)
        else if (kind === 'speech') await broker()?.request('speech')
        else {
          const b = broker()
          if (b) await b.request('screen')
          else await deps.askForScreen()
        }
      } catch (err) {
        log.warn('permissions', `Asking macOS for ${kind} failed`, { error: err instanceof Error ? err.message : String(err) })
      }
      return status()
    },
    openSettings(kind) {
      if (mac) deps.openExternal(SYSTEM_PRIVACY_PANES[kind])
    },
  }
}

export const SYSTEM_PERMISSIONS_SCHEMAS: { systemPermissions: { [M in keyof SystemPermissionsServices['systemPermissions']]: z.ZodType<unknown[]> } } = {
  systemPermissions: {
    status: z.tuple([]),
    request: z.tuple([z.enum(SYSTEM_REQUESTABLE as [string, ...string[]])]),
    openSettings: z.tuple([z.enum(SYSTEM_PERMISSIONS as [string, ...string[]])]),
  },
}

export function createSystemPermissionsFeature(): Feature {
  return {
    name: 'systemPermissions',
    app(ctx) {
      const methods = createSystemPermissions({
        platform: process.platform,
        mediaStatus: (kind) => systemPreferences.getMediaAccessStatus(kind),
        askForMedia: (kind) => systemPreferences.askForMediaAccess(kind),
        askForScreen: async () => {
          await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        },
        // Filled by the speech feature, which starts first; a stand-in until then throws.
        broker: () => ctx.personal?.broker ?? null,
        fullDisk: () => fullDiskAccess(app.getPath('home')),
        notifications: () => systemNotificationStatus(),
        openExternal: (url) => void shell.openExternal(url),
      })
      return { systemPermissions: methods }
    },
  }
}
