/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app } from 'electron'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardView, CsvPreview, ImportReport, PasswordsStatus } from '@shared/passwords'
import { smokePasswords } from '../passwords'
import { IMPORT_DIR } from '../passwords/importFiles'
import { assert, docWith } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// Passwords: CSV import end to end, the locked
// Passwords page then unlock (the fake authenticator says yes under smoke),
// reveal, the ?site= filter and delete after confirmation, and a card added
// and listed masked. Offline: the picker is fed a throwaway file, the
// clipboard and the Trash are left alone, and the vault uses the smoke
// cipher on the smoke run's own data folder.

// Made-up sign-ins for made-up sites; nothing here is anyone's real login.
const SMOKE_CSV = [
  'name,url,username,password,note',
  'example,https://example.com/login,smoke@example.invalid,smoke-secret-1,',
  'local,http://localhost:4321/,dev,smoke-secret-2,',
  'insecure,http://insecure.example.net/,x,smoke-secret-3,',
].join('\r\n')

function writeExport(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'apex-smoke-pw-')), 'Passwords.csv')
  writeFileSync(path, SMOKE_CSV)
  return path
}

const rows = 'return document.querySelectorAll(".sp-page .sp-item").length'

async function openPasswords(ctx: SmokeContext, url = 'apex://passwords'): Promise<void> {
  ctx.tabs.openInternal(url)
  await ctx.chrome.until(`return document.querySelector('.pw-lock, .sp-page .sp-item, .sp-page .ui-state')`, 8000, 'the Passwords page')
}

const csvImport: SmokeCheck = {
  name: 'passwords: CSV import end to end',
  async run(ctx) {
    const file = writeExport()
    smokePasswords.queuePick(file)
    const preview = await ctx.chrome.invoke<CsvPreview>('passwords', 'importPick')
    assert(preview.format === 'chrome', `the Chrome export was recognized (got ${preview.format})`)
    assert(preview.mapping.url === 1 && preview.mapping.username === 2 && preview.mapping.password === 3, 'the guessed mapping is url, username, password')
    assert(!JSON.stringify(preview).includes('smoke-secret'), 'the preview keeps passwords masked')
    assert(preview.importable === 2, `two rows are importable (got ${preview.importable})`)
    const report = await ctx.chrome.invoke<ImportReport>('passwords', 'importConfirm', preview.token, preview.mapping)
    assert(report.added === 2 && report.updated === 0 && report.same === 0 && report.skipped === 1 && report.total === 3, `the report counts rows (${JSON.stringify(report)})`)
    const temp = join(app.getPath('userData'), IMPORT_DIR)
    assert(!existsSync(temp) || readdirSync(temp).length === 0, 'the temp copy is gone')
    assert(ctx.settings.get().autofill.passwordsImported, 'autofill.passwordsImported is set')
    await ctx.chrome.invoke('passwords', 'trashFile', preview.token)
    assert(!existsSync(file), 'the export was moved away')
    // A second import of the same logins finds them already saved.
    const again = writeExport()
    smokePasswords.queuePick(again)
    const second = await ctx.chrome.invoke<CsvPreview>('passwords', 'pickSystemExport')
    const repeat = await ctx.chrome.invoke<ImportReport>('passwords', 'importConfirm', second.token, second.mapping)
    assert(repeat.same === 2 && repeat.added === 0, 'a repeat import reports the rows as already saved')
    await ctx.chrome.invoke('passwords', 'importCancel', second.token)
  },
}

const page: SmokeCheck = {
  name: 'passwords: locked page, unlock, reveal, ?site= and delete',
  async run(ctx) {
    await ctx.chrome.invoke('passwords', 'lock')
    await openPasswords(ctx)
    await ctx.chrome.until(`return document.querySelector('.pw-lock[data-state="locked"]')`, 5000, 'the locked tile')
    assert((await ctx.chrome.js<number>(rows)) === 0, 'no rows show while locked')
    assert((await ctx.chrome.invoke<unknown[]>('passwords', 'list')).length === 0, 'list() is empty while locked')
    await ctx.chrome.click(/^Unlock/, `document.querySelector('.pw-lock')`)
    await ctx.chrome.until(`${rows} >= 2`, 8000, 'the unlocked rows')
    const status = await ctx.chrome.invoke<PasswordsStatus>('passwords', 'status')
    assert(!status.locked && status.unlockedUntil !== null, 'the page is unlocked for a while')

    // Reveal the first row's password.
    await ctx.chrome.click(/^Show password$/, `document.querySelector('.sp-page .sp-item')`)
    const shown = await ctx.chrome.until<string>(`return document.querySelector('.pw-row__secret')?.textContent || ''`, 5000, 'the revealed password')
    assert(/^smoke-secret-[12]$/.test(shown), 'the revealed password is the saved one')

    // ?site= narrows the list to one site.
    await openPasswords(ctx, 'apex://passwords?site=localhost')
    await ctx.chrome.until(`return document.querySelectorAll('.sp-page .sp-item').length === 1 && document.querySelector('.pw-site-chip')`, 5000, 'the ?site= filter')
    assert((await ctx.chrome.js<string>(`return document.querySelector('.sp-page .sp-item .sp-item__title-text')?.textContent || ''`)) === 'localhost', 'the filtered row is localhost')

    // Delete asks first, then removes the row.
    await ctx.chrome.click(/^Delete$/, `document.querySelector('.sp-page .sp-item')`)
    // The confirmation opens in the overlay (OV-08), or in the page as a fallback.
    const confirmDoc = await docWith(ctx.chrome, '[role="alertdialog"]', 5000, 'the delete confirmation')
    await confirmDoc.click(/^Delete$/, `document.querySelector('[role="alertdialog"]')`)
    await ctx.chrome.until(`return document.querySelectorAll('.sp-page .sp-item').length === 0`, 5000, 'the deleted row to go')
    const after = await ctx.chrome.invoke<PasswordsStatus>('passwords', 'status')
    assert(after.count === 1, `one login is left (got ${after.count})`)
    await ctx.chrome.invoke('passwords', 'lock')
    await ctx.chrome.until(`return document.querySelector('.pw-lock')`, 5000, 'the page to lock again')
  },
}

