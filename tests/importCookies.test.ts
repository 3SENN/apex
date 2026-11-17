/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createCipheriv, createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  chromiumCookieExpiry,
  cookieSetDetails,
  decryptCookieValue,
  deriveCookieKey,
  keychainPassword,
  mapSameSite,
  readChromiumCookies,
  safeStorageService,
  writeCookies,
  type CookieSetDetails,
  type ImportedCookie,
} from '../src/main/importCookies'

// Cookie import (ST-46 opt-in). The fixture Cookies database is built here and
// its values encrypted with a test password using Chromium's own macOS scheme,
// so the decryption path is exercised end to end without touching a real
// browser, the Keychain or the network.

const PASSWORD = 'peanuts'
const IV = Buffer.alloc(16, 0x20)
const CHROME_EPOCH_OFFSET_S = 11_644_473_600

/** Encrypt a value the way Chromium does on macOS; with a host, prepend its SHA256 (meta ≥ 24). */
function encryptV10(value: string, host: string | null): Buffer {
  const key = deriveCookieKey(PASSWORD)
  const prefix = host ? createHash('sha256').update(host).digest() : Buffer.alloc(0)
  const plain = Buffer.concat([prefix, Buffer.from(value, 'utf8')])
  const cipher = createCipheriv('aes-128-cbc', key, IV)
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()])
}

describe('cookie decryption (ST-46)', () => {
  it('decrypts v10 values with and without the 32-byte host hash', () => {
    expect(decryptCookieValue(encryptV10('tok', null), deriveCookieKey(PASSWORD), 20)).toBe('tok')
    expect(decryptCookieValue(encryptV10('tok', 'youtube.com'), deriveCookieKey(PASSWORD), 24)).toBe('tok')
  })

  it('skips an empty blob, a non-v10 scheme and anything that fails to decrypt', () => {
    const key = deriveCookieKey(PASSWORD)
    expect(decryptCookieValue(Buffer.alloc(0), key, 24)).toBeNull()
    expect(decryptCookieValue(Buffer.from('v11abcd'), key, 24)).toBeNull()
    expect(decryptCookieValue(Buffer.concat([Buffer.from('v10'), Buffer.from('short')]), key, 24)).toBeNull()
  })
})

describe('cookie field conversions (ST-46)', () => {
  it('converts expiry microseconds and treats 0 as a session cookie', () => {
    expect(chromiumCookieExpiry(0n)).toBeNull()
    expect(chromiumCookieExpiry(13_350_000_000_000_000n)).toBe(13_350_000_000 - CHROME_EPOCH_OFFSET_S)
  })

  it('maps the samesite column', () => {
    expect(mapSameSite(-1)).toBe('unspecified')
    expect(mapSameSite(0)).toBe('no_restriction')
    expect(mapSameSite(1)).toBe('lax')
    expect(mapSameSite(2)).toBe('strict')
    expect(mapSameSite(99)).toBe('unspecified')
  })

  it('builds host-only and domain cookie details, skipping expired or host-less ones', () => {
    const now = 1_000
    const base: ImportedCookie = { host: 'youtube.com', name: 'a', value: 'v', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 2_000 }

    const hostOnly = cookieSetDetails(base, now)
    expect(hostOnly).not.toBeNull()
    expect(hostOnly?.url).toBe('https://youtube.com/')
    expect(hostOnly?.domain).toBeUndefined()
    expect(hostOnly?.expirationDate).toBe(2_000)

    const domain = cookieSetDetails({ ...base, host: '.youtube.com', secure: false, path: '/app' }, now)
    expect(domain?.domain).toBe('.youtube.com')
    expect(domain?.url).toBe('http://youtube.com/app')

    expect(cookieSetDetails({ ...base, expirationDate: null }, now)?.expirationDate).toBeUndefined()
    expect(cookieSetDetails({ ...base, expirationDate: 500 }, now)).toBeNull()
    expect(cookieSetDetails({ ...base, host: '.' }, now)).toBeNull()
  })
})

