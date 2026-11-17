/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { describe, expect, it, vi } from 'vitest'
import { initialUpdateStatus, type UpdateStatus } from '../src/shared/updates'
import { appMenuLabel, bindUpdateMenu, primaryAction, runPrimaryAction, runUpdateMenu, updateAppMenuItem, updateBanner, updateHelpItems, updateMenuItems } from '../src/main/updates/menu'
import { aboutView, clickAction, pillHint, pillKind, pillLabel } from '../src/renderer/src/updates/logic/labels'
import { parseLicenses } from '../src/renderer/src/updates/logic/licenses'

// The update menu labels per state (App menu, main-menu banner and Help row),
// and the footer pill's and About's wording.

const base = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...initialUpdateStatus('1.0.0'), phase: 'idle', disabledReason: null, ...patch })
const error = (kind: NonNullable<UpdateStatus['error']>['kind'], patch: Partial<UpdateStatus> = {}): UpdateStatus =>
  base({ phase: 'error', error: { kind, message: `${BRAND_NAME} couldn’t reach the update server.`, attempt: 1, retryAt: null }, ...patch })

describe('the App menu item', () => {
  it('reads per state, disabled while busy', () => {
    const cases: Array<[UpdateStatus, string, boolean]> = [
      [base(), 'Check for Updates…', true],
      [base({ phase: 'checking' }), 'Checking for Updates…', false],
      [base({ phase: 'downloading', progress: 0.427, version: '1.1.0' }), 'Downloading Update (42%)…', false],
      [base({ phase: 'ready', version: '1.1.0' }), 'Restart to Install Update…', true],
      [base({ phase: 'installing', version: '1.1.0' }), 'Restarting to Update…', false],
      [error('network'), 'Update Failed – Try Again…', true],
      [base({ awaitingConsent: true, version: '1.1.0' }), 'Download Update 1.1.0…', true],
    ]
    for (const [status, label, enabled] of cases) {
      expect(appMenuLabel(status)).toBe(label)
      expect(updateAppMenuItem(status)).toMatchObject({ id: 'update:app', label, commandId: 'check-for-updates', enabled })
    }
  })

  it('runs the action the state calls for', () => {
    const actions = { check: vi.fn(), download: vi.fn(), install: vi.fn() }
    expect(runPrimaryAction(base(), actions)).toBe('check')
    expect(runPrimaryAction(base({ phase: 'ready', version: '1' }), actions)).toBe('install')
    expect(runPrimaryAction(base({ awaitingConsent: true, version: '1' }), actions)).toBe('download')
    expect(runPrimaryAction(error('disk-space'), actions)).toBe('check')
    expect(runPrimaryAction(base({ phase: 'downloading' }), actions)).toBe('none')
    expect(primaryAction(base({ phase: 'disabled', disabledReason: 'unsigned' }))).toBe('none')
    expect(actions.check).toHaveBeenCalledTimes(2)
    expect(actions.install).toHaveBeenCalledTimes(1)
    expect(actions.download).toHaveBeenCalledTimes(1)
  })
})

describe('the main menu', () => {
  it('shows a banner while downloading, ready, failed, waiting or unsupported', () => {
    expect(updateBanner(base())).toBeNull()
    expect(updateBanner(base({ phase: 'downloading', progress: 0.5 }))).toMatchObject({ label: `Updating ${BRAND_NAME}… 50%`, enabled: false })
    expect(updateBanner(base({ phase: 'ready' }))).toMatchObject({ id: 'update:banner', label: `Restart to update ${BRAND_NAME}`, commandId: 'check-for-updates', icon: 'circle-arrow-up' })
    expect(updateBanner(error('network'))?.label).toBe('Update failed – try again')
    expect(updateBanner(base({ awaitingConsent: true, version: '2.0.0' }))?.label).toBe(`${BRAND_NAME} 2.0.0 is ready to download`)
    expect(updateBanner(base({ unsupported: { below: '2.0.0', message: null, snoozedUntil: null } }))?.label).toContain('no longer supported')
    expect(updateMenuItems(base({ phase: 'ready' })).map((i) => i.id)).toEqual(['update:banner', 'update:banner-separator'])
    expect(updateMenuItems(base())).toEqual([])
  })

  it('hides every update item in unpackaged and unsigned builds', () => {
    for (const reason of ['unpackaged', 'unsigned'] as const) {
      const s = base({ phase: 'disabled', disabledReason: reason })
      expect(updateBanner(s)).toBeNull()
      expect(updateHelpItems(s)).toEqual([])
    }
    expect(updateHelpItems(base())).toEqual([expect.objectContaining({ id: 'update:check', label: 'Check for Updates…', commandId: 'check-for-updates' })])
  })

  it("runs 'update:' ids through the bound actions", () => {
    const actions = { check: vi.fn(), download: vi.fn(), install: vi.fn() }
    expect(runUpdateMenu('update:banner')).toBe(false)
    bindUpdateMenu({ status: () => base({ phase: 'ready' }), actions })
    expect(runUpdateMenu('update:banner')).toBe(true)
    expect(runUpdateMenu('help:logs')).toBe(false)
    expect(actions.install).toHaveBeenCalledTimes(1)
    bindUpdateMenu(null)
  })
})

