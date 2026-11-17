/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { mainT } from './i18n/mainT'

// Cookie import (ST-46 opt-in): copy a Chromium profile's Cookies database,
// decrypt the macOS v10 values with the browser's Safe Storage key from the
// Keychain, and hand plaintext session cookies to the chosen Atelier profile's
// session. Values and the key live only in memory and are zeroed after use;
// nothing here ever logs a cookie value or the key. macOS only — other
// platforms encrypt cookies differently and are never offered this type.

/** Chromium's macOS scheme: PBKDF2 over this salt for 1003 rounds to a 16-byte AES key. */
const SALT = 'saltysalt'
const PBKDF2_ROUNDS = 1003
const KEY_LENGTH = 16
/** AES-128-CBC with an IV of sixteen spaces (0x20). */
const IV = Buffer.alloc(16, 0x20)
/** Newer Chromium (meta version ≥ 24) prepends a SHA256 of the host to the plaintext. */
const HOST_HASH_VERSION = 24
const HOST_HASH_BYTES = 32
/** Microseconds between 1601-01-01 (Chromium's epoch) and 1970-01-01, in seconds. */
const CHROME_EPOCH_OFFSET_S = 11_644_473_600

export type SameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

/** One decrypted cookie, ready to set into a session. */
export interface ImportedCookie {
  /** The Chromium host_key: a leading dot marks a domain (subdomain-wide) cookie. */
  host: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: SameSite
  /** Seconds since the Unix epoch, or null for a session-only cookie. */
  expirationDate: number | null
}

/** The options Electron's session.cookies.set takes, built without importing electron here. */
export interface CookieSetDetails {
  url: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: SameSite
  domain?: string
  expirationDate?: number
}

/** The small slice of a session's cookies API the writer needs (keeps this testable). */
export interface CookieWriter {
  set(details: CookieSetDetails): Promise<void>
}

/** Counts for the log line and the summary; never any values. */
export interface CookieWriteResult {
  imported: number
  skipped: number
  sites: number
}

/** The Keychain service holding a browser's Safe Storage password (Arc: "Arc Safe Storage"). */
export function safeStorageService(browserId: string, browserName: string): string {
  const byId: Record<string, string> = {
    chrome: 'Chrome Safe Storage',
    arc: 'Arc Safe Storage',
    brave: 'Brave Safe Storage',
    edge: 'Microsoft Edge Safe Storage',
    vivaldi: 'Vivaldi Safe Storage',
    chromium: 'Chromium Safe Storage',
  }
  return byId[browserId] ?? `${browserName} Safe Storage`
}

type ExecFileRun = (file: string, args: string[]) => Promise<{ stdout: string }>
const execFileAsync: ExecFileRun = promisify(execFile)

/**
 * Reads the Safe Storage password from the Keychain with `security`, no shell.
 * This is what triggers macOS's prompt; a denial (non-zero exit) throws the
 * plain "couldn't read the key" message, and the caller imports nothing.
 */
export async function keychainPassword(service: string, run: ExecFileRun = execFileAsync): Promise<string> {
  try {
    const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-w', '-s', service])
    const password = stdout.replace(/\n$/, '')
    if (!password) throw new Error('empty')
    return password
  } catch {
    throw new Error(mainT('settings.import.error.cookiesDenied'))
  }
}

/** The AES key for a browser's cookies from its Safe Storage password. */
export function deriveCookieKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, PBKDF2_ROUNDS, KEY_LENGTH, 'sha1')
}

/**
 * Decrypts one Chromium v10 value. Returns null (so the cookie is skipped) for
 * an empty blob, a scheme that isn't v10, or any decryption failure. The
 * decrypted buffer is zeroed before returning.
 */
export function decryptCookieValue(encrypted: Buffer, key: Buffer, metaVersion: number): string | null {
  if (encrypted.length <= 3) return null
  if (encrypted.subarray(0, 3).toString('latin1') !== 'v10') return null
  let plain: Buffer | null = null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV)
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
    const body = metaVersion >= HOST_HASH_VERSION ? plain.subarray(HOST_HASH_BYTES) : plain
    return body.toString('utf8')
  } catch {
    return null
  } finally {
    plain?.fill(0)
  }
}

/** Chromium's expires_utc (microseconds since 1601) to seconds since 1970; null when session-only (0). */
export function chromiumCookieExpiry(expiresUtc: bigint): number | null {
  if (expiresUtc <= 0n) return null
  return Number(expiresUtc / 1_000_000n) - CHROME_EPOCH_OFFSET_S
}

/** Chromium's samesite column (-1/0/1/2) to the session API's names. */
export function mapSameSite(value: number): SameSite {
  if (value === 0) return 'no_restriction'
  if (value === 1) return 'lax'
  if (value === 2) return 'strict'
  return 'unspecified'
}

