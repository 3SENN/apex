/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { expiryYears, formatExpiry, groupCardNumber, importOutcome, mappingOptions, originMatchesSite, remap, siteInput, siteOfOrigin, strengthBars } from '../src/shared/passwords'
import { UnlockWindow } from '../src/main/passwords/auth'
import { ImportFiles } from '../src/main/passwords/importFiles'
import { createPasswordsServices, type PasswordsPlatform } from '../src/main/passwords/service'
import { PasswordVault, VAULT_FILE, credentialOrigin, generatePassword, passwordStrength, queryCredentials, saveDecision, type VaultCipher } from '../src/main/passwords/vault'
import { WalletStore } from '../src/main/passwords/wallet'

// A reversible stand-in for the keychain cipher.
const cipher: VaultCipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text).toString('base64').split('').reverse().join('')),
  decrypt: (data) => Buffer.from(data.toString().split('').reverse().join(''), 'base64').toString(),
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-vault-'))
const vaultAt = (dir = tempDir()): PasswordVault => new PasswordVault(dir, cipher)

describe('credentialOrigin', () => {
  it('stores https origins and localhost only', () => {
    expect(credentialOrigin('https://accounts.example.com/login?next=/')).toBe('https://accounts.example.com')
    expect(credentialOrigin('http://localhost:3000/signin')).toBe('http://localhost:3000')
    expect(credentialOrigin('http://example.com/login')).toBeNull()
    expect(credentialOrigin('file:///tmp/login.html')).toBeNull()
    expect(credentialOrigin('not a url')).toBeNull()
  })
})

