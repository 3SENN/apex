/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure helpers for the site surfaces and the Site settings page: which
// permissions show in site info and in what order, what each switch means
// against the global setting, filtering and grouping lists, and the text
// pieces of the prompt and the sharing bar. No DOM, so it is unit-tested.
import type { MessageKey, MessageVars } from '@shared/i18n/core'
import type { PermissionPromptProps } from '@shared/overlay/sites'
import { siteKey } from '@shared/permissions'
import { SITE_PERMISSIONS, type CaptureState, type DeviceEntry, type PermissionDecision, type ScreenSource, type SiteDataEntry, type SiteInfo, type SitePermission, type SiteSettings, type SiteSettingsEntry, type SiteSettingsPatch } from '@shared/sites'

export interface PermissionRow {
  perm: SitePermission
  decision: PermissionDecision
}

/** Site info's permissions: the ones the site has an answer for (or is using now) first, the rest in a collapsed group. */
export function splitPermissions(settings: SiteSettings, capture?: CaptureState): { set: PermissionRow[]; unset: SitePermission[] } {
  const inUse = new Set<SitePermission>()
  if (capture?.camera) inUse.add('camera')
  if (capture?.microphone) inUse.add('microphone')
  if (capture?.screen) inUse.add('screen')
  const set: PermissionRow[] = []
  const unset: SitePermission[] = []
  for (const perm of SITE_PERMISSIONS) {
    const decision = settings.permissions[perm]
    if (decision) set.push({ perm, decision })
    else if (inUse.has(perm)) set.push({ perm, decision: 'ask' })
    else unset.push(perm)
  }
  return { set, unset }
}

export type SwitchKey = 'adblock' | 'sound' | 'popups'

/** What site info's switches show: ads blocked, sound on, pop-ups allowed. */
export function switchStates(info: Pick<SiteInfo, 'settings' | 'globals'>): Record<SwitchKey, boolean> {
  const s = info.settings
  return {
    adblock: s.adblock === 'block' || (s.adblock === 'default' && info.globals.adblock),
    sound: s.sound !== 'block',
    popups: s.popups === 'allow' || (s.popups === 'default' && !info.globals.popupBlocking),
  }
}

/** The patch for flipping one switch: back to the default when that matches, an exception when it doesn't. */
export function switchPatch(key: SwitchKey, on: boolean, globals: SiteInfo['globals']): SiteSettingsPatch {
  switch (key) {
    case 'adblock':
      return { adblock: on === globals.adblock ? 'default' : on ? 'block' : 'allow' }
    case 'sound':
      return { sound: on ? 'default' : 'block' }
    case 'popups':
      return { popups: on === !globals.popupBlocking ? 'default' : on ? 'allow' : 'block' }
  }
}

function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return fields.some((f) => !!f && f.toLowerCase().includes(q))
}

export function filterDevices(devices: readonly DeviceEntry[], query: string): DeviceEntry[] {
  return devices.filter((d) => matches(query, d.name, d.detail))
}

export function filterSites(entries: readonly SiteSettingsEntry[], query: string): SiteSettingsEntry[] {
  return entries.filter((e) => matches(query, e.origin))
}

export function filterData(entries: readonly SiteDataEntry[], query: string): SiteDataEntry[] {
  return entries.filter((e) => matches(query, e.domain, ...e.hosts))
}

/** Sites with a cookie exception, for the exceptions list. */
export function cookieExceptions(entries: readonly SiteSettingsEntry[]): { origin: string; cookies: 'allow' | 'block' }[] {
  return entries.flatMap((e) => (e.settings.cookies === 'default' ? [] : [{ origin: e.origin, cookies: e.settings.cookies }]))
}

export function groupSources(sources: readonly ScreenSource[]): Record<ScreenSource['kind'], ScreenSource[]> {
  const out: Record<ScreenSource['kind'], ScreenSource[]> = { tab: [], window: [], screen: [] }
  for (const s of sources) out[s.kind].push(s)
  return out
}

export type PickerGroup = ScreenSource['kind']

const GROUP_ORDER: readonly PickerGroup[] = ['tab', 'window', 'screen']

/** The picker's group to show: the current one while it has sources, else the first that has any (tabs first). */
export function pickerGroup(sources: readonly ScreenSource[], current: PickerGroup): PickerGroup {
  if (sources.some((s) => s.kind === current)) return current
  return GROUP_ORDER.find((g) => sources.some((s) => s.kind === g)) ?? current
}

