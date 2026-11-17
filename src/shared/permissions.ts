/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The permission policy table (OV-10). Pure, so it is unit-tested
// in node: which Electron permission requests are allowed or denied without a
// word, which ask, which site permissions they map to, and what an answer may
// be remembered as. src/main/permissions.ts applies it to every session.
import type { PermissionDecision, SitePermission } from './sites'

/** What the table says about one request before any stored answer is consulted. */
export type PolicyAction = { action: 'allow' } | { action: 'deny' } | { action: 'ask'; perms: SitePermission[] }

/** Granted without asking: harmless or already user-initiated. */
export const SILENT_ALLOW: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'persistent-storage',
  'mediaKeySystem',
  'screen-wake-lock',
  'sensors',
  'fullscreen',
])

/** Refused without asking: Apex doesn't offer these to sites. Full screen without a click (automatic-fullscreen) is off, as in Chrome. */
export const SILENT_DENY: ReadonlySet<string> = new Set([
  'automatic-fullscreen',
  'ar',
  'vr',
  'hand-tracking',
  'background-fetch',
  'background-sync',
  'periodic-background-sync',
  'web-app-installation',
  'system-wake-lock',
  'payment-handler',
  'nfc',
  'smart-card',
  'web-printing',
  'captured-surface-control',
  'deprecated-sync-clipboard-read',
  'storage-access',
  'top-level-storage-access',
  'unknown',
])

/** Electron permission names that ask, and the site permission each one is. */
const ASKS: Readonly<Record<string, SitePermission>> = {
  geolocation: 'location',
  'geolocation-approximate': 'location',
  notifications: 'notifications',
  'clipboard-read': 'clipboard-read',
  'local-fonts': 'local-fonts',
  'idle-detection': 'idle-detection',
  'speaker-selection': 'speaker-selection',
  'local-network': 'local-network',
  'local-network-access': 'local-network',
  'loopback-network': 'local-network',
  midi: 'midi',
  midiSysex: 'midi',
  'display-capture': 'screen',
  fileSystem: 'file-system',
  openExternal: 'external-app',
  hid: 'hid',
  usb: 'usb',
  serial: 'serial',
  'window-management': 'window-management',
}

/** The device classes: the chooser is their prompt, so the check itself passes unless the site is blocked. */
export const DEVICE_PERMISSIONS: ReadonlySet<SitePermission> = new Set(['hid', 'usb', 'serial', 'bluetooth'])

/** Camera and microphone from a 'media' request's media types (video is the camera). */
export function mediaPerms(mediaTypes: readonly string[] | undefined): SitePermission[] {
  const types = mediaTypes ?? []
  const out: SitePermission[] = []
  if (types.includes('video')) out.push('camera')
  if (types.includes('audio')) out.push('microphone')
  // A request that names neither is treated as both, so nothing slips through unasked.
  return out.length > 0 ? out : ['camera', 'microphone']
}

/** Apex's own UI and pages. */
export function isApexOrigin(origin: string): boolean {
  return origin === 'app://apex' || origin.startsWith('apex:')
}

/** Mail links open without asking (OV-10). */
export function isSilentExternal(url: string): boolean {
  return /^mailto:/i.test(url)
}

/** The scheme of an external link, lowercased and without the colon, or null. */
export function externalScheme(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(url)
  return m ? m[1]!.toLowerCase() : null
}

/**
 * The table's answer for one Electron permission request. `mediaTypes` comes
 * with 'media' requests; `origin` lets Apex pages read the clipboard.
 */