/**
 * The session.cookies.set options for one cookie, or null to skip it (no host,
 * or already expired). Host-only cookies (host_key without a leading dot) omit
 * `domain` so the session keeps them host-bound; domain cookies pass the dotted
 * host so they apply to subdomains, as Chromium stored them.
 */
export function cookieSetDetails(cookie: ImportedCookie, nowSeconds: number): CookieSetDetails | null {
  const host = cookie.host.replace(/^\./, '')
  if (!host) return null
  if (cookie.expirationDate !== null && cookie.expirationDate <= nowSeconds) return null
  const path = cookie.path || '/'
  const scheme = cookie.secure ? 'https' : 'http'
  const details: CookieSetDetails = {
    url: `${scheme}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  }
  if (cookie.host.startsWith('.')) details.domain = cookie.host
  if (cookie.expirationDate !== null) details.expirationDate = cookie.expirationDate
  return details
}

interface Logger {
  info(source: string, message: string, data?: Record<string, unknown>): void
  warn(source: string, message: string, data?: Record<string, unknown>): void
}

/**
 * Sets every importable cookie into the session, skipping expired ones and any
 * the session rejects. Returns counts only (imported, skipped, distinct sites).
 * The final count the summary shows is the number of sites; no value is logged.
 */
export async function writeCookies(writer: CookieWriter, cookies: readonly ImportedCookie[], nowSeconds: number, logger: Logger): Promise<CookieWriteResult> {
  const sites = new Set<string>()
  let imported = 0
  let skipped = 0
  for (const cookie of cookies) {
    const details = cookieSetDetails(cookie, nowSeconds)
    if (!details) {
      skipped++
      continue
    }
    try {
      await writer.set(details)
      imported++
      sites.add(cookie.host.replace(/^\./, ''))
    } catch {
      // A single cookie the session won't take (bad name, odd host) is skipped.
      skipped++
    }
  }
  logger.info('import', 'cookies written', { imported, skipped, sites: sites.size })
  return { imported, skipped, sites: sites.size }
}

interface CookieRow {
  host_key: unknown
  name: unknown
  encrypted_value: unknown
  value: unknown
  path: unknown
  is_secure: unknown
  is_httponly: unknown
  expires_utc: unknown
  samesite: unknown
}

const toBuffer = (value: unknown): Buffer => (Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.alloc(0))
const toBig = (value: unknown): bigint => (typeof value === 'bigint' ? value : BigInt(Number(value) || 0))

/** The path a Chromium profile keeps its cookies at: newer builds use Network/Cookies. */
export function cookiesFilePath(profileDir: string): string | null {
  const network = join(profileDir, 'Network', 'Cookies')
  if (existsSync(network)) return network
  const legacy = join(profileDir, 'Cookies')
  return existsSync(legacy) ? legacy : null
}

/** Copies a locked SQLite file (and its sidecars) to a temp dir, reads it, then deletes the copy. */
function withCookieCopy<T>(file: string, read: (copy: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-cookies-'))
  const copy = join(dir, 'Cookies')
  try {
    copyFileSync(file, copy)
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix)
    return read(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Reads and decrypts every cookie in a Chromium Cookies database with the
 * given key. The database file is copied first (the source browser may hold it
 * locked). Cookies whose value won't decrypt are skipped. Uses the same
 * node:sqlite reader the history import uses.
 */
export function readChromiumCookies(cookiesFile: string, key: Buffer): { cookies: ImportedCookie[]; decryptFailures: number } {
  return withCookieCopy(cookiesFile, (copy) => {
    const db = new DatabaseSync(copy, { readOnly: true })
    const cookies: ImportedCookie[] = []
    let decryptFailures = 0
    try {
      let metaVersion = 0
      try {
        const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined
        metaVersion = Number(meta?.value) || 0
      } catch {
        // No meta table: treat as an old database without the host-hash prefix.
      }
      const statement = db.prepare('SELECT host_key, name, encrypted_value, value, path, is_secure, is_httponly, expires_utc, samesite FROM cookies')
      statement.setReadBigInts(true)
      for (const raw of statement.all() as unknown as CookieRow[]) {
        const encrypted = toBuffer(raw.encrypted_value)
        const plaintext = typeof raw.value === 'string' ? raw.value : ''
        const value = encrypted.length > 0 ? decryptCookieValue(encrypted, key, metaVersion) : plaintext
        if (value === null) {
          decryptFailures++
          continue
        }
        cookies.push({
          host: String(raw.host_key ?? ''),
          name: String(raw.name ?? ''),
          value,
          path: String(raw.path ?? '/'),
          secure: Boolean(Number(raw.is_secure)),
          httpOnly: Boolean(Number(raw.is_httponly)),
          sameSite: mapSameSite(Number(raw.samesite)),
          expirationDate: chromiumCookieExpiry(toBig(raw.expires_utc)),
        })
      }
    } finally {
      db.close()
      key.fill(0)
    }
    return { cookies, decryptFailures }
  })
}