describe('PasswordVault', () => {
  it('saves, matches by exact origin and never lists passwords', () => {
    const vault = vaultAt()
    vault.save('https://mail.example.com/login', 'ada', 'pw-1', 1)
    vault.save('https://example.com/login', 'ada', 'pw-2', 2)
    expect(vault.forUrl('https://mail.example.com/inbox').map((c) => c.username)).toEqual(['ada'])
    expect(vault.forUrl('https://evil-mail.example.com/')).toEqual([])
    expect(vault.forUrl('https://mail.example.com.evil.test/')).toEqual([])
    expect(JSON.stringify(vault.list())).not.toContain('pw-')
    expect(vault.count()).toBe(2)
  })

  it('updates a changed password instead of duplicating', () => {
    const vault = vaultAt()
    const first = vault.save('https://example.com/a', 'ada', 'old', 1)
    expect(vault.decide('https://example.com/b', 'ada', 'old')).toEqual({ kind: 'same', id: first.id })
    expect(vault.decide('https://example.com/b', 'ada', 'new')).toEqual({ kind: 'update', id: first.id })
    vault.save('https://example.com/b', 'ada', 'new', 5)
    expect(vault.list()).toHaveLength(1)
    expect(vault.reveal(first.id)).toBe('new')
  })

  it('persists only encrypted data under the profile folder, mode 0600, and reloads it', () => {
    const dir = tempDir()
    new PasswordVault(dir, cipher).save('https://example.com', 'grace', 'hunter2-secret')
    const path = join(dir, VAULT_FILE)
    expect(readFileSync(path).toString()).not.toContain('hunter2-secret')
    // Windows has no POSIX permission bits to check.
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    const reopened = new PasswordVault(dir, cipher)
    expect(reopened.forUrl('https://example.com/')[0]?.username).toBe('grace')
  })

  it('reads an older vault (a bare credential array)', () => {
    const dir = tempDir()
    const path = join(dir, VAULT_FILE)
    new PasswordVault(dir, cipher).save('https://seed.example.com', 'seed', 'x')
    const old = [{ id: 'a', origin: 'https://old.example.com', username: 'ada', password: 'pw', createdAt: 1, updatedAt: 1 }]
    writeFileSync(path, cipher.encrypt(JSON.stringify(old)))
    const vault = new PasswordVault(dir, cipher)
    expect(vault.list()).toMatchObject([{ id: 'a', origin: 'https://old.example.com', lastUsedAt: null }])
    expect(vault.neverSaveList()).toEqual([])
  })

  it('refuses insecure origins and works without the keychain only when empty', () => {
    const vault = vaultAt()
    expect(() => vault.save('http://example.com', 'a', 'b')).toThrow(/https/)
    const locked = new PasswordVault(tempDir(), { ...cipher, available: () => false })
    expect(locked.list()).toEqual([])
    expect(locked.available()).toBe(false)
    expect(() => locked.save('https://example.com', 'a', 'b')).toThrow(/keychain/)
  })

  it('shows unavailable instead of crashing when the vault can’t be opened, and never overwrites it', () => {
    const dir = tempDir()
    vaultAt(dir).save('https://example.com', 'a', 'b')
    const before = readFileSync(join(dir, VAULT_FILE))
    const broken = new PasswordVault(dir, { ...cipher, decrypt: () => '{nope' })
    expect(broken.available()).toBe(false)
    expect(broken.count()).toBe(0)
    expect(broken.isNeverSave('https://example.com')).toBe(false)
    expect(() => broken.save('https://example.com', 'c', 'd')).toThrow(/can’t open/)
    expect(readFileSync(join(dir, VAULT_FILE))).toEqual(before)
  })

  it('leaves nothing changed when a write fails', () => {
    let ok = true
    const flaky: VaultCipher = { ...cipher, available: () => ok }
    const vault = new PasswordVault(tempDir(), flaky)
    const saved = vault.save('https://example.com', 'a', 'one')
    ok = false
    expect(() => vault.update(saved.id, { password: 'two' })).toThrow()
    ok = true
    expect(vault.reveal(saved.id)).toBe('one')
  })

  it('orders logins for a site by most recent use', () => {
    const vault = vaultAt()
    const a = vault.save('https://example.com', 'a', '1', 1)
    vault.save('https://example.com', 'b', '2', 2)
    vault.markUsed(a.id, 10)
    expect(vault.forUrl('https://example.com').map((c) => c.username)).toEqual(['a', 'b'])
  })

  it('searches by site or username and sorts by site or recent', () => {
    const vault = vaultAt()
    vault.save('https://www.zeta.example.com', 'zed', '1', 1)
    const b = vault.save('https://accounts.alpha.example.com', 'ann', '2', 2)
    vault.save('https://alpha.example.com', 'bob', '3', 3)
    expect(vault.query({ sort: 'site' }).map((c) => c.username)).toEqual(['ann', 'bob', 'zed'])
    vault.markUsed(b.id, 50)
    expect(vault.query({ sort: 'recent' }).map((c) => c.username)).toEqual(['ann', 'bob', 'zed'])
    expect(vault.query({ site: 'alpha.example.com' }).map((c) => c.username).sort()).toEqual(['ann', 'bob'])
    expect(vault.query({ site: 'www.zeta.example.com' }).map((c) => c.username)).toEqual(['zed'])
    expect(vault.query({ search: 'BO' }).map((c) => c.username)).toEqual(['bob'])
    expect(vault.query({ search: 'zeta' }).map((c) => c.username)).toEqual(['zed'])
    expect(queryCredentials([], { site: 'x' })).toEqual([])
  })

  it('keeps a never-save list, and allows a site again', () => {
    const vault = vaultAt()
    vault.neverSave('https://Bank.example.com/login')
    vault.neverSave('https://bank.example.com')
    expect(vault.neverSaveList()).toEqual(['https://bank.example.com'])
    expect(vault.isNeverSave('https://bank.example.com')).toBe(true)
    expect(vault.isNeverSave('https://other.example.com')).toBe(false)
    vault.allowAgain('https://bank.example.com')
    expect(vault.neverSaveList()).toEqual([])
  })

  it('refuses a username that another login on the site already has', () => {
    const vault = vaultAt()
    const a = vault.save('https://example.com', 'a', '1')
    vault.save('https://example.com', 'b', '2')
    expect(() => vault.update(a.id, { username: 'b' })).toThrow(/already uses/)
  })

  it('wipes everything, and tells listeners about every change', () => {
    const dir = tempDir()
    const vault = vaultAt(dir)
    const changes = vi.fn()
    vault.onChange(changes)
    const saved = vault.save('https://example.com', 'a', '1')
    vault.neverSave('https://x.example.com')
    vault.remove(saved.id)
    vault.wipe()
    expect(changes).toHaveBeenCalledTimes(4)
    expect(vault.count()).toBe(0)
    expect(vaultAt(dir).neverSaveList()).toEqual([])
  })
})

