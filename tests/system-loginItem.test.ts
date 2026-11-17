/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { UNSUPPORTED_LOGIN_ITEM } from '../src/shared/system'
import { FakeLoginItem, loginItemStateFrom } from '../src/main/system/loginItem'

// The login status mapping (OV-09) and smoke's fake.

describe('loginItemStateFrom', () => {
  it('maps macOS SMAppService statuses', () => {
    expect(loginItemStateFrom('darwin', { openAtLogin: true, status: 'enabled' })).toEqual({ supported: true, openAtLogin: true, status: 'enabled' })
    expect(loginItemStateFrom('darwin', { openAtLogin: false, status: 'requires-approval' })).toEqual({ supported: true, openAtLogin: true, status: 'requires-approval' })
    expect(loginItemStateFrom('darwin', { openAtLogin: false, status: 'not-found' })).toEqual({ supported: true, openAtLogin: false, status: 'not-found' })
    expect(loginItemStateFrom('darwin', { openAtLogin: false, status: 'not-registered' })).toEqual({ supported: true, openAtLogin: false, status: 'disabled' })
  })

  it('falls back to the flag before macOS 13', () => {
    expect(loginItemStateFrom('darwin', { openAtLogin: true }).status).toBe('enabled')
    expect(loginItemStateFrom('darwin', { openAtLogin: false }).status).toBe('disabled')
  })

  it('reads a Windows Run key switched off in Startup apps as needing approval', () => {
    expect(loginItemStateFrom('win32', { openAtLogin: false }).status).toBe('disabled')
    expect(loginItemStateFrom('win32', { openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [{ enabled: true }] }).status).toBe('enabled')
    expect(loginItemStateFrom('win32', { openAtLogin: true, executableWillLaunchAtLogin: false }).status).toBe('requires-approval')
    expect(loginItemStateFrom('win32', { openAtLogin: true, launchItems: [{ enabled: false }] }).status).toBe('requires-approval')
    expect(loginItemStateFrom('win32', { openAtLogin: true, launchItems: [] }).status).toBe('enabled')
  })

  it('maps the Linux autostart entry, and reports other systems unsupported', () => {
    expect(loginItemStateFrom('linux', { openAtLogin: true })).toEqual({ supported: true, openAtLogin: true, status: 'enabled' })
    expect(loginItemStateFrom('linux', { openAtLogin: false }).status).toBe('disabled')
    expect(loginItemStateFrom('freebsd', { openAtLogin: true })).toEqual(UNSUPPORTED_LOGIN_ITEM)
  })
})

describe('FakeLoginItem', () => {
  it('keeps state in memory, with a seeded answer for the next write', () => {
    const fake = new FakeLoginItem()
    expect(fake.read().status).toBe('disabled')
    expect(fake.write(true).status).toBe('enabled')
    fake.seed({ supported: true, openAtLogin: true, status: 'requires-approval' }, true)
    expect(fake.read().status).toBe('enabled')
    expect(fake.write(true).status).toBe('requires-approval')
    expect(fake.write(false).status).toBe('disabled')
    expect(fake.openedAtLogin()).toBe(false)
  })
})
