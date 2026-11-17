/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, webContents as allWebContents, type Session, type WebContents } from 'electron'
import { isSignInUrl } from '@shared/signInHosts'
import { SYSTEM_PASSKEYS_ARG } from '@shared/webauthnPolicy'
import { ownSignature, signedAsBrowser, type CodeSignature } from './codeSignature'
import { log } from './log'

// Sign-in compatibility (docs/architecture.md "Sign-in compatibility"): the
// browser mechanics "Sign in with …" flows depend on that Electron doesn't
// give a browser by default.
// - FedCM is off. Electron has no FedCM sheet: a request fetches the
//   provider's accounts and then fails, and Google Identity Services, seeing
//   IdentityCredential, never falls back to its popup or redirect. With the
//   FedCm feature off, 'IdentityCredential' in window is false and GIS takes
//   the flows that work.
// - WebAuthn: the platform authenticators the signed app is entitled to
//   (below): the system passkey sheet (iCloud Keychain) with Apple's browser
//   passkey entitlement, Touch ID with the keychain group entitlement (without
//   it Electron's Touch ID setup can stall the main thread), and an account
//   chooser for discoverable credentials. Calls only a passkey sheet could
//   answer, when there is none, are refused in the page (shared/webauthnPolicy.ts).

/** Chromium features Atelier turns off for sign-in flows. FedCm: the IdentityCredential API (verified against Chromium 156 in the sign-in smoke). */
export const DISABLED_FEATURES = ['FedCm'] as const

/** A --disable-features value with `add` merged in: existing names kept, none twice. */
export function mergeFeatureList(existing: string, add: readonly string[]): string {
  const names = existing
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const name of add) if (!names.includes(name)) names.push(name)
  return names.join(',')
}

/** Before ready: the command-line switches. */
export function applySignInSwitches(commandLine: Pick<Electron.CommandLine, 'getSwitchValue' | 'appendSwitch'> = app.commandLine): void {
  commandLine.appendSwitch('disable-features', mergeFeatureList(commandLine.getSwitchValue('disable-features'), DISABLED_FEATURES))
}

// ── the Storage Access API ──

/**
 * document.requestStorageAccess() from a cross-site frame. Chromium asks even
 * when the frame already has its cookies, and the policy table refuses
 * unknown asks, so a sign-in widget that calls it got NotAllowedError. With
 * third-party cookies allowed (the default) granting changes nothing the
 * frame can reach; with them blocked only a sign-in provider gets it, as it
 * keeps its cookies there anyway (privacy.ts). null falls through to the table.
 */
export function storageAccessAnswer(permission: string, origin: string | null, blockThirdParty: boolean): 'allow' | null {
  if (permission !== 'storage-access') return null
  if (!blockThirdParty) return 'allow'
  return origin !== null && isSignInUrl(origin) ? 'allow' : null
}

// ── Platform passkeys (app.configureWebAuthn) ──
//
// What Electron 45 offers, and what Atelier uses (docs/release.md, "Browser
// passkeys and iCloud Passwords"):
// - touchID: Electron's own Secure Enclave authenticator. Device-bound
//   passkeys, never synced, kept under the keychain group
//   <TEAM>.<bundle>.webauthn, which the signature must carry. Serves iframes.
// - platformPasskeys: Apple's ASAuthorizationController, the system passkey
//   sheet (iCloud Keychain and any credential provider extension, synced).
//   Electron's docs gate it on associated domains, which no sign-in provider
//   lists Atelier in. With com.apple.developer.web-browser.public-key-credential,
//   macOS treats Atelier as a web browser and serves any relying party, as for
//   Chrome. Electron notes: no cross-origin iframes, no prf or largeBlob, and
//   clientDataJSON names https://<rpId> as the origin.
// - Chromium's own iCloud Keychain authenticator (device/fido/mac/
//   icloud_keychain, which checks the same entitlement) is compiled into
//   Electron Framework, but nothing turns it on from an Electron app: Chrome's
//   WebAuthn request delegate starts it, and Electron's has no switch or
//   feature flag for it. platformPasskeys is the supported way in.
// Without either entitlement, nothing is configured and the page preload's
// fail-fast table (shared/webauthnPolicy.ts) answers what no sheet could.

/** The `<TEAM>.<bundle>.webauthn` keychain group from a signature's entitlements plist, or null. */
export function webAuthnKeychainGroup(entitlementsXml: string | null): string | null {
  const m = /<key>\s*keychain-access-groups\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(entitlementsXml ?? '')
  if (!m) return null
  const groups = [...m[1]!.matchAll(/<string>\s*([^<]+?)\s*<\/string>/g)].map((g) => g[1]!)
  return groups.find((g) => /^[A-Z0-9]{10}\.[^\s]+\.webauthn$/.test(g)) ?? null
}

