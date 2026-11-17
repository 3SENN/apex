/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPreview, guessFormat, guessMapping, loginUrl, mappingComplete, MASK, readPasswordCsv, rowsToLogins } from '../src/main/passwords/csvImport'
import { IMPORT_DIR, ImportFiles } from '../src/main/passwords/importFiles'
import { credentialOrigin, PasswordVault, type VaultCipher } from '../src/main/passwords/vault'

// Password CSV import (ST-41): the five export formats, the mapping
// guesser, the masked preview, the vault's decisions and the temp copies.

const cipher: VaultCipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text).toString('base64').split('').reverse().join('')),
  decrypt: (data) => Buffer.from(data.toString().split('').reverse().join(''), 'base64').toString(),
}
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'passwords', name), 'utf8')
const isSecure = (url: string): boolean => credentialOrigin(url) !== null
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-import-'))

describe('format and mapping guesses', () => {
  it.each([
    ['chrome.csv', 'chrome', { url: 1, username: 2, password: 3 }],
    ['firefox.csv', 'firefox', { url: 0, username: 1, password: 2 }],
    ['safari.csv', 'safari', { url: 1, username: 2, password: 3 }],
    ['1password.csv', '1password', { url: 1, username: 2, password: 3 }],
    ['bitwarden.csv', 'bitwarden', { url: 7, username: 8, password: 9 }],
  ])('%s is %s with the right columns', (file, format, mapping) => {
    const parsed = readPasswordCsv(fixture(file))
    expect(parsed.format).toBe(format)
    expect(guessMapping(parsed.columns)).toEqual(mapping)
  })

  it('guesses unknown headers by name and never reuses a column', () => {
    expect(guessFormat(['Website', 'E-mail Address', 'Secret Password'])).toBe('unknown')
    expect(guessMapping(['Website', 'E-mail Address', 'Secret Password'])).toEqual({ url: 0, username: 1, password: 2 })
    expect(guessMapping(['login_uri', 'login_username', 'login_password', 'login_totp'])).toEqual({ url: 0, username: 1, password: 2 })
    expect(guessMapping(['a', 'b'])).toEqual({ url: null, username: null, password: null })
  })

  it('needs distinct site and password columns; the username is optional', () => {
    expect(mappingComplete({ url: 0, username: null, password: 1 }, 2)).toBe(true)
    expect(mappingComplete({ url: 0, username: 0, password: 1 }, 2)).toBe(false)
    expect(mappingComplete({ url: 0, username: 1, password: null }, 2)).toBe(false)
    expect(mappingComplete({ url: 0, username: 1, password: 5 }, 2)).toBe(false)
  })
})

describe('rows', () => {
  it('takes the first of several URIs and assumes https without a scheme', () => {
    expect(loginUrl('https://a.example.com,https://b.example.com')).toBe('https://a.example.com')
    expect(loginUrl('wiki.example.com')).toBe('https://wiki.example.com')
    expect(loginUrl('  ')).toBe('')
    expect(loginUrl('androidapp://com.example')).toBe('androidapp://com.example')
  })

  it('keeps Bitwarden login rows only', () => {
    const parsed = readPasswordCsv(fixture('bitwarden.csv'))
    expect(parsed.rows).toHaveLength(3)
    expect(rowsToLogins(parsed.rows, guessMapping(parsed.columns)).map((l) => l.url)).toEqual([
      'https://example.com/login',
      'androidapp://com.example.app',
      'https://wiki.example.com',
    ])
  })

  it('reads quoted passwords and multi-line notes', () => {
    const parsed = readPasswordCsv(fixture('chrome.csv'))
    expect(parsed.rows).toHaveLength(4)
    expect(rowsToLogins(parsed.rows, guessMapping(parsed.columns))[1]?.password).toBe('pa,ss"2')
  })

  it('masks the password column in the preview and counts importable rows', () => {
    const parsed = readPasswordCsv(fixture('chrome.csv'))
    const preview = buildPreview('t', 'chrome.csv', parsed, guessMapping(parsed.columns), isSecure)
    expect(preview.rowCount).toBe(4)
    expect(preview.importable).toBe(2)
    expect(preview.sample.map((r) => r[3])).toEqual([MASK, MASK, MASK, ''])
    expect(JSON.stringify(preview)).not.toContain('fixture-pass')
    // Remapped so the password column is shown as a username: the masked column moves with it.
    const remapped = buildPreview('t', 'chrome.csv', parsed, { url: 1, username: 3, password: 2 }, isSecure)
    expect(remapped.sample[0]?.[2]).toBe(MASK)
  })
})

