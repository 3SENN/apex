/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'

// The running app's own code signature, read straight from its executable's
// embedded signature (LC_CODE_SIGNATURE): the signing team, the identifier
// and the entitlements plist. No codesign subprocess, once per run and cached,
// so startup can decide synchronously, before the first tab exists, whether
// this Apex is signed with Apple's browser passkey entitlement
// (com.apple.developer.web-browser.public-key-credential).
//
// Reading the blob doesn't validate it, and needn't: the kernel already did
// at launch. A restricted entitlement without the provisioning profile that
// grants it never gets this far, because macOS refuses to launch the app.

export const BROWSER_PASSKEY_ENTITLEMENT = 'com.apple.developer.web-browser.public-key-credential'

export interface CodeSignature {
  /** The signing identifier (the bundle id for a bundle's main executable), or null. */
  identifier: string | null
  /** The Team ID; null for ad hoc, linker-signed and Apple platform binaries. */
  teamId: string | null
  /** The entitlements plist (XML), or null when the signature carries none. */
  entitlements: string | null
}

const LC_CODE_SIGNATURE = 0x1d
const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0
const CSMAGIC_CODEDIRECTORY = 0xfade0c02
const CSMAGIC_EMBEDDED_ENTITLEMENTS = 0xfade7171
const CSSLOT_CODEDIRECTORY = 0
const CSSLOT_ENTITLEMENTS = 5
/** CodeDirectory versions from which a field exists. */
const CD_TEAM_SINCE = 0x20200
const CPU_TYPES: Record<string, number> = { arm64: 0x0100000c, x64: 0x01000007 }

/** The NUL-terminated string `offset` bytes into the blob at `blob`; null for offset 0 (absent). */
function cString(buf: Buffer, blob: number, offset: number, end: number): string | null {
  const at = blob + offset
  if (offset <= 0 || at >= end) return null
  const stop = buf.indexOf(0, at)
  if (stop < 0 || stop > end) return null
  return buf.toString('utf8', at, stop) || null
}

/** The offset of the thin Mach-O slice for `arch` (the first slice when none matches), or -1. */
function sliceOffset(buf: Buffer, arch: string): number {
  if (buf.length < 8) return -1
  const magic = buf.readUInt32BE(0)
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return 0
  const wide = magic === FAT_MAGIC_64
  const count = buf.readUInt32BE(4)
  const step = wide ? 32 : 20
  const want = CPU_TYPES[arch]
  let first = -1
  for (let i = 0; i < count && 8 + (i + 1) * step <= buf.length; i++) {
    const at = 8 + i * step
    const cpu = buf.readUInt32BE(at)
    const offset = wide ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8)
    if (first < 0) first = offset
    if (cpu === want) return offset
  }
  return first
}

/** The signature in a Mach-O (thin or universal) executable, or null when it has none or can't be read. */
export function readCodeSignature(buf: Buffer, arch: string = process.arch): CodeSignature | null {
  try {
    const base = sliceOffset(buf, arch)
    if (base < 0 || base + 32 > buf.length || buf.readUInt32LE(base) !== MH_MAGIC_64) return null
    const ncmds = buf.readUInt32LE(base + 16)
    let at = base + 32
    let sig = -1
    let sigEnd = -1
    for (let i = 0; i < ncmds && at + 8 <= buf.length; i++) {
      const cmd = buf.readUInt32LE(at)
      const size = buf.readUInt32LE(at + 4)
      if (cmd === LC_CODE_SIGNATURE) {
        sig = base + buf.readUInt32LE(at + 8)
        sigEnd = sig + buf.readUInt32LE(at + 12)
        break
      }
      if (size < 8) return null
      at += size
    }
    if (sig < 0 || sigEnd > buf.length || buf.readUInt32BE(sig) !== CSMAGIC_EMBEDDED_SIGNATURE) return null
    const out: CodeSignature = { identifier: null, teamId: null, entitlements: null }
    const count = buf.readUInt32BE(sig + 8)
    for (let i = 0; i < count; i++) {
      const type = buf.readUInt32BE(sig + 12 + i * 8)
      const blob = sig + buf.readUInt32BE(sig + 16 + i * 8)
      if (blob + 8 > sigEnd) continue
      const magic = buf.readUInt32BE(blob)
      const end = Math.min(blob + buf.readUInt32BE(blob + 4), sigEnd)
      if (type === CSSLOT_CODEDIRECTORY && magic === CSMAGIC_CODEDIRECTORY) {
        const version = buf.readUInt32BE(blob + 8)
        out.identifier = cString(buf, blob, buf.readUInt32BE(blob + 20), end)
        if (version >= CD_TEAM_SINCE) out.teamId = cString(buf, blob, buf.readUInt32BE(blob + 48), end)
      } else if (type === CSSLOT_ENTITLEMENTS && magic === CSMAGIC_EMBEDDED_ENTITLEMENTS) {
        out.entitlements = buf.toString('utf8', blob + 8, end)
      }
    }
    return out
  } catch {
    return null
  }
}

/** Whether an entitlements plist grants Apple's browser passkey entitlement. */
export function grantsBrowserPasskeys(entitlementsXml: string | null): boolean {
  return !!entitlementsXml && /<key>\s*com\.apple\.developer\.web-browser\.public-key-credential\s*<\/key>\s*<true\s*\/>/.test(entitlementsXml)
}

let own: { path: string; signature: CodeSignature | null } | null = null

/** This process's executable's signature; read once per run (macOS only, else null). */
export function ownSignature(executable: string = process.execPath): CodeSignature | null {
  if (process.platform !== 'darwin') return null
  if (own?.path === executable) return own.signature
  let signature: CodeSignature | null = null
  try {
    signature = readCodeSignature(readFileSync(executable))
  } catch {
    signature = null
  }
  own = { path: executable, signature }
  return signature
}

/**
 * Apex is signed by a team with the browser passkey entitlement: macOS lets
 * it ask for any site's iCloud Keychain passkeys, and Apple's Passwords helper
 * accepts it as a parent process.
 */
export function signedAsBrowser(signature: CodeSignature | null = ownSignature()): boolean {
  return !!signature?.teamId && grantsBrowserPasskeys(signature.entitlements)
}

/** Tests only: forget the cached signature. */
export function resetOwnSignature(): void {
  own = null
}