describe('saveDecision', () => {
  it('classifies submitted logins', () => {
    expect(saveDecision([], 'https://a.example', 'u', 'p')).toEqual({ kind: 'new' })
  })
})

describe('generatePassword', () => {
  it('includes every character class and no look-alikes', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword(20)
      expect(pw).toHaveLength(20)
      expect(pw).toMatch(/[a-z]/)
      expect(pw).toMatch(/[A-Z]/)
      expect(pw).toMatch(/\d/)
      expect(pw).toMatch(/[-_.!@#%*+=]/)
      expect(pw).not.toMatch(/[01lIO]/)
    }
    expect(() => generatePassword(8)).toThrow()
  })

  it('rates strength roughly', () => {
    expect(passwordStrength('password')).toBe('weak')
    expect(passwordStrength('Summer2026')).toBe('fair')
    expect(passwordStrength(generatePassword(20))).toBe('strong')
  })
})

describe('sites', () => {
  it('matches a ?site= host and its subdomains only', () => {
    expect(siteOfOrigin('https://www.example.com')).toBe('example.com')
    expect(originMatchesSite('https://accounts.example.com', 'example.com')).toBe(true)
    expect(originMatchesSite('https://example.com', 'www.example.com')).toBe(true)
    expect(originMatchesSite('https://notexample.com', 'example.com')).toBe(false)
    expect(originMatchesSite('https://example.com', '')).toBe(false)
  })
})

function setup(auth: 'ok' | 'cancelled' | 'unavailable' = 'ok') {
  const dir = tempDir()
  const vault = new PasswordVault(dir, cipher)
  const wallet = new WalletStore(dir, cipher)
  const files = new ImportFiles(dir, cipher)
  const unlock = new UnlockWindow(() => undefined)
  const copied: string[] = []
  const picks: string[] = []
  const trashed: string[] = []
  const platform: PasswordsPlatform = {
    pickCsv: async () => picks.shift() ?? null,
    openSystemPasswords: () => undefined,
    trash: async (path) => void trashed.push(path),
    copySecret: (text) => void copied.push(text),
  }
  const authenticate = vi.fn(async () => auth)
  const onImported = vi.fn()
  const services = createPasswordsServices({ vault, wallet, auth: { authenticate }, unlock, files, platform, onImported })
  return { dir, vault, files, unlock, services, copied, picks, trashed, authenticate, onImported }
}