export function classifyPermission(permission: string, opts: { mediaTypes?: readonly string[]; origin?: string; url?: string } = {}): PolicyAction {
  if (opts.origin && isApexOrigin(opts.origin) && (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')) return { action: 'allow' }
  if (permission === 'openExternal' && opts.url && isSilentExternal(opts.url)) return { action: 'allow' }
  if (SILENT_ALLOW.has(permission)) return { action: 'allow' }
  if (SILENT_DENY.has(permission)) return { action: 'deny' }
  if (permission === 'media') return { action: 'ask', perms: mediaPerms(opts.mediaTypes) }
  const perm = ASKS[permission]
  if (perm) return { action: 'ask', perms: [perm] }
  // Anything Apex doesn't know yet is refused, so a new Chromium permission never opens by default.
  return { action: 'deny' }
}

/** What an answer to `perm` may be remembered as: MIDI, screen and file system remember only a deny; external apps only an allow. */
export function rememberable(perm: SitePermission): 'both' | 'deny-only' | 'allow-only' {
  if (perm === 'midi' || perm === 'screen' || perm === 'file-system') return 'deny-only'
  if (perm === 'external-app') return 'allow-only'
  return 'both'
}

/** Whether an answer for every one of `perms` may be remembered (the prompt offers the choice only then). */
export function canRemember(perms: readonly SitePermission[], allowed: boolean): boolean {
  return perms.length > 0 && perms.every((p) => {
    const rule = rememberable(p)
    return rule === 'both' || (rule === 'deny-only' ? !allowed : allowed)
  })
}

/** The choices site info and site settings offer for one permission. */
export function decisionOptions(perm: SitePermission): PermissionDecision[] {
  const rule = rememberable(perm)
  if (rule === 'deny-only') return ['ask', 'block']
  if (rule === 'allow-only') return ['ask', 'allow']
  return ['ask', 'allow', 'block']
}

/**
 * Folds stored answers for several permissions into one: any block blocks,
 * all allowed allows, anything else still asks. A 'media' request for camera
 * and microphone is allowed only if both are.
 */
export function combineDecisions(decisions: readonly PermissionDecision[]): PermissionDecision {
  if (decisions.length === 0) return 'ask'
  if (decisions.includes('block')) return 'block'
  return decisions.every((d) => d === 'allow') ? 'allow' : 'ask'
}

/**
 * The key a site's settings are stored under: scheme, host and port,
 * lowercased, for http(s) pages only (file, data and about pages have none).
 */
export function siteKey(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return parsed.origin.toLowerCase()
}

/** Identical simultaneous requests share one prompt: same tab, origin and permissions. */
export function promptKey(tabId: string, origin: string, perms: readonly SitePermission[], detail = ''): string {
  return `${tabId}|${origin}|${[...perms].sort().join('+')}|${detail}`
}

// ── permissions pass: decisions ──

/** Powerful features a page on a non-secure origin never gets (Chrome keeps them to secure contexts). */
export const SECURE_ONLY: ReadonlySet<SitePermission> = new Set([
  'camera',
  'microphone',
  'location',
  'notifications',
  'clipboard-read',
  'midi',
  'screen',
  'hid',
  'usb',
  'serial',
  'bluetooth',
  'local-fonts',
  'idle-detection',
  'window-management',
  'speaker-selection',
  'file-system',
  'local-network',
])

/**
 * Whether an origin counts as secure: https, or http on this computer
 * (localhost, *.localhost, 127.0.0.0/8, [::1]), as Chromium's "potentially
 * trustworthy" rule has it.
 */
export function isSecureOrigin(origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** Permissions a cross-origin frame can never be given: Chromium has no permission policy to delegate them, and Chrome refuses them there. */
export const TOP_FRAME_ONLY: ReadonlySet<SitePermission> = new Set(['notifications'])

/**
 * Whose question a request is (Chrome's permission delegation): the top-level
 * page's. A same-origin frame asks as the page; a cross-origin frame Chromium
 * let through (its permission policy delegated the feature) asks as the page
 * too, and `embedded` names it. Null refuses: a cross-origin frame asking for
 * something that can't be delegated, or a frame with an opaque origin.
 */
export function frameScope(
  requestingOrigin: string,
  topOrigin: string,
  isMainFrame: boolean,
  perms: readonly SitePermission[],
): { key: string; embedded: string | null } | null {
  const key = siteKey(topOrigin)
  if (!key) return null
  if (isMainFrame) return { key, embedded: null }
  // about:blank and srcdoc frames inherit their parent's origin.
  if (requestingOrigin === '' || /^about:(blank|srcdoc)$/i.test(requestingOrigin)) return { key, embedded: null }
  const frame = siteKey(requestingOrigin)
  if (!frame) return null
  if (frame === key) return { key, embedded: null }
  if (perms.some((p) => TOP_FRAME_ONLY.has(p))) return null
  return { key, embedded: frame }
}

/** Whether a page may use `perms` at all from where it is: secure contexts only for the powerful ones. */
export function secureEnough(scope: { key: string; embedded: string | null }, perms: readonly SitePermission[]): boolean {
  if (!perms.some((p) => SECURE_ONLY.has(p))) return true
  return isSecureOrigin(scope.key) && (scope.embedded === null || isSecureOrigin(scope.embedded))
}

/** Why a site's request is refused without a prompt, or null when nothing stands in the way. */
export type BlockReason = 'stored' | 'once' | 'default' | 'embargo'

/**
 * The site's answer for `perms` before any prompt: a stored answer first,
 * then this tab's one-off answers, then the profile's default (a 'block'
 * there refuses only where the site has no stored answer of its own), then
 * an embargo after repeated dismissals. 'ask' means a prompt may decide.
 */
export function siteVerdict(input: {
  perms: readonly SitePermission[]
  stored: Partial<Record<SitePermission, PermissionDecision>>
  once: boolean | undefined
  defaults: Partial<Record<SitePermission, 'ask' | 'block'>>
  embargoed: (perm: SitePermission) => boolean
}): { verdict: 'allow' } | { verdict: 'ask' } | { verdict: 'block'; reason: BlockReason } {
  const { perms, stored } = input
  const combined = combineDecisions(perms.map((p) => stored[p] ?? 'ask'))
  if (combined === 'block') return { verdict: 'block', reason: 'stored' }
  if (combined === 'allow') return { verdict: 'allow' }
  if (input.once === true) return { verdict: 'allow' }
  if (input.once === false) return { verdict: 'block', reason: 'once' }
  const open = perms.filter((p) => (stored[p] ?? 'ask') === 'ask')
  if (open.some((p) => input.defaults[p] === 'block')) return { verdict: 'block', reason: 'default' }
  if (open.some((p) => input.embargoed(p))) return { verdict: 'block', reason: 'embargo' }
  return { verdict: 'ask' }
}

/** One tab's one-off answer for several permissions: all allowed allows, any refused refuses, anything else is undecided. */
export function oneOffAnswer(answers: ReadonlyMap<string, boolean> | undefined, origin: string, perms: readonly SitePermission[]): boolean | undefined {
  if (!answers || perms.length === 0) return undefined
  const each = perms.map((p) => answers.get(oneOffKey(origin, p)))
  if (each.includes(false)) return false
  return each.every((a) => a === true) ? true : undefined
}

/** One-off answers are kept per permission, so a camera-and-microphone answer also answers a camera-only check. */
export function oneOffKey(origin: string, perm: SitePermission): string {
  return `${origin}|${perm}`
}

// Chrome's embargo: three dismissals of the same question block it for a week.
export const EMBARGO_DISMISSALS = 3
export const EMBARGO_MS = 7 * 24 * 60 * 60 * 1000

/** What a site's past prompts for one permission left behind (main/permissionHistory.ts keeps them per profile). */
export interface PromptHistory {
  /** Prompts put away without an answer since the last answer or embargo. */
  dismissals: number
  /** Asked again no sooner than this (ms since the epoch). */
  embargoUntil?: number
  /** The person refused it once (this tab only); notification requests then ask quietly. */
  refused?: boolean
}

export function isEmbargoed(history: PromptHistory | undefined, now: number): boolean {
  return history?.embargoUntil !== undefined && history.embargoUntil > now
}

/** One more dismissal; the third in a row starts the embargo and the count over. */
export function afterDismissal(history: PromptHistory | undefined, now: number): PromptHistory {
  const lapsed = history?.embargoUntil !== undefined && history.embargoUntil <= now
  const dismissals = (lapsed ? 0 : (history?.dismissals ?? 0)) + 1
  const base: PromptHistory = { dismissals, ...(history?.refused ? { refused: true } : {}) }
  return dismissals >= EMBARGO_DISMISSALS ? { ...base, dismissals: 0, embargoUntil: now + EMBARGO_MS } : base
}

/** An answer ends the dismissal count; a one-off refusal is remembered for quiet notification requests. */
export function afterAnswer(history: PromptHistory | undefined, allowed: boolean): PromptHistory {
  return { dismissals: 0, ...(!allowed || history?.refused ? { refused: true } : {}) }
}

/**
 * Notification requests ask quietly (an address-bar chip, no prompt) when the
 * person turned that on, or once the site's notification prompt was put away
 * or refused before.
 */
export function asksQuietly(perms: readonly SitePermission[], quietSetting: boolean, history: PromptHistory | undefined): boolean {
  if (perms.length !== 1 || perms[0] !== 'notifications') return false
  return quietSetting || (history?.dismissals ?? 0) > 0 || history?.refused === true || history?.embargoUntil !== undefined
}

/** A quiet request that nobody answers ends as a dismissal after this long. */
export const QUIET_TIMEOUT_MS = 60_000

/** navigator.permissions.query names that are site permissions here, so the page reads Apex's answer for them. */
export const QUERY_NAMES: Readonly<Record<string, SitePermission>> = {
  geolocation: 'location',
  notifications: 'notifications',
  push: 'notifications',
  camera: 'camera',
  microphone: 'microphone',
  'clipboard-read': 'clipboard-read',
  midi: 'midi',
  'local-fonts': 'local-fonts',
  'idle-detection': 'idle-detection',
  'window-management': 'window-management',
  'speaker-selection': 'speaker-selection',
  'local-network-access': 'local-network',
}

export type QueryState = 'granted' | 'denied' | 'prompt'

/** A frame's states for the QUERY_NAMES (PAGE.permissions). */
export type QueryStates = Record<string, QueryState>

/** What permissions.query reports for a verdict: undecided is 'prompt', never 'denied'. */
export function queryState(verdict: 'allow' | 'ask' | 'block'): QueryState {
  return verdict === 'allow' ? 'granted' : verdict === 'block' ? 'denied' : 'prompt'
}
