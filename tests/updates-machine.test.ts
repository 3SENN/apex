/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { initialUpdateStatus, type SupportFeed, type UpdateRestartRunning, type UpdateStatus, type WhatsNewEntry } from '../src/shared/updates'
import { FakeUpdaterBackend } from '../src/main/updates/backend'
import { RETRY_DELAYS_MS } from '../src/main/updates/backoff'
import { ManualClock } from '../src/main/updates/clock'
import { UNSUPPORTED_SNOOZE_MS, UpdateController, type ControllerDeps } from '../src/main/updates/controller'
import { classifyError, disabledReasonFor, reduce } from '../src/main/updates/machine'
import { INSTALL_WATCHDOG_MS } from '../src/main/updates/pending'
import { CHECK_INTERVAL_MS, CheckScheduler, RECHECK_AFTER_MS, STARTUP_DELAY_MS, shouldRecheck } from '../src/main/updates/schedule'
import { UpdatesStore } from '../src/main/updates/store'

// The update machine, controller and schedule on a fake clock with the fake backend: no network.

const MB = 1024 * 1024
const idle = (): UpdateStatus => ({ ...initialUpdateStatus('1.0.0'), phase: 'idle', disabledReason: null })

describe('the update machine', () => {
  it('goes idle → checking → downloading → ready → installing', () => {
    let s = idle()
    s = reduce(s, { type: 'checking' })
    expect(s.phase).toBe('checking')
    s = reduce(s, { type: 'available', version: '1.1.0', at: 5, awaitingConsent: false })
    expect(s).toMatchObject({ phase: 'downloading', version: '1.1.0', progress: 0, lastCheck: 'available', checkedAt: 5 })
    s = reduce(s, { type: 'progress', percent: 42.5, bytesPerSecond: 100 })
    expect(s.progress).toBeCloseTo(0.425)
    s = reduce(s, { type: 'downloaded', version: '1.1.0' })
    expect(s).toMatchObject({ phase: 'ready', progress: 1, bytesPerSecond: null })
    s = reduce(s, { type: 'installing' })
    expect(s.phase).toBe('installing')
    s = reduce(s, { type: 'install-cancelled' })
    expect(s.phase).toBe('ready')
  })

  it('waits for consent, and records up to date', () => {
    let s = reduce(idle(), { type: 'available', version: '1.1.0', at: 1, awaitingConsent: true })
    expect(s).toMatchObject({ phase: 'idle', awaitingConsent: true, version: '1.1.0', progress: null })
    s = reduce(s, { type: 'download-started', version: '1.1.0' })
    expect(s).toMatchObject({ phase: 'downloading', awaitingConsent: false })
    expect(reduce(idle(), { type: 'not-available', at: 9 })).toMatchObject({ phase: 'idle', lastCheck: 'up-to-date', checkedAt: 9, version: null })
  })

  it('ignores events that do not fit the phase', () => {
    const ready = reduce(reduce(idle(), { type: 'download-started', version: '2.0.0' }), { type: 'downloaded', version: '2.0.0' })
    expect(reduce(ready, { type: 'progress', percent: 10, bytesPerSecond: 1 })).toBe(ready)
    expect(reduce(ready, { type: 'checking' })).toBe(ready)
    expect(reduce(ready, { type: 'not-available', at: 1 })).toBe(ready)
    expect(reduce(idle(), { type: 'installing' }).phase).toBe('idle')
    const disabled = reduce(idle(), { type: 'disable', reason: 'unsigned' })
    expect(disabled).toMatchObject({ phase: 'disabled', disabledReason: 'unsigned' })
    expect(reduce(disabled, { type: 'checking' })).toBe(disabled)
    expect(reduce(disabled, { type: 'enable' })).toMatchObject({ phase: 'idle', disabledReason: null })
  })

  it('records failures with their kind, and a failed check as failed', () => {
    const s = reduce(reduce(idle(), { type: 'checking' }), { type: 'failed', kind: 'network', message: 'offline', attempt: 2, retryAt: 99, at: 7, during: 'check' })
    expect(s).toMatchObject({ phase: 'error', lastCheck: 'failed', checkedAt: 7, error: { kind: 'network', attempt: 2, retryAt: 99 } })
    const d = reduce(reduce(idle(), { type: 'download-started', version: '1.2.0' }), { type: 'failed', kind: 'disk-space', message: 'full', attempt: 1, retryAt: null, at: 8, during: 'download' })
    expect(d).toMatchObject({ phase: 'error', lastCheck: null, version: '1.2.0' })
    // A failed install can go back to installing on retry.
    expect(reduce({ ...d, error: { kind: 'install', message: '', attempt: 1, retryAt: null } }, { type: 'installing' }).phase).toBe('installing')
  })

  it('sorts errors into kinds', () => {
    expect(classifyError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('network')
    expect(classifyError(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }))).toBe('network')
    expect(classifyError(new Error('Code signature at URL did not pass validation'))).toBe('signature')
    expect(classifyError(new Error('sha512 checksum mismatch'))).toBe('signature')
    expect(classifyError('weird')).toBe('unknown')
  })

  it('disables unpackaged, Linux package-manager and unsigned builds', () => {
    const base = { packaged: true, updatesEnabled: true, platform: 'darwin' as const, appImage: false }
    expect(disabledReasonFor({ ...base, packaged: false })).toBe('unpackaged')
    expect(disabledReasonFor({ ...base, platform: 'linux' })).toBe('unsupported-package')
    expect(disabledReasonFor({ ...base, platform: 'linux', appImage: true })).toBeNull()
    expect(disabledReasonFor({ ...base, updatesEnabled: false })).toBe('unsigned')
    expect(disabledReasonFor(base)).toBeNull()
  })
})