describe('passwords services', () => {
  it('starts locked, lists nothing, and unlocks with auth', async () => {
    const s = setup()
    s.vault.save('https://example.com', 'ada', 'secret-1')
    expect(s.services.passwords.status()).toMatchObject({ count: 1, locked: true, unlockedUntil: null, available: true })
    expect(s.services.passwords.list()).toEqual([])
    expect(() => s.services.passwords.create({ url: 'https://a.example.com', username: 'x', password: 'y' })).toThrow(/Unlock/)
    expect(await s.services.passwords.unlock()).toBe(true)
    expect(s.services.passwords.status().locked).toBe(false)
    expect(s.services.passwords.list()).toHaveLength(1)
    s.services.passwords.lock()
    expect(s.services.passwords.list()).toEqual([])
    s.unlock.dispose()
  })

  it('asks before revealing or copying while locked, and refuses when you cancel', async () => {
    const s = setup()
    const saved = s.vault.save('https://example.com', 'ada', 'secret-1')
    expect(await s.services.passwords.reveal(saved.id)).toBe('secret-1')
    expect(s.authenticate).toHaveBeenCalledTimes(1)
    await s.services.passwords.copyPassword(saved.id)
    expect(s.copied).toEqual(['secret-1'])
    // Still unlocked: no second prompt.
    expect(s.authenticate).toHaveBeenCalledTimes(1)
    s.unlock.dispose()

    const cancelled = setup('cancelled')
    const other = cancelled.vault.save('https://example.com', 'ada', 'secret-2')
    await expect(cancelled.services.passwords.reveal(other.id)).rejects.toThrow(/hidden/)
    expect(await cancelled.services.passwords.unlock()).toBe(false)
    const unavailable = setup('unavailable')
    await expect(unavailable.services.passwords.unlock()).rejects.toThrow(/can’t confirm/)
  })

  it('creates, refuses a duplicate, updates and removes while unlocked', async () => {
    const s = setup()
    await s.services.passwords.unlock()
    const made = s.services.passwords.create({ url: 'https://example.com/login', username: 'ada', password: 'pw' })
    expect(made.origin).toBe('https://example.com')
    expect(() => s.services.passwords.create({ url: 'https://example.com', username: 'ada', password: 'other' })).toThrow(/already saved/)
    expect(() => s.services.passwords.create({ url: 'http://example.com', username: 'b', password: 'c' })).toThrow(/https/)
    expect(s.services.passwords.update(made.id, { username: 'ada2' }).username).toBe('ada2')
    s.services.passwords.remove(made.id)
    expect(s.services.passwords.status().count).toBe(0)
    expect(s.services.passwords.generate()).toHaveLength(20)
    expect(s.services.passwords.generate(32)).toHaveLength(32)
    expect(s.services.passwords.strength('abc')).toBe('weak')
    s.unlock.dispose()
  })

  it('imports a CSV end to end: masked preview, remap, report, temp copy gone, file to the Trash', async () => {
    const s = setup()
    const source = join(s.dir, 'Chrome Passwords.csv')
    writeFileSync(source, readFileSync(join(__dirname, 'fixtures', 'passwords', 'chrome.csv')))
    expect(await s.services.passwords.importPick()).toBeNull()
    s.picks.push(source)
    const preview = await s.services.passwords.importPick()
    expect(preview).toMatchObject({ fileName: 'Chrome Passwords.csv', format: 'chrome', rowCount: 4, importable: 2, mapping: { url: 1, username: 2, password: 3 } })
    expect(JSON.stringify(preview)).not.toContain('fixture-pass')
    const token = preview!.token
    const unmapped = s.services.passwords.importRemap(token, { url: null, username: 2, password: 3 })
    expect(unmapped.importable).toBe(0)
    expect(() => s.services.passwords.importConfirm(token, unmapped.mapping)).toThrow(/columns/)
    expect(() => s.services.passwords.importRemap(token, { url: 40, username: null, password: 3 })).toThrow(/columns/)
    const report = s.services.passwords.importConfirm(token, preview!.mapping)
    expect(report).toEqual({ added: 2, updated: 0, same: 0, skipped: 2, total: 4 })
    expect(s.onImported).toHaveBeenCalledTimes(1)
    expect(s.files.pending()).toBe(0)
    expect(() => s.services.passwords.importRemap(token, preview!.mapping)).toThrow(/ended/)
    await s.services.passwords.trashFile(token)
    expect(s.trashed).toEqual([source])
    await expect(s.services.passwords.trashFile(token)).rejects.toThrow(/ended/)
  })

  it('cancelling an import deletes the copy', async () => {
    const s = setup()
    const source = join(s.dir, 'export.csv')
    writeFileSync(source, 'url,username,password\nhttps://example.com,a,b\n')
    s.picks.push(source)
    const preview = await s.services.passwords.pickSystemExport()
    expect(s.files.pending()).toBe(1)
    s.services.passwords.importCancel(preview!.token)
    expect(s.files.pending()).toBe(0)
    expect(existsSync(source)).toBe(true)
    expect(s.onImported).not.toHaveBeenCalled()
  })

  it('serves the wallet and the never-save list without unlocking', () => {
    const s = setup()
    s.vault.neverSave('https://bank.example.com')
    expect(s.services.passwords.neverSaveList()).toEqual(['https://bank.example.com'])
    s.services.passwords.allowAgain('https://bank.example.com')
    expect(s.services.passwords.neverSaveList()).toEqual([])
    const card = s.services.wallet.saveCard({ number: '4242424242424242', holder: 'Sam', expMonth: 12, expYear: 2099 })
    expect(s.services.wallet.cards()).toEqual([card])
    expect(JSON.stringify(s.services.wallet.cards())).not.toContain('424242424242')
  })
})

