/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apple Passwords (iCloud Keychain) in Apex, macOS only: Apple's own
// "iCloud Passwords" extension, always downloaded from the Chrome Web Store
// through Apex's verified install path (never bundled), talking to Apple's
// helper (macOS 14+ installs it for Chrome at HELPER_MANIFEST_PATH). The
// status below is read from what the extension and its native port expose:
// the helper's manifest and binary, whether the extension runs, its toolbar
// icon (paired or unpaired) and the helper's own replies on the port.

export const APPLE_PASSWORDS_EXTENSION_ID = 'pejdijmoenmkgeppbflobdenhhabjlaj'
export const APPLE_PASSWORDS_HOST = 'com.apple.passwordmanager'
/** Where macOS installs the helper's manifest for Chrome (Apex reads Chrome's folder, read-only). */
export const HELPER_MANIFEST_PATH = '/Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json'

export type ApplePasswordsState =
  /** Not a Mac: the card isn't shown. */
  | 'unavailable'
  /** Apple's helper isn't installed (its manifest or binary is missing, or it doesn't list the extension). */
  | 'helper-missing'
  /** The helper is there; the extension isn't installed or is turned off. */
  | 'off'
  /** Downloading, checking and installing the extension. */
  | 'installing'
  /** The extension runs; the helper hasn't answered yet. */
  | 'starting'
  /** The helper answered; this browser isn't paired yet (open the popup to pair). */
  | 'not-paired'
  /** The helper asked macOS to show a 6-digit code; type it in the popup. */
  | 'waiting-for-code'
  /** Paired: the extension's toolbar icon says so. */
  | 'ready'
  /** The helper closed the connection before it answered. */
  | 'helper-closed'
  /** The helper says iCloud Passwords are off on this Mac, or need you to sign in again. */
  | 'icloud-off'
  /**
   * macOS refused to start the helper for Apex: it only runs under a browser
   * signed with Apple's browser passkey entitlement (or one Apple lists).
   * Seen as the helper killed at exec, or gone at once without a word.
   */
  | 'needs-signed-apex'

export interface ApplePasswordsStatus {
  state: ApplePasswordsState
  /** The extension is installed in this profile (on or off). */
  installed: boolean
  enabled: boolean
  /** Apex's own password offers and save prompts are stepping aside right now. */
  apexStepsAside: boolean
  /** Another password extension (not Apple's) controls password saving, by name; null when none. */
  otherController: string | null
  /** The helper's last error on the port, as plain words; null when none. */
  error: string | null
  /** This Apex is signed with Apple's browser passkey entitlement, so macOS lets it start the helper. */
  signedAsBrowser: boolean
}

export interface ApplePasswordsServices {
  applePasswords: {
    status(): ApplePasswordsStatus
    /**
     * On: downloads the extension from the Chrome Web Store, verifies it,
     * asks once (the install prompt), installs, pins it and opens its popup
     * for the code. Off: turns the extension off (it stays installed).
     */
    setOn(on: boolean): Promise<ApplePasswordsStatus>
    /** Restarts the extension's connection to the helper and opens its popup for a new code. */
    pairAgain(): Promise<ApplePasswordsStatus>
  }
}

export type ApplePasswordsEvent = { type: 'apple-passwords'; status: ApplePasswordsStatus }

/** What the status is computed from. Every field is something Apex observed, nothing guessed. */
export interface ApplePasswordsInputs {
  mac: boolean
  installing: boolean
  helper: { manifest: boolean; binary: boolean; allowsExtension: boolean }
  extension: { installed: boolean; enabled: boolean; running: boolean }
  /** The open native port to the helper, or the last one when none is open. */
  port: { open: boolean; replied: boolean; closedWithError: string | null; launchRefused?: boolean } | null
  /** Apex is signed with the browser passkey entitlement (main/codeSignature.ts). */
  signedAsBrowser?: boolean
  /** The path the extension last set for its toolbar icon (chrome.action.setIcon), or null. */
  iconPath: string | null
  /** The helper's last command on the port (its `cmd` field), or null. */
  lastHelperCmd: number | null
  /** The helper answered the extension's pairing challenge (macOS now shows a code). */
  codeRequested: boolean
}

/** How a native host ended by itself (main/extensions/nativeMessaging.ts NativeExit). */
export interface HostExit {
  code: number | null
  signal: string | null
  ms: number
  output: boolean
}

/** A host gone this fast, without a byte, never got to run. */
export const LAUNCH_REFUSED_MS = 2000

/**
 * Whether the helper was refused at launch rather than ending: macOS's launch
 * constraint kills it at exec (SIGKILL before any output), or the helper
 * checks its parent and exits at once without writing anything.
 */
export function launchRefused(exit: HostExit | null): boolean {
  if (!exit || exit.output || exit.ms > LAUNCH_REFUSED_MS) return false
  return exit.signal === 'SIGKILL' || exit.signal === null
}

// The helper's commands, named in the extension's own code (cmd2string).
const CMD_PASSWORDS_DISABLED = 9
const CMD_RELOGIN_NEEDED = 10

/** The extension's toolbar icon names: "PasswordsToolbar" when paired, "PasswordsToolbarUnpaired" when not. */
export function iconSaysPaired(path: string | null): boolean | null {
  if (!path) return null
  if (/PasswordsToolbarUnpaired/.test(path)) return false
  if (/PasswordsToolbar(?:-darkmode)?_icon/.test(path)) return true
  return null
}

/** The card's state from what Apex observed. */
export function applePasswordsState(i: ApplePasswordsInputs): ApplePasswordsState {
  if (!i.mac) return 'unavailable'
  if (i.installing) return 'installing'
  if (!i.helper.manifest || !i.helper.binary || !i.helper.allowsExtension) return 'helper-missing'
  if (!i.extension.installed || !i.extension.enabled) return 'off'
  if (!i.extension.running) return 'starting'
  const paired = iconSaysPaired(i.iconPath)
  if (i.port?.open && paired === true) return 'ready'
  if (i.lastHelperCmd === CMD_PASSWORDS_DISABLED || i.lastHelperCmd === CMD_RELOGIN_NEEDED) return 'icloud-off'
  if (!i.port) return 'starting'
  // The extension reconnects by itself a moment after a drop; a port that stays closed means the helper ended it.
  // Refused at launch means macOS wants a signed Apex; once Apex is signed with the entitlement, a closed port is the helper's own doing.
  if (!i.port.open) return i.port.launchRefused && !i.signedAsBrowser ? 'needs-signed-apex' : 'helper-closed'
  if (!i.port.replied) return 'starting'
  if (paired === true) return 'ready'
  return i.codeRequested ? 'waiting-for-code' : 'not-paired'
}