describe('the check schedule', () => {
  it('checks 30 s after start-up, then every 4 h', () => {
    const clock = new ManualClock(0)
    const reasons: string[] = []
    const s = new CheckScheduler({ clock, check: (r) => reasons.push(r), lastCheckAt: () => null, lastFailed: () => false })
    s.start()
    clock.advance(STARTUP_DELAY_MS - 1)
    expect(reasons).toEqual([])
    clock.advance(1)
    expect(reasons).toEqual(['startup'])
    clock.advance(CHECK_INTERVAL_MS)
    expect(reasons).toEqual(['startup', 'interval'])
    s.stop()
    clock.advance(CHECK_INTERVAL_MS * 2)
    expect(reasons).toHaveLength(2)
  })

  it('debounces wake by an hour, and rechecks at once when back online after a failure', () => {
    const clock = new ManualClock(10 * RECHECK_AFTER_MS)
    let last: number | null = clock.now() - 10 * 60_000
    let failed = false
    const reasons: string[] = []
    const s = new CheckScheduler({ clock, check: (r) => reasons.push(r), lastCheckAt: () => last, lastFailed: () => failed })
    s.start()
    s.onWake()
    expect(reasons).toEqual([])
    s.onOnline()
    expect(reasons).toEqual([])
    failed = true
    s.onOnline()
    expect(reasons).toEqual(['online'])
    last = clock.now() - RECHECK_AFTER_MS
    s.onWake()
    expect(reasons).toEqual(['online', 'wake'])
    expect(shouldRecheck(null, 0)).toBe(true)
  })
})

interface Harness {
  ctl: UpdateController
  fake: FakeUpdaterBackend
  clock: ManualClock
  store: UpdatesStore
  dir: string
  statuses: UpdateStatus[]
  restarting: UpdateRestartRunning[]
  flushed: number
  deps: ControllerDeps
}

function harness(options: Partial<Omit<ControllerDeps, 'running'>> & { auto?: boolean; dir?: string; running?: UpdateRestartRunning } = {}): Harness {
  const { auto, dir: given, running, ...over } = options
  const dir = given ?? mkdtempSync(join(tmpdir(), 'apex-updates-'))
  const fake = new FakeUpdaterBackend()
  const clock = new ManualClock(Date.UTC(2026, 9, 29))
  const store = new UpdatesStore(dir)
  const h = { fake, clock, store, dir, statuses: [] as UpdateStatus[], restarting: [] as UpdateRestartRunning[], flushed: 0 } as Harness
  const deps: ControllerDeps = {
    clock,
    store,
    currentVersion: '1.0.0',
    disabledReason: null,
    backend: () => fake,
    autoDownload: () => auto ?? true,
    freeBytes: async () => 50_000 * MB,
    running: () => running ?? { chats: 0, routines: 0, meeting: false },
    flushSession: async () => {
      h.flushed++
    },
    askRestart: async () => null,
    askUnsupported: async () => null,
    supportFeed: async () => null,
    entries: [],
    onStatus: (s) => h.statuses.push(s),
    onRestarting: (r) => h.restarting.push(r),
    ...over,
  }
  h.deps = deps
  h.ctl = new UpdateController(deps)
  return h
}

