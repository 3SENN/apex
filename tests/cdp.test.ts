/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', getPreferredSystemLanguages: () => ['en-NL', 'nl-NL'] } }))
vi.mock('../src/main/log', () => ({ log: { debug: () => undefined, warn: () => undefined, error: () => undefined, info: () => undefined } }))

const { cdp } = await import('../src/main/cdp')
const { setForceDark } = await import('../src/main/forceDark')
const { TabLanguages, tabOverride, languagesFor, ownPageLanguages, systemOverride } = await import('../src/main/languages')
const { attachInput, detachInput } = await import('../src/main/input')
const { userAgentMetadata, browserUserAgent } = await import('../src/main/userAgent')

// The shared debugger attachment (cdp.ts): standing overrides (force dark, a
// custom website language list) step aside on sign-in pages, so those pages
// load with no DevTools client; the agent's own input still attaches while it
// acts; no holder ever turns on the Runtime or Page domains.

class FakeDebugger extends EventEmitter {
  attached = false
  attaches = 0
  sent: [string, unknown][] = []
  /** Commands sent to child targets' flat sessions: [sessionId, method, params]. */
  child: [string, string, unknown][] = []
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    if (this.attached) throw new Error('already attached')
    this.attached = true
    this.attaches++
  }
  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }
  sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    if (!this.attached) return Promise.reject(new Error('not attached'))
    if (sessionId) this.child.push([sessionId, method, params])
    else this.sent.push([method, params])
    return Promise.resolve({})
  }
}

