/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { BlockedOnPage, downloadBlocked, GESTURE_MS, GestureClock, isGestureInput, popupDecision, redirectBlocked } from '../src/main/popupBlocker'
import { consultPopupPolicies, registerPopupPolicy, type PopupRequest } from '../src/main/popupPolicy'
import type { Tab } from '../src/main/tabs'

// Pop-ups without a gesture, frame redirects and automatic downloads.

describe('the gesture clock', () => {
  it('counts an input as a gesture for a few seconds', () => {
    const g = new GestureClock()
    expect(g.had(1, 1000)).toBe(false)
    g.note(1, 1000)
    expect(g.had(1, 1000 + GESTURE_MS)).toBe(true)
    expect(g.had(1, 1001 + GESTURE_MS)).toBe(false)
    expect(g.had(2, 1000)).toBe(false)
  })

  it('spends a gesture on one pop-up', () => {
    const g = new GestureClock()
    g.note(1, 0)
    expect(g.consume(1, 10)).toBe(true)
    expect(g.consume(1, 20)).toBe(false)
    g.note(1, 30)
    g.forget(1)
    expect(g.had(1, 31)).toBe(false)
  })

  it('counts clicks, keys and taps, never moves or scrolls', () => {
    for (const t of ['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'gestureTap', 'touchStart', 'touchEnd']) expect(isGestureInput(t), t).toBe(true)
    for (const t of ['mouseMove', 'mouseWheel', 'mouseEnter', 'gestureScrollBegin', 'keyUp']) expect(isGestureInput(t), t).toBe(false)
  })
})

describe('popupDecision', () => {
  it('blocks script pop-ups without a gesture while blocking is on', () => {
    expect(popupDecision({ blockingOn: true, siteRule: 'default', userGesture: false })).toBe('block')
    expect(popupDecision({ blockingOn: true, siteRule: 'default', userGesture: true })).toBeNull()
    expect(popupDecision({ blockingOn: false, siteRule: 'default', userGesture: false })).toBeNull()
  })

  it('follows the site’s own rule either way', () => {
    expect(popupDecision({ blockingOn: true, siteRule: 'allow', userGesture: false })).toBe('allow')
    expect(popupDecision({ blockingOn: false, siteRule: 'block', userGesture: true })).toBe('block')
  })
})

describe('popup policies', () => {
  const req = (url: string): PopupRequest => ({ tab: { id: 't1' } as Tab, url, disposition: 'new-window', userGesture: false, frameOrigin: 'https://a.example' })

  it('takes the first policy with an opinion, and drops removed ones', () => {
    const offA = registerPopupPolicy(() => null)
    const offB = registerPopupPolicy((d) => (d.url.includes('ads') ? 'block' : null))
    const offC = registerPopupPolicy(() => 'allow')
    expect(consultPopupPolicies(req('https://ads.example/'))).toBe('block')
    expect(consultPopupPolicies(req('https://login.example/'))).toBe('allow')
    offC()
    expect(consultPopupPolicies(req('https://login.example/'))).toBeNull()
    offA()
    offB()
  })
})

describe('redirectBlocked', () => {
  const base = { pageUrl: 'https://news.example/story', frameUrl: 'https://ads.adnet.example/frame', targetUrl: 'https://scam.example/', frameIsTop: false, userGesture: false, siteRule: 'default' as const, blockingOn: true }

  it('blocks a cross-site frame sending the tab to yet another site unasked', () => {
    expect(redirectBlocked(base)).toBe(true)
  })

  it('lets the page itself, a gesture and the site’s allow through', () => {
    expect(redirectBlocked({ ...base, frameIsTop: true })).toBe(false)
    expect(redirectBlocked({ ...base, frameUrl: null })).toBe(false)
    expect(redirectBlocked({ ...base, userGesture: true })).toBe(false)
    expect(redirectBlocked({ ...base, siteRule: 'allow' })).toBe(false)
  })

  it('lets same-site frames and redirects back to the page’s site through', () => {
    expect(redirectBlocked({ ...base, frameUrl: 'https://video.news.example/embed' })).toBe(false)
    expect(redirectBlocked({ ...base, targetUrl: 'https://www.news.example/other' })).toBe(false)
  })

  it('only blocks with blocking off when the site is set to block', () => {
    expect(redirectBlocked({ ...base, blockingOn: false })).toBe(false)
    expect(redirectBlocked({ ...base, blockingOn: false, siteRule: 'block' })).toBe(true)
  })
})

describe('BlockedOnPage', () => {
  it('counts every block and keeps the latest three targets', () => {
    const b = new BlockedOnPage()
    for (const n of [1, 2, 3, 4]) b.add('t', `https://p${n}.example/`)
    b.add('t', 'https://p2.example/')
    expect(b.count('t')).toBe(5)
    expect(b.take('t')).toEqual(['https://p3.example/', 'https://p4.example/', 'https://p2.example/'])
    expect(b.count('t')).toBe(0)
    expect(b.take('t')).toEqual([])
  })

  it('keeps tabs apart and starts over on clear', () => {
    const b = new BlockedOnPage()
    b.add('a', 'https://x.example/')
    b.add('b', 'https://y.example/')
    b.clear('a')
    expect(b.count('a')).toBe(0)
    expect(b.count('b')).toBe(1)
  })
})

describe('downloadBlocked', () => {
  it('lets a blocked site have its first download, then wants a fresh gesture', () => {
    expect(downloadBlocked({ siteRule: 'block', downloadsThisPage: 0, userGesture: false })).toBe(false)
    expect(downloadBlocked({ siteRule: 'block', downloadsThisPage: 1, userGesture: false })).toBe(true)
    expect(downloadBlocked({ siteRule: 'block', downloadsThisPage: 3, userGesture: true })).toBe(false)
  })

  it('never blocks a site left at the default or allowed', () => {
    expect(downloadBlocked({ siteRule: 'default', downloadsThisPage: 9, userGesture: false })).toBe(false)
    expect(downloadBlocked({ siteRule: 'allow', downloadsThisPage: 9, userGesture: false })).toBe(false)
  })
})