/** Touch ID is offered only when the group belongs to the team that signed the app. */
export function touchIdGroup(entitlementsXml: string | null, team: string | null): string | null {
  const group = webAuthnKeychainGroup(entitlementsXml)
  return group && team && group.startsWith(`${team}.`) ? group : null
}

export type PasskeyState =
  | { on: false; reason: 'not-mac' | 'not-packaged' | 'unsigned' | 'no-entitlement' | 'failed' }
  /** touchIdGroup: the keychain group Touch ID passkeys use, or null; platformPasskeys: the system passkey sheet. */
  | { on: true; touchIdGroup: string | null; platformPasskeys: boolean }

/** What the signature allows: Touch ID with the team's keychain group, the system sheet with the browser entitlement. */
export function passkeyPlan(signature: Pick<CodeSignature, 'teamId' | 'entitlements'> | null): PasskeyState {
  if (!signature?.teamId) return { on: false, reason: 'unsigned' }
  const group = touchIdGroup(signature.entitlements, signature.teamId)
  const platformPasskeys = signedAsBrowser({ identifier: null, ...signature })
  if (!group && !platformPasskeys) return { on: false, reason: 'no-entitlement' }
  return { on: true, touchIdGroup: group, platformPasskeys }
}

/** app.configureWebAuthn's options for a plan that is on. */
export function webAuthnOptions(plan: Extract<PasskeyState, { on: true }>): Electron.ConfigureWebAuthnOptions {
  return {
    ...(plan.touchIdGroup ? { touchID: { keychainAccessGroup: plan.touchIdGroup } } : {}),
    ...(plan.platformPasskeys ? { platformPasskeys: true } : {}),
  }
}

let passkeys: PasskeyState = { on: false, reason: process.platform === 'darwin' ? 'not-packaged' : 'not-mac' }

/** Whether passkeys are on (and which), and why not when they aren't. */
export function passkeyState(): PasskeyState {
  return passkeys
}

/**
 * Turns on the platform authenticators the running app's signature allows
 * (codeSignature.ts reads it from the executable, once). Synchronous, so it is
 * settled before the first tab: tabs pass the system sheet on to the page
 * preload (pagePasskeyArguments).
 */
export function configurePasskeys(opts: { packaged?: boolean; signature?: CodeSignature | null } = {}): PasskeyState {
  if (process.platform !== 'darwin') return (passkeys = { on: false, reason: 'not-mac' })
  if (!(opts.packaged ?? app.isPackaged)) return (passkeys = { on: false, reason: 'not-packaged' })
  const plan = passkeyPlan(opts.signature !== undefined ? opts.signature : ownSignature())
  if (!plan.on) return (passkeys = plan)
  try {
    app.configureWebAuthn(webAuthnOptions(plan))
    log.info('signin', 'Passkeys are on', { touchId: plan.touchIdGroup !== null, platformPasskeys: plan.platformPasskeys })
    return (passkeys = plan)
  } catch (err) {
    log.warn('signin', 'Passkeys could not be turned on', { error: err instanceof Error ? err.message : String(err) })
    return (passkeys = { on: false, reason: 'failed' })
  }
}

/** The page preload's arguments (webPreferences.additionalArguments): whether the system passkey sheet is there. */
export function pagePasskeyArguments(): string[] {
  return passkeys.on && passkeys.platformPasskeys ? [SYSTEM_PASSKEYS_ARG] : []
}

export interface PasskeyAccount {
  credentialId: string
  name?: string
  displayName?: string
}

/** How an account reads on its button: the name (usually the email), else the display name. */
export function accountLabel(a: PasskeyAccount, fallback: string): string {
  const label = (a.name || a.displayName || '').trim()
  return label ? label.slice(0, 80) : fallback
}

/**
 * select-webauthn-account: without a listener Electron cancels every
 * discoverable passkey sign-in, even with one match. One account is used as
 * is (Touch ID still asks); several go to `choose`.
 */
export function installAccountChooser(session: Session, choose: (wc: WebContents | null, rpId: string, accounts: PasskeyAccount[]) => Promise<string | null>): void {
  session.on('select-webauthn-account', (event, details, callback) => {
    event.preventDefault()
    const accounts = details.accounts as PasskeyAccount[]
    if (accounts.length === 1) {
      callback(accounts[0]!.credentialId)
      return
    }
    let wc: WebContents | null = null
    try {
      wc = details.frame ? (allWebContents.fromFrame(details.frame) ?? null) : null
    } catch {
      wc = null
    }
    choose(wc, details.relyingPartyId, accounts).then(
      (id) => callback(id ?? undefined),
      () => callback(),
    )
  })
}
