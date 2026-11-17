/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Sites and safety: the per-origin store, safety
// and page errors. Per-site values live in sites.json, never in settings.
import type { DownloadDanger } from './downloads'

export type SitePermission =
  | 'camera'
  | 'microphone'
  | 'location'
  | 'notifications'
  | 'clipboard-read'
  | 'local-fonts'
  | 'idle-detection'
  | 'hid'
  | 'usb'
  | 'serial'
  | 'bluetooth'
  | 'speaker-selection'
  | 'local-network'
  | 'midi'
  | 'screen'
  | 'file-system'
  | 'external-app'
  // Placing windows across every display (getScreenDetails) needs asking.
  | 'window-management'

export const SITE_PERMISSIONS: readonly SitePermission[] = [
  'camera',
  'microphone',
  'location',
  'notifications',
  'clipboard-read',
  'local-fonts',
  'idle-detection',
  'hid',
  'usb',
  'serial',
  'bluetooth',
  'speaker-selection',
  'local-network',
  'midi',
  'screen',
  'file-system',
  'external-app',
  'window-management',
]

export type PermissionDecision = 'allow' | 'block' | 'ask'

export type SiteToggle = 'allow' | 'block' | 'default'

export interface GrantedDevice {
  kind: 'hid' | 'usb' | 'serial' | 'bluetooth'
  id: string
  name: string
}

/** One origin's overrides; omitted fields follow the global default. */
export interface SiteSettings {
  permissions: Partial<Record<SitePermission, PermissionDecision>>
  devices: GrantedDevice[]
  adblock: SiteToggle
  popups: SiteToggle
  javascript: SiteToggle
  images: SiteToggle
  automaticDownloads: SiteToggle
  insecureContent: SiteToggle
  sound: SiteToggle
  /** Force a dark rendering of this site. */
  forceDark: boolean
  cookies: SiteToggle
  /** External-app schemes this site may open without asking. */
  externalSchemes: string[]
}

export type SiteSettingsPatch = Partial<SiteSettings>

export interface SiteSettingsEntry {
  origin: string
  settings: SiteSettings
  /** How many settings differ from the defaults. */
  overrides: number
}

export type SecurityState = 'secure' | 'insecure' | 'cert-bypassed' | 'dangerous' | 'internal' | 'none'

export interface CertificateDetails {
  subject: string
  issuer: string
  validFrom: number
  validTo: number
  protocol: string
  sha256: string
}

/** What the site-info surface shows for the active page of a tab. */
export interface SiteInfo {
  tabId: string
  url: string
  origin: string
  host: string
  registrable: string
  punycodeWarning: boolean
  security: SecurityState
  certificate: CertificateDetails | null
  settings: SiteSettings
  cookieCount: number
  cacheBytes: number
  /** What the site stores besides cookies (local storage, IndexedDB, service workers), in bytes. */
  dataBytes: number
  /** The global switches the site's own toggles fall back to. */
  globals: { adblock: boolean; popupBlocking: boolean }
  /** A private window: nothing is remembered. */
  privateSession: boolean
  /** What the tab is capturing right now. */
  capture: CaptureState
  // ── permissions pass: site info ──
  /** Permissions allowed for this tab only, not remembered ("Allowed this time"). */
  oneTime?: SitePermission[]
  /** Devices allowed without "remember": they last while one of the site's tabs is open. */
  sessionDevices?: GrantedDevice[]
}

/** Apex's own kinds for failed loads (navErrors.ts maps did-fail-load codes to these). */
export type PageErrorKind =
  | 'offline'
  | 'not-found'
  | 'refused'
  | 'timed-out'
  | 'too-many-redirects'
  | 'blocked-by-adblock'
  | 'dangerous-site'
  | 'certificate'
  /** HTTPS-First's upgrade failed (src/main/privacy): the site has no working https; the error's url is the http address. */
  | 'https-unavailable'
  | 'other'

export interface PageError {
  kind: PageErrorKind
  code: number
  url: string
}

export interface DownloadClassifyInput {
  url: string
  filename: string
  mime: string
  referrer: string
}

export type { DownloadDanger }

// ── permissions pass: activity ──
/**
 * A request this page load refused or held back without a prompt (the same
 * shape as main/permissions.ts's PermissionActivity). TabInfo carries a tab's
 * list for the address bar's chips; it starts over on navigation.
 */
export interface PermissionActivity {
  tabId: string
  origin: string
  permission: SitePermission
  outcome: 'blocked' | 'quiet' | 'blocked-by-macos'
}

/** What a tab is capturing right now (TabInfo.capture). */
export interface CaptureState {
  camera: boolean
  microphone: boolean
  screen: boolean
}