/** "example.com", "https://example.com/path" or "http://localhost:3000" as an origin; null when it isn't a site. */
export function parseSiteInput(text: string): string | null {
  const raw = text.trim()
  if (!raw || /\s/.test(raw)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  const origin = siteKey(withScheme)
  if (!origin) return null
  const host = new URL(origin).hostname
  // A bare word isn't a site unless it is localhost.
  return host.includes('.') || host === 'localhost' || host.startsWith('[') ? origin : null
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/** The host with its registrable part marked, for highlighting ("www." + "example.com"). */
export function splitHost(host: string, registrable: string): { before: string; registrable: string } {
  if (registrable && host.endsWith(registrable)) return { before: host.slice(0, host.length - registrable.length), registrable }
  return { before: '', registrable: host }
}

/** A SHA-256 fingerprint as colon-separated byte pairs, uppercase. */
export function formatFingerprint(sha256: string): string {
  const hex = sha256.replace(/[^0-9a-f]/gi, '').toUpperCase()
  return hex.match(/.{1,2}/g)?.join(':') ?? sha256
}

export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024) return `${Math.max(1, Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export type Message = [MessageKey, MessageVars?]

/** The phrase for what a prompt asks, after "wants to". */
export function askPhrase(perms: readonly SitePermission[]): Message[] {
  if (perms.length === 2 && perms.includes('camera') && perms.includes('microphone')) return [['sites.ask.cameraAndMicrophone']]
  return perms.map((p) => [`sites.ask.${p}`] as Message)
}

/** The prompt's remember label for what may be kept; null when nothing may. */
export function rememberLabel(props: Pick<PermissionPromptProps, 'remember' | 'host' | 'scheme'>): Message | null {
  if (props.remember === 'allow') return props.scheme ? ['sites.prompt.rememberApp', { host: props.host, scheme: props.scheme }] : ['sites.prompt.remember']
  if (props.remember === 'deny') return ['sites.prompt.rememberDeny']
  if (props.remember === 'both') return ['sites.prompt.remember']
  return null
}

/** Whether a remember choice applies to this answer. */
export function rememberApplies(remember: PermissionPromptProps['remember'], allow: boolean): boolean {
  return remember === 'both' || (remember === 'allow' && allow) || (remember === 'deny' && !allow)
}

/** The sharing bar's line: screen or tab sharing wins, then camera and microphone. `what` is a noun key to resolve. */
export function sharingMessage(host: string, capture: CaptureState, sharedTab: string | null): { key: MessageKey; host: string; tab?: string; what?: MessageKey } | null {
  if (capture.screen) return sharedTab ? { key: 'sites.sharing.tab', host, tab: sharedTab } : { key: 'sites.sharing.screen', host }
  const what = mediaNoun(capture.camera, capture.microphone)
  return what ? { key: 'sites.sharing.using', host, what } : null
}

/** "camera", "microphone" or "camera and microphone", as a key; null for neither. */
export function mediaNoun(camera: boolean, microphone: boolean): MessageKey | null {
  if (camera && microphone) return 'sites.noun.cameraAndMicrophone'
  if (camera) return 'sites.noun.camera'
  if (microphone) return 'sites.noun.microphone'
  return null
}

/** What is being captured, as row names ("Camera and Microphone"), for site info's live line. */
export function capturingKinds(capture: CaptureState): SitePermission[] {
  const out: SitePermission[] = []
  if (capture.camera) out.push('camera')
  if (capture.microphone) out.push('microphone')
  if (capture.screen) out.push('screen')
  return out
}

/** A Bluetooth PIN or passkey the person typed: 1 to 16 characters, no spaces. */
export function validPin(pin: string): boolean {
  return /^[^\s]{1,16}$/.test(pin.trim())
}

/** The sharing bar's Revoke: the live camera and microphone go back to asking; null when neither is live. */
export function revokePatch(capture: CaptureState): SiteSettingsPatch | null {
  const permissions: SiteSettingsPatch['permissions'] = {}
  if (capture.camera) permissions.camera = 'ask'
  if (capture.microphone) permissions.microphone = 'ask'
  return Object.keys(permissions).length > 0 ? { permissions } : null
}