class FakeTab extends EventEmitter {
  url = ''
  destroyed = false
  readonly debugger = new FakeDebugger()
  getURL(): string {
    return this.url
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  /** A main-frame navigation the way Electron reports it: started, then committed and stopped. */
  go(url: string, { commit = true } = {}): void {
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    if (commit) this.url = url
    this.emit('did-stop-loading')
  }
}

const tab = (url = 'https://example.com/'): FakeTab & WebContents => {
  const t = new FakeTab()
  t.url = url
  return t as FakeTab & WebContents
}
const methods = (t: FakeTab): string[] => t.debugger.sent.map(([m]) => m)
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('cdp standing holds', () => {
  it('attach and apply on an ordinary page, and detach before a sign-in page loads', async () => {
    const t = tab()
    const apply = vi.fn(() => cdp.send(t, 'Emulation.setAutoDarkModeOverride', { enabled: true }))
    const release = cdp.hold(t, { apply })
    expect(t.debugger.attached).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    // The detach happens at navigation start, before the sign-in page's first request.
    t.emit('did-start-navigation', { url: 'https://accounts.google.com/v3/signin/identifier', isMainFrame: true, isSameDocument: false })
    expect(t.debugger.attached).toBe(false)
    expect(cdp.onSignInPage(t)).toBe(true)
    t.url = 'https://accounts.google.com/v3/signin/identifier'
    t.emit('did-stop-loading')
    expect(t.debugger.attached).toBe(false)
    await tick()
    expect(t.debugger.attached).toBe(false)
    // Leaving attaches again and re-applies the override.
    t.go('https://mail.google.com/mail/u/0/')
    expect(t.debugger.attached).toBe(true)
    expect(apply).toHaveBeenCalledTimes(2)
    release()
    expect(t.debugger.attached).toBe(false)
    expect(cdp.holders(t)).toBe(0)
    expect(methods(t).some((m) => /^(Runtime|Page)\./.test(m))).toBe(false)
  })

  it('also step aside for a redirect into sign-in, and for a new tab headed there', () => {
    const t = tab('https://mail.google.com/')
    const release = cdp.hold(t, { apply: () => undefined })
    expect(t.debugger.attached).toBe(true)
    t.emit('did-redirect-navigation', { url: 'https://accounts.google.com/ServiceLogin', isMainFrame: true, isSameDocument: false })
    expect(t.debugger.attached).toBe(false)
    release()
    const fresh = tab('')
    const off = cdp.hold(fresh, { apply: () => undefined }, 'https://accounts.google.com/')
    expect(fresh.debugger.attached).toBe(false)
    off()
  })

  it('ignore subframe and same-document navigations, and a sign-in navigation that never committed', () => {
    const t = tab()
    const release = cdp.hold(t, { apply: () => undefined })
    t.emit('did-start-navigation', { url: 'https://accounts.google.com/frame', isMainFrame: false, isSameDocument: false })
    t.emit('did-start-navigation', { url: 'https://example.com/#x', isMainFrame: true, isSameDocument: true })
    expect(t.debugger.attached).toBe(true)
    t.go('https://accounts.google.com/', { commit: false })
    expect(t.debugger.attached).toBe(true)
    release()
  })

  it("step aside on a provider's sign-in route inside its app (x.com/i/flow/login), and come back after", () => {
    const t = tab('https://x.com/home')
    const release = cdp.hold(t, { apply: () => undefined })
    expect(t.debugger.attached).toBe(true)
    t.emit('did-start-navigation', { url: 'https://x.com/i/flow/login', isMainFrame: true, isSameDocument: true })
    expect(t.debugger.attached).toBe(false)
    t.emit('did-start-navigation', { url: 'https://x.com/home', isMainFrame: true, isSameDocument: true })
    expect(t.debugger.attached).toBe(true)
    release()
  })

  it("clear their override on a sign-in page while the agent's input keeps the debugger", async () => {
    const t = tab()
    const clear = vi.fn(() => cdp.send(t, 'Emulation.setAutoDarkModeOverride', {}))
    const release = cdp.hold(t, { apply: () => cdp.send(t, 'Emulation.setAutoDarkModeOverride', { enabled: true }), clear })
    await attachInput(t)
    expect(cdp.holders(t)).toBe(2)
    t.go('https://accounts.google.com/')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(t.debugger.attached).toBe(true)
    expect(cdp.holders(t)).toBe(1)
    // The agent stops: nothing is left attached on the sign-in page.
    detachInput(t)
    expect(t.debugger.attached).toBe(false)
    await tick()
    expect(t.debugger.attached).toBe(false)
    release()
    expect(methods(t)).toEqual(['Emulation.setAutoDarkModeOverride', 'Emulation.setFocusEmulationEnabled', 'Emulation.setAutoDarkModeOverride'])
  })

  it('re-apply after someone else detaches', async () => {
    const t = tab()
    const apply = vi.fn(() => undefined)
    const release = cdp.hold(t, { apply })
    t.debugger.detach()
    await tick()
    expect(t.debugger.attached).toBe(true)
    expect(apply).toHaveBeenCalledTimes(2)
    release()
    expect(t.debugger.attached).toBe(false)
  })
})

describe('force dark', () => {
  it('holds the debugger only while on, and steps aside on sign-in pages', async () => {
    const t = tab()
    await setForceDark(t, true)
    expect(t.debugger.attached).toBe(true)
    t.go('https://accounts.google.com/')
    expect(t.debugger.attached).toBe(false)
    t.go('https://example.com/')
    expect(t.debugger.attached).toBe(true)
    expect(methods(t)).toEqual(['Emulation.setAutoDarkModeOverride', 'Emulation.setAutoDarkModeOverride'])
    await setForceDark(t, false)
    expect(t.debugger.attached).toBe(false)
  })
})

describe('website languages', () => {
  it('override a tab only for a custom list, keeping the UA and its client hints', () => {
    const t = tab()
    const langs = new TabLanguages()
    const untrack = langs.track(t)
    expect(t.debugger.attached).toBe(false)
    langs.set(['nl', 'en-US'])
    expect(t.debugger.attached).toBe(true)
    expect(t.debugger.sent).toEqual([
      ['Emulation.setUserAgentOverride', { userAgent: browserUserAgent(), acceptLanguage: 'nl,en-US,en', userAgentMetadata: userAgentMetadata() }],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
    ])
    expect(tabOverride(['nl', 'en-US']).acceptLanguage).toBe('nl,en-US,en')
    t.go('https://accounts.google.com/')
    expect(t.debugger.attached).toBe(false)
    langs.set(null)
    t.go('https://example.com/')
    expect(t.debugger.attached).toBe(false)
    untrack()
  })

  it('give out-of-process iframes and workers the list as they start, and let every child target run on', async () => {
    const t = tab()
    const langs = new TabLanguages()
    const untrack = langs.track(t)
    langs.set(['nl'])
    const override = tabOverride(['nl'])
    const attached = (sessionId: string, type: string, waitingForDebugger = true): void => {
      t.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId, targetInfo: { type }, waitingForDebugger })
    }
    attached('w1', 'worker')
    attached('s1', 'service_worker')
    attached('f1', 'iframe')
    attached('o1', 'auction_worklet')
    attached('r1', 'worker', false)
    await tick()
    await tick()
    const by = (id: string): string[] => t.debugger.child.filter(([s]) => s === id).map(([, m]) => m)
    expect(by('w1')).toEqual(['Network.setUserAgentOverride', 'Runtime.runIfWaitingForDebugger'])
    expect(by('s1')).toEqual(['Network.setUserAgentOverride', 'Runtime.runIfWaitingForDebugger'])
    expect(by('f1')).toEqual(['Emulation.setUserAgentOverride', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'])
    expect(by('o1')).toEqual(['Runtime.runIfWaitingForDebugger'])
    // Already running when attached (a re-attach): the list, nothing to resume.
    expect(by('r1')).toEqual(['Network.setUserAgentOverride'])
    expect(t.debugger.child.find(([s, m]) => s === 'w1' && m === 'Network.setUserAgentOverride')?.[2]).toEqual(override)
    // Released: no more listening, and the debugger goes.
    langs.set(null)
    expect(t.debugger.listenerCount('message')).toBe(0)
    expect(t.debugger.attached).toBe(false)
    untrack()
  })

  it('following the system, hold the header’s list only where Chromium’s own navigator.languages says otherwise', () => {
    // Electron's own list: the app locale, then the system's languages as reported.
    expect(ownPageLanguages()).toEqual(['en-US', 'en-NL', 'nl-NL'])
    expect(systemOverride(['en-US', 'en-NL', 'nl-NL'])).toBeNull()
    // Linux: glib ends the list with the C locale, which the header (rightly) leaves out.
    expect(systemOverride(['en-US'], ['en-US', 'c', 'c'])).toEqual(['en-US'])
    expect(systemOverride(['en-US'], ['en-US'])).toBeNull()
    // The app language first (features/i18n.ts) while the launch locale leads Chromium's own list.
    expect(systemOverride(['nl-NL', 'en-US'], ['en-US', 'nl-NL'])).toEqual(['nl-NL', 'en-US'])
  })

  it('with the system languages, give the header what navigator.languages shows: the app locale first', () => {
    expect(languagesFor({ languages: { mode: 'system', list: [] } })).toEqual(['en-US', 'en-NL', 'nl-NL'])
    expect(languagesFor({ languages: { mode: 'custom', list: ['nl'] } })).toEqual(['nl'])
  })
})