export type CaptureKind = keyof CaptureState

export const NO_CAPTURE: CaptureState = { camera: false, microphone: false, screen: false }

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  permissions: {},
  devices: [],
  adblock: 'default',
  popups: 'default',
  javascript: 'default',
  images: 'default',
  automaticDownloads: 'default',
  insecureContent: 'default',
  sound: 'default',
  forceDark: false,
  cookies: 'default',
  externalSchemes: [],
}

const TOGGLES = ['adblock', 'popups', 'javascript', 'images', 'automaticDownloads', 'insecureContent', 'sound', 'cookies'] as const satisfies readonly (keyof SiteSettings)[]

/** The per-site switches; 'block' is always the stricter answer (a private window inherits those). */
export const SITE_TOGGLES: readonly (typeof TOGGLES)[number][] = TOGGLES

function toggle(value: unknown): SiteToggle {
  return value === 'allow' || value === 'block' ? value : 'default'
}

/** Field-by-field fallback for a stored entry: unknown values become defaults, 'ask' answers are dropped. */
export function normalizeSiteSettings(raw: unknown): SiteSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const permissions: SiteSettings['permissions'] = {}
  const perms = r.permissions && typeof r.permissions === 'object' ? (r.permissions as Record<string, unknown>) : {}
  for (const p of SITE_PERMISSIONS) {
    const d = perms[p]
    if (d === 'allow' || d === 'block') permissions[p] = d
  }
  const devices = Array.isArray(r.devices)
    ? r.devices.filter((d): d is GrantedDevice => {
        const x = d as Partial<GrantedDevice> | null
        return !!x && (x.kind === 'hid' || x.kind === 'usb' || x.kind === 'serial' || x.kind === 'bluetooth') && typeof x.id === 'string' && x.id.length > 0 && typeof x.name === 'string'
      })
    : []
  const out: SiteSettings = { ...DEFAULT_SITE_SETTINGS, permissions, devices: devices.map((d) => ({ kind: d.kind, id: d.id, name: d.name })) }
  for (const key of TOGGLES) out[key] = toggle(r[key])
  out.forceDark = r.forceDark === true
  out.externalSchemes = Array.isArray(r.externalSchemes)
    ? [...new Set(r.externalSchemes.filter((s): s is string => typeof s === 'string' && /^[a-z][a-z0-9+.-]{0,31}$/.test(s)))]
    : []
  return out
}

/** How many settings differ from the defaults (site settings lists them). */
export function countOverrides(s: SiteSettings): number {
  let n = Object.keys(s.permissions).length + s.devices.length + s.externalSchemes.length
  for (const key of TOGGLES) if (s[key] !== 'default') n++
  if (s.forceDark) n++
  return n
}

/** Applies a patch; a permission set to 'ask' is removed, since asking is the default. */
export function applySitePatch(current: SiteSettings, patch: SiteSettingsPatch): SiteSettings {
  const next: SiteSettings = { ...current, ...patch }
  if (patch.permissions) {
    const merged: SiteSettings['permissions'] = { ...current.permissions }
    for (const [perm, decision] of Object.entries(patch.permissions) as [SitePermission, PermissionDecision | undefined][]) {
      if (!decision || decision === 'ask') delete merged[perm]
      else merged[perm] = decision
    }
    next.permissions = merged
  }
  return normalizeSiteSettings(next)
}

/** One row of the cookies and site data list, grouped by registrable domain. */
export interface SiteDataEntry {
  domain: string
  cookies: number
  /** Hosts under the domain that hold cookies. */
  hosts: string[]
}

/** A source the screen picker offers (OV-14). */
export interface ScreenSource {
  id: string
  kind: 'tab' | 'window' | 'screen'
  name: string
  /** A small JPEG data URL, or null for a placeholder. */
  thumbnail: string | null
  /** The app's icon (windows) or the tab's favicon, as a data or https URL. */
  icon: string | null
  /** The window or app a tab or window belongs to. */
  detail: string | null
}

export interface ScreenSources {
  sources: ScreenSource[]
  /** macOS Screen Recording: windows and screens need it, tabs don't ('relaunch': allowed, takes effect after Apex restarts). */
  screenAccess: 'granted' | 'denied' | 'not-determined' | 'relaunch' | 'unsupported'
}

/** A device the chooser lists (OV-15). */
export interface DeviceEntry {
  id: string
  name: string
  detail: string | null
}

export type DeviceKind = GrantedDevice['kind']

/** A Bluetooth pairing step (win32 and linux; macOS pairs by itself). */
export type PairingStep = { kind: 'confirm' } | { kind: 'confirm-pin'; pin: string } | { kind: 'provide-pin' }
