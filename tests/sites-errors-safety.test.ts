/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OnBeforeRequestListenerDetails } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyDownload, hostListed, hostOfUrl, parseHostList } from '@shared/safety'
import { blockedNavigations } from '../src/main/navErrors'
import { network, startNetworkWatch } from '../src/main/network'
import { safety, safetyLayer } from '../src/main/safety'

// The bundled dangerous-host list, the dangerous-site layer, the
// download risk classifier the download manager asks and the online state (SS-06).

describe('the dangerous-host list', () => {
  it('parses hosts, skipping comments, blanks and junk', () => {
    const list = parseHostList('# comment\n\nBad.Example  # trailing\n*.wild.example\n.dot.example\nnot a host\nlocalhost\ntrailing.example.\r\n')
    expect([...list].sort()).toEqual(['bad.example', 'dot.example', 'trailing.example', 'wild.example'])
  })

  it('covers subdomains, never siblings or lookalikes', () => {
    const list = parseHostList('bad.example')
    expect(hostListed(list, 'bad.example')).toBe(true)
    expect(hostListed(list, 'login.BAD.example.')).toBe(true)
    expect(hostListed(list, 'notbad.example')).toBe(false)
    expect(hostListed(list, 'bad.example.com')).toBe(false)
    expect(hostListed(list, '')).toBe(false)
  })

  it('reads hosts from addresses', () => {
    expect(hostOfUrl('https://A.Example:8443/x')).toBe('a.example')
    expect(hostOfUrl('http://[::1]:80/')).toBe('::1')
    expect(hostOfUrl('nonsense')).toBe('')
  })

  it('ships a list Atelier can read', () => {
    expect(safety.isDangerousHost('dangerous.atelier.test')).toBe(true)
    expect(safety.isDangerousHost('www.dangerous.atelier.test')).toBe(true)
    expect(safety.isDangerousHost('example.com')).toBe(false)
  })
})

describe('the dangerous-site layer', () => {
  const req = (url: string, resourceType = 'mainFrame', webContentsId = 5): OnBeforeRequestListenerDetails =>
    ({ id: 1, url, resourceType, webContentsId, method: 'GET', referrer: '', timestamp: 0 }) as unknown as OnBeforeRequestListenerDetails

  it('refuses listed pages and frames, and tells the tab why', () => {
    const session = {}
    const layer = safetyLayer(session)
    expect(layer.onBeforeRequest?.(req('https://dangerous.atelier.test/login'))).toEqual({ cancel: true })
    expect(blockedNavigations.take(5, 'https://dangerous.atelier.test/login')).toBe('dangerous')
    expect(layer.onBeforeRequest?.(req('https://dangerous.atelier.test/f', 'subFrame', 6))).toEqual({ cancel: true })
    // A frame doesn't replace the tab's page, so it leaves no reason behind.
    expect(blockedNavigations.take(6, 'https://dangerous.atelier.test/f')).toBeNull()
    expect(layer.onBeforeRequest?.(req('https://dangerous.atelier.test/a.png', 'image'))).toBeNull()
    expect(layer.onBeforeRequest?.(req('https://example.com/'))).toBeNull()
  })

  it('lets a host through for the rest of the session after Visit anyway', () => {
    const session = {}
    const other = {}
    expect(safety.blocks(session, 'https://dangerous.atelier.test/')).toBe(true)
    safety.allowHost(session, 'Dangerous.Atelier.Test')
    expect(safety.blocks(session, 'https://dangerous.atelier.test/')).toBe(false)
    expect(safety.isBypassed(session, 'dangerous.atelier.test')).toBe(true)
    expect(safetyLayer(session).onBeforeRequest?.(req('https://dangerous.atelier.test/'))).toBeNull()
    // Only that host, and only in that session.
    expect(safety.blocks(session, 'https://phishing.testing.google.test/')).toBe(true)
    expect(safety.blocks(other, 'https://dangerous.atelier.test/')).toBe(true)
  })
})