describe('cookie keychain and services (ST-46)', () => {
  it('names the Safe Storage keychain service per browser', () => {
    expect(safeStorageService('arc', 'Arc')).toBe('Arc Safe Storage')
    expect(safeStorageService('chrome', 'Google Chrome')).toBe('Chrome Safe Storage')
    expect(safeStorageService('elsewhere', 'Weird Browser')).toBe('Weird Browser Safe Storage')
  })

  it('reports a plain error when the Keychain read is denied, and trims on success', async () => {
    const deny = vi.fn(async () => {
      throw new Error('User canceled')
    })
    await expect(keychainPassword('Arc Safe Storage', deny)).rejects.toThrow()
    await expect(keychainPassword('Arc Safe Storage', async () => ({ stdout: '\n' }))).rejects.toThrow()
    expect(await keychainPassword('Arc Safe Storage', async () => ({ stdout: 'peanuts\n' }))).toBe('peanuts')
  })
})

describe('reading a fixture Cookies database (ST-46)', () => {
  it('decrypts rows, keeps host-only and domain hosts, and counts undecryptable ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-cookies-fixture-'))
    const file = join(dir, 'Cookies')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE meta(key TEXT, value TEXT)')
    db.exec("INSERT INTO meta VALUES('version','24')")
    db.exec('CREATE TABLE cookies(host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT, path TEXT, is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER)')
    const ins = db.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?)')
    ins.run('.youtube.com', 'SID', encryptV10('secret-token', 'youtube.com'), '', '/', 1, 1, 13_350_000_000_000_000n, 1)
    ins.run('mail.google.com', 'OSID', encryptV10('other', 'mail.google.com'), '', '/', 1, 0, 0n, 2)
    ins.run('bad.example', 'X', Buffer.from('v11nope'), '', '/', 0, 0, 0n, -1)
    db.close()

    const { cookies, decryptFailures } = readChromiumCookies(file, deriveCookieKey(PASSWORD))
    expect(decryptFailures).toBe(1)
    expect(cookies).toHaveLength(2)

    const sid = cookies.find((c) => c.name === 'SID')
    expect(sid?.value).toBe('secret-token')
    expect(sid?.host).toBe('.youtube.com')
    expect(sid?.secure).toBe(true)
    expect(sid?.httpOnly).toBe(true)
    expect(sid?.sameSite).toBe('lax')
    expect(sid?.expirationDate).toBe(13_350_000_000 - CHROME_EPOCH_OFFSET_S)

    const osid = cookies.find((c) => c.name === 'OSID')
    expect(osid?.host).toBe('mail.google.com')
    expect(osid?.expirationDate).toBeNull()
    expect(osid?.sameSite).toBe('strict')
  })
})

describe('writing cookies into a session (ST-46)', () => {
  it('sets each cookie, counts sites, skips expired ones and never logs a value', async () => {
    const sets: CookieSetDetails[] = []
    const writer = { set: vi.fn(async (d: CookieSetDetails) => void sets.push(d)) }
    const logger = { info: vi.fn(), warn: vi.fn() }
    const now = 1_000
    const secret = 'super-secret-token-value'
    const cookies: ImportedCookie[] = [
      { host: '.youtube.com', name: 'SID', value: secret, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 2_000 },
      { host: 'youtube.com', name: 'PREF', value: secret, path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: null },
      { host: 'mail.google.com', name: 'OSID', value: secret, path: '/', secure: true, httpOnly: true, sameSite: 'strict', expirationDate: 500 },
    ]

    const result = await writeCookies(writer, cookies, now, logger)
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.sites).toBe(1)
    expect(sets).toHaveLength(2)

    // No cookie value may appear in any log line (counts only).
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])
    expect(logged).not.toContain(secret)
  })
})
