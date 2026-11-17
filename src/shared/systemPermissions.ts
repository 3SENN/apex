/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// This Mac's permissions in one place (Settings › Privacy › Permissions): the
// macOS permissions Apex uses, what main reads for each without prompting,
// and the pure rule from a status to the one thing its row offers. Calendars
// and Reminders come from the calendar service; the rest from
// systemPermissions.status(). Unit-tested in tests/systemPermissions.test.ts.
import type { CalendarStatus } from './calendar'
import { PRIVACY_PANES, type Perm, type ScreenAccess } from './speech'

export type SystemPermission = 'microphone' | 'speech' | 'screen' | 'camera' | 'location' | 'calendars' | 'reminders' | 'notifications' | 'full-disk'

/** Top to bottom, as the page lists them. */
export const SYSTEM_PERMISSIONS: readonly SystemPermission[] = ['microphone', 'speech', 'screen', 'camera', 'location', 'calendars', 'reminders', 'notifications', 'full-disk']

/** The ones systemPermissions.request() asks macOS for; Calendars and Reminders ask through the calendar service. */
export type SystemRequestable = 'microphone' | 'speech' | 'screen' | 'camera'
export const SYSTEM_REQUESTABLE: readonly SystemRequestable[] = ['microphone', 'speech', 'screen', 'camera']

export interface SystemPermissionsReport {
  /** False off macOS: the page then shows only the website permissions. */
  supported: boolean
  /** As Electron reads them for Apex itself; 'unknown' when macOS gives no answer. */
  microphone: Perm | 'unknown'
  camera: Perm | 'unknown'
  /** Through the speech helper; null when the helper isn't part of this build or can't start. */
  speech: Perm | null
  /**
   * macOS reads the Screen Recording grant once per process: `helper` is a
   * freshly started helper's view, `app` is Apex's own, so a grant the
   * helper sees and Apex doesn't needs a relaunch.
   */
  screen: { app: 'granted' | 'denied'; helper: 'granted' | 'denied' | null }
  /** Location Services from the helper; null when it doesn't report it. */
  location: Perm | null
  /** macOS doesn't tell an app whether its notifications are on: 'denied' only when Apex saw them fail. */
  notifications: 'allowed' | 'denied' | 'unknown'
  /** Whether Safari's files open (the only thing Apex needs it for); 'unknown' without Safari. */
  fullDisk: 'granted' | 'denied' | 'unknown'
}

export interface SystemPermissionsServices {
  systemPermissions: {
    /** Every permission above, read without prompting. */
    status(): Promise<SystemPermissionsReport>
    /** Asks macOS after a click on Allow; it prompts only when it never asked. Resolves to the new report. */
    request(kind: SystemRequestable): Promise<SystemPermissionsReport>
    /** Opens the permission's pane in System Settings. */
    openSettings(kind: SystemPermission): void
  }
}

/** The pane in System Settings for each one. */
export const SYSTEM_PRIVACY_PANES: Record<SystemPermission, string> = {
  microphone: PRIVACY_PANES.microphone,
  speech: PRIVACY_PANES.speech,
  screen: PRIVACY_PANES.screen,
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  location: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices',
  calendars: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  reminders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
  'full-disk': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
}

/**
 * What a row says: macOS's answer, 'relaunch' for a Screen Recording grant
 * Apex sees only after restarting, 'unknown' where macOS doesn't tell apps,
 * 'managed' for Location without a report, 'unavailable' without the helper.
 */
export type SystemRowState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'relaunch' | 'unknown' | 'managed' | 'unavailable'

/** The one thing a row offers. */
export type SystemRowAction = 'allow' | 'open-settings' | 'relaunch' | 'none'

export interface SystemRow {
  kind: SystemPermission
  state: SystemRowState
  action: SystemRowAction
}

export interface SystemRowInput {
  report: SystemPermissionsReport
  /** null while it loads or when the calendar service failed. */
  calendar: CalendarStatus | null
  /** Main's own Screen Recording answer (speech.screenAccess), which remembers whether Apex asked; null where it isn't offered. */
  screenAccess?: ScreenAccess | null
  /** Without it: Apex already asked for Screen Recording from Settings (macOS prompts only the first time). */
  screenAsked: boolean
}

/** A plain macOS answer: ask when it never asked (and Apex can), System Settings when it's off. */
function fromPerm(kind: SystemPermission, perm: Perm | 'unknown', canAsk: boolean): SystemRow {
  if (perm === 'granted') return { kind, state: 'granted', action: 'none' }
  if (perm === 'denied') return { kind, state: 'denied', action: 'open-settings' }
  // Parental controls or a managed Mac: nothing in System Settings changes it.
  if (perm === 'restricted') return { kind, state: 'restricted', action: 'none' }
  if (perm === 'not-determined') return { kind, state: 'not-determined', action: canAsk ? 'allow' : 'none' }
  return { kind, state: 'unknown', action: 'open-settings' }
}

function fromScreenAccess(access: ScreenAccess): SystemRow {
  const kind = 'screen'
  if (access === 'granted') return { kind, state: 'granted', action: 'none' }
  if (access === 'relaunch') return { kind, state: 'relaunch', action: 'relaunch' }
  if (access === 'not-determined') return { kind, state: 'not-determined', action: 'allow' }
  if (access === 'denied') return { kind, state: 'denied', action: 'open-settings' }
  return { kind, state: 'unavailable', action: 'none' }
}

/** One permission's row. Never asked is never shown as denied. */
export function systemPermissionRow(kind: SystemPermission, { report, calendar, screenAccess, screenAsked }: SystemRowInput): SystemRow {
  switch (kind) {
    case 'microphone':
    case 'camera':
      return fromPerm(kind, report[kind], true)
    case 'speech':
      return report.speech === null ? { kind, state: 'unavailable', action: 'none' } : fromPerm(kind, report.speech, true)
    case 'screen': {
      if (screenAccess) return fromScreenAccess(screenAccess)
      if (report.screen.app === 'granted') return { kind, state: 'granted', action: 'none' }
      if (report.screen.helper === 'granted') return { kind, state: 'relaunch', action: 'relaunch' }
      // macOS has no "not asked yet" for Screen Recording: Apex remembers whether it asked.
      return screenAsked ? { kind, state: 'denied', action: 'open-settings' } : { kind, state: 'not-determined', action: 'allow' }
    }
    case 'location':
      // Apex can't ask on its own: macOS asks the first time a site you allow wants your location.
      return report.location === null ? { kind, state: 'managed', action: 'open-settings' } : fromPerm(kind, report.location, false)
    case 'calendars':
    case 'reminders': {
      if (!calendar?.available) return { kind, state: 'unavailable', action: 'none' }
      return fromPerm(kind, calendar[kind === 'calendars' ? 'events' : 'reminders'], true)
    }
    case 'notifications':
      if (report.notifications === 'allowed') return { kind, state: 'granted', action: 'none' }
      return { kind, state: report.notifications === 'denied' ? 'denied' : 'unknown', action: 'open-settings' }
    case 'full-disk':
      // Full Disk Access is never asked for: it is a switch in System Settings.
      if (report.fullDisk === 'granted') return { kind, state: 'granted', action: 'none' }
      return { kind, state: report.fullDisk === 'denied' ? 'denied' : 'unknown', action: 'open-settings' }
  }
}

/** Every row, in page order. */
export function systemPermissionRows(input: SystemRowInput): SystemRow[] {
  return SYSTEM_PERMISSIONS.map((kind) => systemPermissionRow(kind, input))
}