describe('the vault decides each row', () => {
  it.each([
    ['chrome.csv', { added: 2, updated: 0, same: 0, skipped: 2, total: 4 }],
    ['firefox.csv', { added: 2, updated: 0, same: 0, skipped: 0, total: 2 }],
    ['safari.csv', { added: 2, updated: 0, same: 0, skipped: 0, total: 2 }],
    ['1password.csv', { added: 2, updated: 0, same: 0, skipped: 0, total: 2 }],
    ['bitwarden.csv', { added: 2, updated: 0, same: 0, skipped: 1, total: 3 }],
  ])('%s reports %j', (file, report) => {
    const vault = new PasswordVault(tempDir(), cipher)
    const parsed = readPasswordCsv(fixture(file))
    expect(vault.importLogins(rowsToLogins(parsed.rows, guessMapping(parsed.columns)))).toEqual(report)
  })

  it('reports same and updated on a second import', () => {
    const vault = new PasswordVault(tempDir(), cipher)
    const firefox = readPasswordCsv(fixture('firefox.csv'))
    vault.importLogins(rowsToLogins(firefox.rows, guessMapping(firefox.columns)))
    const safari = readPasswordCsv(fixture('safari.csv'))
    const report = vault.importLogins(rowsToLogins(safari.rows, guessMapping(safari.columns)))
    // Safari's example.com row matches Firefox's (same origin, username and password); localhost is new.
    expect(report).toEqual({ added: 1, updated: 0, same: 1, skipped: 0, total: 2 })
    const changed = vault.importLogins([{ url: 'https://example.com/', username: 'sam@example.invalid', password: 'rotated' }])
    expect(changed).toEqual({ added: 0, updated: 1, same: 0, skipped: 0, total: 1 })
  })
})

describe('temp copies', () => {
  it('copies encrypted, reads back, and deletes after finish, cancel and dispose', () => {
    const dir = tempDir()
    const source = join(dir, 'export.csv')
    writeFileSync(source, fixture('chrome.csv'))
    const files = new ImportFiles(dir, cipher)
    const first = files.open(source)
    const copy = join(dir, IMPORT_DIR, `${first.token}.bin`)
    expect(existsSync(copy)).toBe(true)
    expect(readFileSync(copy, 'utf8')).not.toContain('fixture-pass')
    expect(files.read(first.token).text).toContain('fixture-pass-1')
    files.finish(first.token)
    expect(existsSync(copy)).toBe(false)
    expect(files.source(first.token)).toBe(source)
    expect(() => files.read(first.token)).toThrow(/ended/)

    const second = files.open(source)
    files.cancel(second.token)
    expect(files.source(second.token)).toBeNull()

    files.open(source)
    expect(files.pending()).toBe(1)
    files.dispose()
    expect(files.pending()).toBe(0)
    expect(existsSync(join(dir, IMPORT_DIR))).toBe(false)
    // The user's own file is never touched.
    expect(existsSync(source)).toBe(true)
  })

  it('clears leftovers from a crash at start-up', () => {
    const dir = tempDir()
    const source = join(dir, 'export.csv')
    writeFileSync(source, 'url,username,password\n')
    new ImportFiles(dir, cipher).open(source)
    expect(readdirSync(join(dir, IMPORT_DIR))).toHaveLength(1)
    new ImportFiles(dir, cipher).cleanup()
    expect(existsSync(join(dir, IMPORT_DIR))).toBe(false)
  })

  it('refuses binary and missing files', () => {
    const dir = tempDir()
    const binary = join(dir, 'x.csv')
    writeFileSync(binary, Buffer.from([0, 1, 2, 3]))
    const files = new ImportFiles(dir, cipher)
    expect(() => files.open(binary)).toThrow(/isn’t a CSV/)
    expect(() => files.open(join(dir, 'missing.csv'))).toThrow(/couldn’t open/)
  })
})