/** Lets the fake backend's microtask steps run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('the update controller', () => {
  it('reports up to date on a manual check and remembers when it checked', async () => {
    const h = harness()
    h.ctl.start()
    const s = await h.ctl.check()
    expect(s).toMatchObject({ phase: 'idle', lastCheck: 'up-to-date', checkedAt: h.clock.now() })
    expect(h.store.get().lastCheckAt).toBe(h.clock.now())
    expect(h.statuses.some((x) => x.phase === 'checking')).toBe(true)
  })

  it('stays checking while the fake holds the check, and joins a second check to the first', async () => {
    const h = harness()
    h.ctl.start()
    h.fake.configure({ holdCheck: true })
    const first = h.ctl.check()
    const second = h.ctl.check()
    await settle()
    expect(h.ctl.status().phase).toBe('checking')
    expect(h.fake.holding).toBe(true)
    expect(h.fake.checks).toBe(1)
    h.fake.configure({ holdCheck: false })
    h.fake.release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toMatchObject({ phase: 'idle', lastCheck: 'up-to-date' })
    expect(b).toEqual(a)
  })

  it('downloads automatically and becomes ready', async () => {
    const h = harness()
    h.fake.configure({ available: { version: '1.1.0', size: 80 * MB } })
    h.ctl.start()
    const s = await h.ctl.check()
    expect(s.lastCheck).toBe('available')
    await settle()
    expect(h.ctl.status()).toMatchObject({ phase: 'ready', version: '1.1.0' })
    expect(h.statuses.map((x) => x.phase)).toContain('downloading')
    expect(h.statuses.some((x) => x.phase === 'downloading' && x.progress === 0.42)).toBe(true)
  })

  it('waits for consent when automatic downloads are off', async () => {
    const h = harness({ auto: false })
    h.fake.configure({ available: { version: '1.1.0', size: MB } })
    h.ctl.start()
    await h.ctl.check()
    await settle()
    expect(h.ctl.status()).toMatchObject({ phase: 'idle', awaitingConsent: true, version: '1.1.0' })
    expect(h.fake.downloads).toBe(0)
    h.ctl.download()
    await settle()
    expect(h.ctl.status().phase).toBe('ready')
  })

  it('starts a waiting download when automatic downloads are switched on', async () => {
    const h = harness({ auto: false })
    h.fake.configure({ available: { version: '1.1.0', size: MB } })
    h.ctl.start()
    await h.ctl.check()
    h.ctl.autoDownloadChanged(true)
    await settle()
    expect(h.ctl.status().phase).toBe('ready')
  })

  it('refuses to download without free space', async () => {
    const size = 1000 * MB
    const h = harness({ freeBytes: async () => size * 2 })
    h.fake.configure({ available: { version: '1.1.0', size } })
    h.ctl.start()
    await h.ctl.check()
    await settle()
    expect(h.ctl.status()).toMatchObject({ phase: 'error', error: { kind: 'disk-space', retryAt: null } })
    expect(h.ctl.status().error?.message).toContain('500 MB')
    expect(h.fake.downloads).toBe(0)
    expect(h.ctl.status().lastCheck).toBe('available')
  })

  it('retries network failures at 1, 2, 4, 8 and 16 minutes, then stops', async () => {
    const h = harness()
    h.fake.configure({ failChecks: 100 })
    h.ctl.start()
    await h.ctl.check()
    expect(h.ctl.status()).toMatchObject({ phase: 'error', error: { kind: 'network', attempt: 1, retryAt: h.clock.now() + RETRY_DELAYS_MS[0]! } })
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      h.clock.advance(delay)
      await settle()
      expect(h.fake.checks, `retry ${i + 1}`).toBe(i + 2)
    }
    // The sixth failure: no more retries until the next scheduled check.
    expect(h.ctl.status().error).toMatchObject({ kind: 'network', attempt: 6, retryAt: null })
    h.clock.advance(60 * 60_000)
    await settle()
    expect(h.fake.checks).toBe(6)
  })

  it('a manual check resets the backoff and succeeds once the network is back', async () => {
    const h = harness()
    h.fake.configure({ failChecks: 2 })
    h.ctl.start()
    await h.ctl.check()
    await h.ctl.check()
    expect(h.ctl.status().error?.attempt).toBe(1)
    const s = await h.ctl.check()
    expect(s).toMatchObject({ phase: 'idle', lastCheck: 'up-to-date', error: null })
  })

  it('installs: saves pending state, flushes the session, emits restarting, and the watchdog catches a stuck install', async () => {
    const quitting: boolean[] = []
    const h = harness({ quitting: (on) => quitting.push(on) })
    h.fake.configure({ available: { version: '1.1.0', size: MB } })
    h.ctl.start()
    await h.ctl.check()
    await settle()
    await h.ctl.install()
    expect(h.flushed).toBe(1)
    expect(h.restarting).toEqual([{ chats: 0, routines: 0, meeting: false }])
    expect(h.fake.installs).toBe(1)
    expect(h.ctl.status().phase).toBe('installing')
    expect(h.ctl.quittingForUpdate).toBe(true)
    expect(quitting).toEqual([true])
    expect(JSON.parse(readFileSync(join(h.dir, 'updates.json'), 'utf8')).pending).toMatchObject({ version: '1.1.0', attempts: 1 })
    h.clock.advance(INSTALL_WATCHDOG_MS)
    expect(h.ctl.status()).toMatchObject({ phase: 'error', error: { kind: 'install', attempt: 1 } })
    expect(h.ctl.quittingForUpdate).toBe(false)
    expect(quitting).toEqual([true, false])
    // Try again goes back to ready (the download is still here), then installs as attempt 2.
    expect((await h.ctl.check()).phase).toBe('ready')
    await h.ctl.install()
    expect(h.store.get().pending?.attempts).toBe(2)
  })

  it('asks before restarting over running work, and can wait for it to finish', async () => {
    let running: UpdateRestartRunning = { chats: 1, routines: 0, meeting: true }
    const askRestart = vi.fn(async () => 'when-idle' as const)
    const h = harness({ askRestart })
    h.deps.running = () => running
    h.fake.configure({ available: { version: '1.1.0', size: MB } })
    h.ctl.start()
    await h.ctl.check()
    await settle()
    await h.ctl.install()
    expect(askRestart).toHaveBeenCalledWith({ chats: 1, routines: 0, meeting: true }, '1.1.0')
    expect(h.fake.installs).toBe(0)
    expect(h.ctl.waitingForIdle).toBe(true)
    h.clock.advance(5_000)
    expect(h.fake.installs).toBe(0)
    running = { chats: 0, routines: 0, meeting: false }
    h.clock.advance(5_000)
    await settle()
    expect(h.fake.installs).toBe(1)
  })

  it('later() drops a "when they finish" wait, and a dismissed card does nothing', async () => {
    const askRestart = vi.fn(async () => null)
    const h = harness({ askRestart, running: { chats: 2, routines: 1, meeting: false } })
    h.fake.configure({ available: { version: '1.1.0', size: MB } })
    h.ctl.start()
    await h.ctl.check()
    await settle()
    await h.ctl.install()
    expect(h.ctl.status().phase).toBe('ready')
    await h.ctl.install({ whenIdle: true })
    expect(h.ctl.waitingForIdle).toBe(true)
    h.ctl.later()
    expect(h.ctl.waitingForIdle).toBe(false)
    await h.ctl.install({ whenIdle: false })
    expect(h.fake.installs).toBe(1)
  })

  it('reads the pending record on start: a new version clears it, the same version is a failed install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-updates-'))
    new UpdatesStore(dir).update({ pending: { version: '1.0.0', startedAt: 1, attempts: 1 }, lastSeenVersion: '0.9.0' })
    const ok = harness({ dir })
    ok.ctl.start()
    expect(ok.store.get().pending).toBeNull()
    expect(ok.ctl.status().phase).toBe('idle')

    new UpdatesStore(dir).update({ pending: { version: '1.1.0', startedAt: 1, attempts: 3 } })
    const failed = harness({ dir })
    failed.ctl.start()
    expect(failed.ctl.status()).toMatchObject({ phase: 'error', version: '1.1.0', error: { kind: 'install', attempt: 3 } })
    expect(failed.ctl.status().error?.message).toContain('3 tries')
  })

  it('stays disabled with its reason and never touches the backend', async () => {
    const backend = vi.fn(() => new FakeUpdaterBackend())
    const h = harness({ disabledReason: 'unpackaged', backend })
    h.ctl.start()
    expect(h.ctl.status()).toMatchObject({ phase: 'disabled', disabledReason: 'unpackaged' })
    expect((await h.ctl.check()).phase).toBe('disabled')
    expect(backend).not.toHaveBeenCalled()
  })

  it('runs the start-up check on the clock', async () => {
    const h = harness()
    h.ctl.start()
    h.clock.advance(STARTUP_DELAY_MS)
    await settle()
    expect(h.fake.checks).toBe(1)
  })
})

describe('unsupported versions', () => {
  const feed: SupportFeed = { schema: 1, unsupported: [{ below: '1.2.0', message: 'Please update.' }] }

  it('prompts once, and Remind me later snoozes for 3 days across a reload', async () => {
    const askUnsupported = vi.fn(async () => 'later' as const)
    const h = harness({ askUnsupported, supportFeed: async () => feed })
    h.ctl.start()
    await h.ctl.refreshSupport()
    expect(askUnsupported).toHaveBeenCalledWith('1.2.0', 'Please update.')
    const until = h.clock.now() + UNSUPPORTED_SNOOZE_MS
    expect(h.ctl.status().unsupported).toEqual({ below: '1.2.0', message: 'Please update.', snoozedUntil: until })
    expect(new UpdatesStore(h.dir).get().unsupportedSnoozeUntil).toBe(until)

    const again = harness({ dir: h.dir, askUnsupported, supportFeed: async () => feed })
    again.ctl.start()
    await again.ctl.refreshSupport()
    expect(askUnsupported).toHaveBeenCalledTimes(1)
    expect(again.ctl.status().unsupported?.snoozedUntil).toBe(until)
  })

  it('Update now downloads with consent, and a supported version clears the mark', async () => {
    const h = harness({ auto: false, askUnsupported: async () => 'update', supportFeed: async () => feed })
    h.fake.configure({ available: { version: '1.2.0', size: MB } })
    h.ctl.start()
    await h.ctl.refreshSupport()
    await settle()
    expect(h.ctl.status().phase).toBe('ready')
    await h.ctl.refreshSupport({ schema: 1, unsupported: [] })
    expect(h.ctl.status().unsupported).toBeNull()
  })
})

describe("what's new in the controller", () => {
  const entries: WhatsNewEntry[] = [
    { version: '1.0.0', date: '2026-10-01', title: 'One', highlights: [{ title: 'A', body: 'a' }] },
    { version: '0.9.0', date: '2026-09-01', title: 'Nine', highlights: [{ title: 'B', body: 'b' }] },
  ]

  it('never shows on a first install', () => {
    const h = harness({ entries })
    h.ctl.start()
    expect(h.ctl.whatsNew()).toBeNull()
    expect(h.store.get().lastSeenVersion).toBe('1.0.0')
  })

  it('shows once after an update, and dismissing records the version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-updates-'))
    new UpdatesStore(dir).update({ lastSeenVersion: '0.9.0' })
    const h = harness({ dir, entries })
    h.ctl.start()
    expect(h.ctl.whatsNew()?.entry.title).toBe('One')
    h.ctl.dismissWhatsNew()
    expect(h.ctl.whatsNew()).toBeNull()
    expect(h.store.get()).toMatchObject({ lastSeenVersion: '1.0.0', whatsNewShownFor: '1.0.0' })
    const next = harness({ dir, entries })
    next.ctl.start()
    expect(next.ctl.whatsNew()).toBeNull()
    expect(next.ctl.notes()?.version).toBe('1.0.0')
  })
})