describe('the footer pill', () => {
  it('shows only while downloading, waiting, ready, restarting or failed', () => {
    expect(pillKind(null)).toBeNull()
    expect(pillKind(base())).toBeNull()
    expect(pillKind(base({ phase: 'checking' }))).toBeNull()
    expect(pillKind(base({ phase: 'disabled', disabledReason: 'unsupported-package' }))).toBeNull()
    expect(pillKind(base({ phase: 'downloading', progress: 0.42 }))).toBe('downloading')
    expect(pillKind(base({ phase: 'ready' }))).toBe('ready')
    expect(pillKind(error('install'))).toBe('failed')
    expect(pillKind(base({ awaitingConsent: true, version: '1.1.0' }))).toBe('available')
  })

  it('labels each state, with a hint and a click action', () => {
    const downloading = base({ phase: 'downloading', progress: 0.42, version: '1.1.0' })
    expect(pillLabel('downloading', downloading)).toBe('Updating 42%')
    expect(pillLabel('ready', base({ phase: 'ready' }))).toBe('Restart to update')
    expect(pillLabel('failed', error('network'))).toBe('Update failed')
    expect(pillHint('ready', base({ phase: 'ready', version: '1.1.0' }))).toContain(`${BRAND_NAME} 1.1.0 is ready`)
    expect(pillHint('failed', error('network'))).toContain('Click to try again')
    expect(clickAction(base({ phase: 'ready' }))).toBe('install')
    expect(clickAction(error('network'))).toBe('check')
    expect(clickAction(base({ awaitingConsent: true }))).toBe('download')
    expect(clickAction(downloading)).toBe('none')
  })
})

describe("About's update row", () => {
  const now = Date.UTC(2026, 9, 29, 12)

  it('says what is happening and offers the right buttons', () => {
    expect(aboutView(base(), now)).toEqual({ line: null, buttons: ['check'], progress: null })
    expect(aboutView(base({ phase: 'checking' }), now).line).toMatchObject({ text: 'Checking…', busy: true })
    expect(aboutView(base({ lastCheck: 'up-to-date', checkedAt: now - 5 * 60_000 }), now).line).toMatchObject({ text: `${BRAND_NAME} is up to date`, detail: 'Checked 5 min ago', tone: 'success' })
    expect(aboutView(error('network', { lastCheck: 'failed' }), now)).toMatchObject({ line: { text: "Couldn't check for updates", tone: 'error' }, buttons: ['tryAgain'] })
    expect(aboutView(base({ phase: 'downloading', version: '1.1.0', progress: 0.3 }), now)).toMatchObject({ line: { text: 'Downloading 1.1.0 (30%)' }, progress: 0.3 })
    expect(aboutView(base({ phase: 'ready', version: '1.1.0' }), now)).toMatchObject({ line: { text: 'Restart to finish updating' }, buttons: ['restart', 'later'] })
    expect(aboutView(base({ phase: 'ready', version: '1.1.0' }), now, true).buttons).toEqual(['restart'])
    expect(aboutView(base({ awaitingConsent: true, version: '1.1.0' }), now)).toMatchObject({ line: { text: `${BRAND_NAME} 1.1.0 is available` }, buttons: ['download'] })
    expect(aboutView(base({ phase: 'disabled', disabledReason: 'unsupported-package' }), now).line?.text).toContain('package manager')
  })

  it('shows when a network retry is due, and a disk-space failure in its own words', () => {
    const retrying = error('network', { lastCheck: 'failed', error: { kind: 'network', message: 'Offline.', attempt: 2, retryAt: now + 2 * 60_000 } })
    expect(aboutView(retrying, now).line?.detail).toBe('Offline. Trying again in 2 min.')
    const disk = base({ phase: 'error', lastCheck: 'available', error: { kind: 'disk-space', message: 'Not enough free disk space.', attempt: 1, retryAt: null } })
    expect(aboutView(disk, now).line).toMatchObject({ text: 'Not enough free disk space.', detail: null })
  })
})

describe('About helpers', () => {
  it('reads licenses.json entry by entry, sorted by name', () => {
    expect(parseLicenses([{ name: 'zod', version: '4.0.0', license: 'MIT', text: 'x' }, { name: 'a', license: '' }, { version: '1' }, 'junk'])).toEqual([
      { name: 'a', version: '', license: 'UNKNOWN', text: '' },
      { name: 'zod', version: '4.0.0', license: 'MIT', text: 'x' },
    ])
    expect(parseLicenses({})).toEqual([])
  })

})
