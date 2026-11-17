/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { AUTO_RETRY_KINDS, classifyLoadFailure, isBypassable, isCertificateError, netErrorName } from '@shared/safety'
import type { PageErrorKind } from '@shared/sites'
import { blockedNavigations, NO_PAGE_ERROR, PageErrorTracker } from '../src/main/navErrors'
import { ACTION_LABEL, displayHostOf, errorCopy, noticeTarget, originOf, reconnectDelay, type ErrorView } from '../src/renderer/src/pages/errors/logic'
// The whole English catalogue: the privacy pack's HTTPS-First page keeps its copy in its own fragment.
import { EN as strings } from '../src/shared/i18n/en'

// Failed-load codes to Atelier's own error pages (SS-07), the per-tab page
// state and what each page says and offers.

const online = { online: true, blockedBy: null }

describe('classifyLoadFailure', () => {
  it.each<[number, PageErrorKind | null]>([
    [-3, null],
    [0, null],
    [-106, 'offline'],
    [-21, 'offline'],
    [-105, 'not-found'],
    [-137, 'not-found'],
    [-102, 'refused'],
    [-101, 'refused'],
    [-100, 'refused'],
    [-109, 'refused'],
    [-7, 'timed-out'],
    [-118, 'timed-out'],
    [-310, 'too-many-redirects'],
    [-200, 'certificate'],
    [-202, 'certificate'],
    [-501, 'certificate'],
    [-324, 'other'],
    [-2, 'other'],
  ])('maps %i to %s while online', (code, kind) => {
    expect(classifyLoadFailure(code, online)).toBe(kind)
  })

  it('treats name and connection failures as offline while the system is offline', () => {
    for (const code of [-105, -102, -118]) expect(classifyLoadFailure(code, { online: false })).toBe('offline')
    // A certificate or redirect problem is not a connection problem.
    expect(classifyLoadFailure(-202, { online: false })).toBe('certificate')
    expect(classifyLoadFailure(-310, { online: false })).toBe('too-many-redirects')
  })

  it('names why Atelier itself refused the page', () => {
    expect(classifyLoadFailure(-20, { online: true, blockedBy: 'dangerous' })).toBe('dangerous-site')
    expect(classifyLoadFailure(-20, { online: true, blockedBy: 'adblock' })).toBe('blocked-by-adblock')
    expect(classifyLoadFailure(-27, { online: true, blockedBy: 'adblock' })).toBe('blocked-by-adblock')
    expect(classifyLoadFailure(-20, { online: true, blockedBy: 'lockdown' })).toBe('other')
    expect(classifyLoadFailure(-20, online)).toBe('other')
  })

  it('names codes for the small print and spots certificate errors', () => {
    expect(netErrorName(-105)).toBe('ERR_NAME_NOT_RESOLVED')
    expect(netErrorName(-9999)).toBe('ERR_9999')
    expect(isCertificateError(-200)).toBe(true)
    expect(isCertificateError(-299)).toBe(true)
    expect(isCertificateError(-300)).toBe(false)
    expect(isCertificateError(-105)).toBe(false)
  })

  it('retries only the offline page and offers a way past only the interstitials', () => {
    expect([...AUTO_RETRY_KINDS]).toEqual(['offline'])
    expect(isBypassable('certificate')).toBe(true)
    expect(isBypassable('dangerous-site')).toBe(true)
    expect(isBypassable('blocked-by-adblock')).toBe(true)
    expect(isBypassable('not-found')).toBe(false)
  })
})

describe('blockedNavigations', () => {
  it('hands the reason to the matching failure once', () => {
    blockedNavigations.note(7, 'https://bad.example/', 'dangerous')
    expect(blockedNavigations.take(7, 'https://bad.example/')).toBe('dangerous')
    expect(blockedNavigations.take(7, 'https://bad.example/')).toBeNull()
  })

  it('ignores a reason noted for another address', () => {
    blockedNavigations.note(8, 'https://ads.example/', 'adblock')
    expect(blockedNavigations.take(8, 'https://other.example/')).toBeNull()
    blockedNavigations.note(9, 'https://ads.example/', 'adblock')
    blockedNavigations.forget(9)
    expect(blockedNavigations.take(9, 'https://ads.example/')).toBeNull()
  })
})