describe('classifyDownload', () => {
  const none = (): boolean => false
  const d = (filename: string, patch: Partial<{ url: string; mime: string; referrer: string }> = {}) => ({ url: 'https://files.example/x', mime: '', referrer: '', filename, ...patch })

  it('passes ordinary files', () => {
    for (const f of ['report.pdf', 'photo.JPG', 'notes.txt', 'archive.zip', 'song.mp3', 'README']) expect(classifyDownload(d(f), none), f).toBe('none')
  })

  it('asks about programs, installers and macro documents', () => {
    for (const f of ['setup.exe', 'Installer.DMG', 'tool.pkg', 'run.sh', 'app.apk', 'budget.xlsm', 'disk.iso', 'page.html']) expect(classifyDownload(d(f), none), f).toBe('uncommon')
    expect(classifyDownload(d('download', { mime: 'application/x-msdownload' }), none)).toBe('uncommon')
  })

  it('flags disguised names and programs over plain http', () => {
    expect(classifyDownload(d('invoice.pdf.exe'), none)).toBe('dangerous')
    expect(classifyDownload(d('invoice‮fdp.exe'), none)).toBe('dangerous')
    expect(classifyDownload(d('photo.jpg       .exe'), none)).toBe('dangerous')
    expect(classifyDownload(d('setup.exe', { url: 'http://files.example/setup.exe' }), none)).toBe('dangerous')
    // A local build server is not the open internet.
    expect(classifyDownload(d('setup.exe', { url: 'http://localhost:8080/setup.exe' }), none)).toBe('uncommon')
    expect(classifyDownload(d('notes.txt', { url: 'http://files.example/notes.txt' }), none)).toBe('none')
  })

  it('flags anything from a listed host or page', () => {
    const listed = (host: string): boolean => host === 'bad.example'
    expect(classifyDownload(d('report.pdf', { url: 'https://bad.example/r.pdf' }), listed)).toBe('dangerous')
    expect(classifyDownload(d('report.pdf', { referrer: 'https://bad.example/page' }), listed)).toBe('dangerous')
    expect(safety.classifyDownload(d('report.pdf', { url: 'https://dangerous.atelier.test/r.pdf' }))).toBe('dangerous')
    expect(safety.classifyDownload(d('report.pdf'))).toBe('none')
  })
})

describe('the online state', () => {
  afterEach(() => {
    vi.useRealTimers()
    network.set(true)
  })

  const state = (start = true) => {
    let online = start
    const changes: boolean[] = []
    return {
      target: {
        isOnline: () => online,
        set: (v: boolean) => {
          if (v !== online) changes.push(v)
          online = v
        },
      },
      changes,
    }
  }

  it('tells listeners about real changes only', () => {
    const heard: boolean[] = []
    const off = network.onChange((v) => heard.push(v))
    network.set(true)
    network.set(false)
    network.set(false)
    network.set(true)
    off()
    network.set(false)
    expect(heard).toEqual([false, true])
    expect(network.isOnline()).toBe(false)
  })

  it('believes going offline at once and coming back only once the probe agrees', async () => {
    const s = state()
    let system = false
    const probe = vi.fn(async () => false)
    const watch = startNetworkWatch({ isOnline: () => system, probe, target: s.target, intervalMs: 60_000 })
    expect(await watch.check()).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    system = true
    expect(await watch.check()).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
    probe.mockResolvedValue(true)
    expect(await watch.check()).toBe(true)
    expect(s.changes).toEqual([false, true])
    // Online again: the system's answer is enough.
    expect(await watch.check()).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
    watch.stop()
  })

  it('treats a failing probe as still offline and shares one check between callers', async () => {
    const s = state(false)
    const probe = vi.fn(async () => {
      throw new Error('no route')
    })
    const watch = startNetworkWatch({ isOnline: () => true, probe, target: s.target, intervalMs: 60_000 })
    const [a, b] = await Promise.all([watch.check(), watch.check()])
    expect([a, b]).toEqual([false, false])
    expect(probe).toHaveBeenCalledTimes(1)
    watch.stop()
  })

  it('polls, twice as often while offline', async () => {
    vi.useFakeTimers()
    const s = state()
    let system = true
    const isOnline = vi.fn(() => system)
    const watch = startNetworkWatch({ isOnline, target: s.target, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(isOnline).toHaveBeenCalledTimes(1)
    system = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.changes).toEqual([false])
    const before = isOnline.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(isOnline.mock.calls.length - before).toBe(2)
    watch.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(isOnline.mock.calls.length - before).toBe(2)
  })
})