describe('renderer logic', () => {
  it('formats cards and expiry', () => {
    expect(formatExpiry(3, 2027)).toBe('03/27')
    expect(groupCardNumber('4242424242424242')).toBe('4242 4242 4242 4242')
    expect(groupCardNumber('378282246310005')).toBe('3782 822463 10005')
    expect(groupCardNumber('4242 42')).toBe('4242 42')
    expect(expiryYears(new Date(2026, 0, 1))).toHaveLength(21)
    expect(expiryYears(new Date(2026, 0, 1), 2024)[0]).toBe(2024)
  })

  it('maps columns without sharing one between fields', () => {
    expect(remap({ url: 0, username: 1, password: 2 }, 'username', '0')).toEqual({ url: null, username: 0, password: 2 })
    expect(remap({ url: 0, username: 1, password: 2 }, 'username', '')).toEqual({ url: 0, username: null, password: 2 })
    expect(mappingOptions(['url', ''], 'None', (n) => `Column ${n}`)).toEqual([
      { value: '', label: 'None' },
      { value: '0', label: 'url' },
      { value: '1', label: 'Column 2' },
    ])
  })

  it('reports import outcomes and strength bars, and normalizes typed sites', () => {
    expect(importOutcome({ added: 0, updated: 0, same: 0, skipped: 3, total: 3 })).toBe('none')
    expect(importOutcome({ added: 1, updated: 0, same: 0, skipped: 3, total: 4 })).toBe('incomplete')
    expect(importOutcome({ added: 1, updated: 1, same: 1, skipped: 0, total: 3 })).toBe('ok')
    expect([strengthBars('weak'), strengthBars('fair'), strengthBars('strong')]).toEqual([1, 2, 3])
    expect(siteInput(' example.com ')).toBe('https://example.com')
    expect(siteInput('http://localhost:3000')).toBe('http://localhost:3000')
    expect(siteInput('')).toBe('')
  })
})

// Agent isolation: no agent tool, memory path, prompt or MCP
// server can reach the vault or wallet, and the stores never log.
describe('agent isolation', () => {
  const root = join(__dirname, '..', 'src', 'main')
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
  const agentFiles = [...walk(join(root, 'agent')), ...walk(join(root, 'mcp')), ...walk(join(root, 'engines')), join(root, 'memory.ts')].filter((f) => existsSync(f))

  it('keeps the agent, MCP server, engines and memory away from the vault and wallet', () => {
    expect(agentFiles.length).toBeGreaterThan(5)
    const reaches = /from ['"][./]*passwords|b\.vault|b\.wallet|cardForFill|addressForFill|PasswordVault|WalletStore/
    const offenders = agentFiles.filter((f) => reaches.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
    expect(offenders).toEqual([])
  })

  it('never logs from the vault, wallet or import code', () => {
    for (const name of ['vault.ts', 'wallet.ts', 'csvImport.ts', 'importFiles.ts', 'service.ts', 'auth.ts']) {
      const source = readFileSync(join(root, 'passwords', name), 'utf8')
      expect(source, name).not.toMatch(/\blog\.|console\./)
    }
  })
})