const wallet: SmokeCheck = {
  name: 'passwords: a card is listed masked, and Settings › Passwords and autofill renders',
  async run(ctx) {
    const year = new Date().getFullYear() + 3
    const card = await ctx.chrome.invoke<CardView>('wallet', 'saveCard', { number: '4242 4242 4242 4242', holder: 'Smoke Test', expMonth: 12, expYear: year })
    assert(card.brand === 'visa' && card.last4 === '4242', 'the card view has brand and last four')
    assert(!JSON.stringify(await ctx.chrome.invoke('wallet', 'cards')).includes('4242424242424242'), 'the card list never carries the number')
    const refused = await ctx.chrome.invoke('wallet', 'saveCard', { number: '4242424242424242', holder: 'x', expMonth: 12, expYear: year, cvc: '123' }).then(
      () => false,
      () => true,
    )
    assert(refused, 'a card with a security code is refused')
    await ctx.chrome.invoke('wallet', 'saveAddress', {
      givenName: 'Smoke',
      additionalName: '',
      familyName: 'Test',
      organization: '',
      line1: '1 Example Street',
      line2: '',
      line3: '',
      city: 'Exampletown',
      region: '',
      postalCode: '1234 AB',
      country: 'NL',
      email: 'smoke@example.invalid',
      tel: '',
    })
    ctx.tabs.openInternal('apex://settings/passwords')
    await ctx.chrome.until(`return document.body.innerText.includes('ending in 4242') && document.body.innerText.includes('Smoke Test, 1 Example Street')`, 8000, 'the card and address in Settings')
    assert(!(await ctx.chrome.js<boolean>(`return document.body.innerText.includes('4242 4242 4242 4242')`)), 'Settings shows only the last four digits')
  },
}

export const checks: SmokeCheck[] = [csvImport, page, wallet]

export const shots: ShotSpec[] = [
  {
    name: 'passwords-locked',
    async run(ctx) {
      await ctx.chrome.invoke('passwords', 'lock')
      await openPasswords(ctx, 'apex://passwords')
      await ctx.chrome.until(`return document.querySelector('.pw-lock[data-state="locked"]')`, 5000, 'the locked tile')
      await ctx.shot('passwords-locked')
    },
  },
  {
    name: 'passwords-unlocked',
    async run(ctx) {
      await ctx.chrome.invoke('passwords', 'unlock')
      await openPasswords(ctx, 'apex://passwords')
      await ctx.chrome.until(`return document.querySelector('.sp-page .sp-item, .sp-page .ui-state')`, 5000, 'the unlocked list')
      await ctx.shot('passwords-unlocked')
      await ctx.chrome.invoke('passwords', 'lock')
    },
  },
  {
    name: 'passwords-settings',
    async run(ctx) {
      ctx.tabs.openInternal('apex://settings/passwords')
      await ctx.chrome.until(`return document.querySelector('[data-settings-anchor="passwords-manager"]')`, 8000, 'Settings › Passwords and autofill')
      await ctx.shot('passwords-settings')
    },
  },
  {
    name: 'passwords-import-mapping',
    async run(ctx) {
      smokePasswords.queuePick(writeExport())
      ctx.tabs.openInternal('apex://settings/passwords')
      await ctx.chrome.click(/^Import…$/, `document.querySelector('[data-settings-anchor="passwords-import"]')`)
      await ctx.chrome.click(/^Choose file…$/, `document.querySelector('[role="dialog"]')`)
      await ctx.chrome.until(`return document.querySelector('.pw-preview')`, 5000, 'the mapping step')
      await ctx.shot('passwords-import-mapping')
      await ctx.chrome.click(/^Cancel$/, `document.querySelector('[role="dialog"]')`)
    },
  },
]
