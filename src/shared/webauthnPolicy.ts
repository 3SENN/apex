/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// WebAuthn without a browser sheet (sign-in compatibility; docs/architecture.md
// "Sign-in compatibility"). Electron runs WebAuthn with no UI of its own: no
// passkey picker, no phone QR code (hybrid), no PIN entry and no autofill
// list. A request only such a sheet could answer never settles there, and a
// provider's page sits on "Use your passkey" until its own timeout. The page
// preload (preload/page/webauthn.ts) asks this table, per call, what to do:
// refuse at once with NotAllowedError (what a person dismissing Chrome's
// sheet looks like to the site), hand it to Chromium (a USB security key can
// still answer: a touch needs no UI), or hold a conditional (autofill)
// request until the page aborts it, as Chrome does when it has nothing to
// list. With a platform authenticator configured (Touch ID) passkey calls go
// to Chromium too, and with the system passkey sheet (an Apex signed with
// Apple's browser passkey entitlement, main/signInCompat.ts) every call does:
// the sheet answers or the person cancels it, as in Chrome.

export type WebAuthnDecision = 'pass' | 'reject' | 'hold'

/** The page preload's argument (webPreferences.additionalArguments) when the system passkey sheet is configured. */
export const SYSTEM_PASSKEYS_ARG = '--apex-system-passkeys'

/** The parts of a create() or get() call the decision reads, as plain strings. */
export interface WebAuthnCall {
  kind: 'create' | 'get'
  /** A platform authenticator (Touch ID) is configured: isUserVerifyingPlatformAuthenticatorAvailable() is true. */
  platform: boolean
  /** The system passkey sheet (iCloud Keychain) serves this frame: configured, and the frame is top-level or same-origin with it. */
  sheet?: boolean
  mediation?: string
  /** create: authenticatorSelection.authenticatorAttachment. */
  attachment?: string
  /** create: authenticatorSelection.residentKey and the older requireResidentKey. */
  residentKey?: string
  requireResidentKey?: boolean
  /** create: authenticatorSelection.userVerification; get: publicKey.userVerification. */
  userVerification?: string
  hints?: string[]
  /** get: each allowed credential's transports (an empty list when it names none); null without allowCredentials. */
  allow?: string[][] | null
}

/** Transports a security key uses; Chromium reaches these without any UI. */
const ROAMING = new Set(['usb', 'nfc', 'ble', 'smart-card'])

/** Pass-through calls still settle: Chromium's own timeout, capped so a site's "five minutes" isn't a five-minute wait. */
export const WEBAUTHN_MAX_TIMEOUT_MS = 90_000

export function cappedTimeout(timeout: unknown): number {
  const t = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : WEBAUTHN_MAX_TIMEOUT_MS
  return Math.min(t, WEBAUTHN_MAX_TIMEOUT_MS)
}

export function webAuthnDecision(call: WebAuthnCall): WebAuthnDecision {
  // Autofill passkeys need a list Apex doesn't draw: wait, as Chrome does with nothing to offer.
  if (call.kind === 'get' && call.mediation === 'conditional') return 'hold'
  // Apple's sheet offers passkeys, a phone and security keys, and settles when the person cancels.
  if (call.sheet) return 'pass'
  const usable = new Set(ROAMING)
  if (call.platform) usable.add('internal')
  // Hints name what the site wants shown; a phone (hybrid) has no QR code here.
  const hints = (call.hints ?? []).filter((h) => h === 'security-key' || h === 'client-device' || h === 'hybrid')
  if (hints.length > 0 && !hints.some((h) => h === 'security-key' || (h === 'client-device' && call.platform))) return 'reject'
  if (call.platform) {
    if (call.kind === 'get' && call.allow && call.allow.length > 0 && call.allow.every((t) => t.length > 0 && !t.some((x) => usable.has(x)))) return 'reject'
    return 'pass'
  }
  // No platform authenticator, and a security key's PIN would need a sheet to type it in.
  if (call.userVerification === 'required') return 'reject'
  if (call.kind === 'create') {
    if (call.attachment === 'platform') return 'reject'
    // A discoverable credential (a passkey) on a key needs its PIN too.
    if (call.residentKey === 'required' || (call.residentKey === undefined && call.requireResidentKey === true)) return 'reject'
    return 'pass'
  }
  // get without allowCredentials asks for a passkey: only a picker could offer one.
  if (!call.allow || call.allow.length === 0) return 'reject'
  // Every allowed credential lives on this device or a phone: nothing here can answer.
  if (call.allow.every((t) => t.length > 0 && !t.some((x) => usable.has(x)))) return 'reject'
  return 'pass'
}

/** getClientCapabilities() as Apex can honour it: no phone sign-in, no autofill, a platform authenticator only when one is configured. */
export function honestCapabilities(caps: Record<string, boolean>, platform: boolean): Record<string, boolean> {
  const out: Record<string, boolean> = { ...caps }
  out.hybridTransport = false
  out.conditionalGet = false
  out.conditionalCreate = false
  out.immediateGet = false
  out.userVerifyingPlatformAuthenticator = platform
  out.passkeyPlatformAuthenticator = platform
  return out
}