describe('PageErrorTracker', () => {
  it('starts clean and keeps the failed address', () => {
    const t = new PageErrorTracker()
    expect(t.state()).toEqual(NO_PAGE_ERROR)
    expect(t.failed(-105, 'https://nope.example/', true, online)).toBe(true)
    expect(t.state().error).toEqual({ kind: 'not-found', code: -105, url: 'https://nope.example/' })
    expect(t.covering).toBe(true)
  })

  it('ignores frame failures and aborted loads', () => {
    const t = new PageErrorTracker()
    expect(t.failed(-105, 'https://frame.example/', false, online)).toBe(false)
    expect(t.failed(-3, 'https://stop.example/', true, online)).toBe(false)
    expect(t.state().error).toBeNull()
  })

  it('reports only real changes', () => {
    const t = new PageErrorTracker()
    t.failed(-102, 'https://a.example/', true, online)
    expect(t.failed(-102, 'https://a.example/', true, online)).toBe(false)
    expect(t.failed(-102, 'https://b.example/', true, online)).toBe(true)
  })

  it('shows retrying while a covered page reloads, and clears on commit', () => {
    const t = new PageErrorTracker()
    expect(t.startedLoading()).toBe(false)
    t.failed(-106, 'https://a.example/', true, { online: false, blockedBy: null })
    expect(t.startedLoading()).toBe(true)
    expect(t.state().retrying).toBe(true)
    expect(t.stoppedLoading()).toBe(true)
    t.startedLoading()
    expect(t.navigated()).toBe(true)
    expect(t.state()).toEqual(NO_PAGE_ERROR)
    expect(t.covering).toBe(false)
  })

  it('tracks crashes and hangs, never treating a clean exit as a crash', () => {
    const t = new PageErrorTracker()
    expect(t.crashed('clean-exit')).toBe(false)
    expect(t.unresponsive()).toBe(true)
    expect(t.responsive()).toBe(true)
    expect(t.crashed('crashed')).toBe(true)
    expect(t.state()).toMatchObject({ crashed: true, unresponsive: false })
    expect(t.covering).toBe(true)
    // A crashed page can't also hang.
    expect(t.unresponsive()).toBe(false)
    expect(t.clear()).toBe(true)
    expect(t.state()).toEqual(NO_PAGE_ERROR)
  })

  it('hands out copies, so callers cannot change its state', () => {
    const t = new PageErrorTracker()
    t.failed(-105, 'https://a.example/', true, online)
    const s = t.state()
    if (s.error) s.error.url = 'changed'
    expect(t.state().error?.url).toBe('https://a.example/')
  })
})

describe('error page copy', () => {
  const views: ErrorView[] = ['offline', 'not-found', 'refused', 'timed-out', 'too-many-redirects', 'blocked-by-adblock', 'dangerous-site', 'certificate', 'https-unavailable', 'crashed', 'other']

  it('has English for every title, body and action', () => {
    for (const v of views) {
      const c = errorCopy(v, true)
      expect(strings[c.title as keyof typeof strings], c.title).toBeTruthy()
      expect(strings[c.body as keyof typeof strings], c.body).toBeTruthy()
    }
    for (const key of Object.values(ACTION_LABEL)) expect(strings[key as keyof typeof strings], key).toBeTruthy()
  })

  it('offers Back only when there is somewhere to go back to', () => {
    expect(errorCopy('refused', true).secondary).toContain('back')
    expect(errorCopy('refused', false).secondary).not.toContain('back')
  })

  it('puts Back to safety first on the interstitials, with the way past tucked away', () => {
    expect(errorCopy('certificate', true)).toMatchObject({ tone: 'danger', primary: 'back-to-safety', bypass: 'proceed', secondary: [] })
    expect(errorCopy('dangerous-site', true)).toMatchObject({ tone: 'danger', primary: 'back-to-safety', bypass: 'visit' })
    expect(errorCopy('blocked-by-adblock', false)).toMatchObject({ tone: 'warning', primary: 'allow-adblock', bypass: null })
  })

  it('offers the right fix for the rest', () => {
    expect(errorCopy('not-found', false)).toMatchObject({ primary: 'retry', secondary: ['search'] })
    expect(errorCopy('too-many-redirects', false)).toMatchObject({ primary: 'clear-cookies', secondary: ['retry'] })
    expect(errorCopy('crashed', false).primary).toBe('reload')
  })

  it('names hosts and targets briefly', () => {
    expect(displayHostOf('https://www.example.com/a')).toBe('example.com')
    expect(displayHostOf('not a url')).toBe('not a url')
    expect(originOf('https://example.com/a?b')).toBe('https://example.com')
    expect(originOf('file:///tmp/x')).toBeNull()
    expect(noticeTarget('https://www.pop.example/')).toBe('pop.example')
    expect(noticeTarget('https://pop.example/a/very/long/path/that/keeps/going/and/going/on', 20)).toHaveLength(20)
    expect(noticeTarget('javascript:alert(1)')).toBe('javascript')
  })

  it('counts down to the next check quickly at first, then every 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 10].map(reconnectDelay)).toEqual([5, 10, 20, 30, 30, 30])
    expect(reconnectDelay(-1)).toBe(5)
  })
})
