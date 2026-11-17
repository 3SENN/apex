/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_UPDATES_FILE } from '../src/shared/updates'
import { MAX_NETWORK_RETRIES, RETRY_DELAYS_MS, retryDelay } from '../src/main/updates/backoff'
import { DISK_MARGIN_BYTES, freeBytes, hasRoom, requiredFreeBytes, shortfall, updaterCacheDir } from '../src/main/updates/diskSpace'
import { MAX_INSTALL_ATTEMPTS, beginPending, canAttemptInstall, startupOutcome } from '../src/main/updates/pending'
import { UpdatesStore, normalizeUpdatesFile } from '../src/main/updates/store'
import { compareVersions, fetchSupportFeed, parseSupportFeed, parseVersion, supportFeedUrl, unsupportedFor } from '../src/main/updates/supportFeed'
import { updateSize } from '../src/main/updates/backend'

// The updater's small rules: the version comparator, the support feed, backoff, the
// free-space rule, the pending record and updates.json. No network.

const MB = 1024 * 1024

describe('version comparator', () => {
  it('orders x.y.z numerically, with prereleases first', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
  })

  it('treats text that is not a version as older than any version', () => {
    expect(parseVersion('1.2')).toBeNull()
    expect(compareVersions('garbage', '0.0.1')).toBe(-1)
    expect(compareVersions('0.0.1', 'garbage')).toBe(1)
  })
})

describe('the support feed', () => {
  it('parses a good feed and ignores unknown fields', () => {
    expect(parseSupportFeed(JSON.stringify({ schema: 1, unsupported: [{ below: '1.2.0', message: 'Hi', extra: 1 }], note: 'x' }))).toEqual({
      schema: 1,
      unsupported: [{ below: '1.2.0', message: 'Hi' }],
    })
  })

  it('ignores bad JSON, other schemas and malformed floors', () => {
    expect(parseSupportFeed('{nope')).toBeNull()
    expect(parseSupportFeed(JSON.stringify({ schema: 2, unsupported: [] }))).toBeNull()
    expect(parseSupportFeed(JSON.stringify({ schema: 1, unsupported: [{ below: 'soon' }] }))).toBeNull()
    expect(parseSupportFeed(JSON.stringify({ schema: 1 }))).toBeNull()
    expect(parseSupportFeed('null')).toBeNull()
  })

  it('finds the highest floor a version is under', () => {
    const feed = { schema: 1 as const, unsupported: [{ below: '1.1.0' }, { below: '1.3.0', message: '  ' }, { below: '0.9.0', message: 'old' }] }
    expect(unsupportedFor(feed, '1.0.0')).toEqual({ below: '1.3.0', message: null })
    expect(unsupportedFor(feed, '1.3.0')).toBeNull()
    expect(unsupportedFor(null, '1.0.0')).toBeNull()
  })

  it('fetches without credentials or a referrer, and gives up quietly', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ schema: 1, unsupported: [] }), { status: 200 }))
    const url = supportFeedUrl({ owner: 'me', name: 'atelier' })
    expect(url).toBe('https://github.com/me/atelier/releases/latest/download/atelier-support.json')
    expect(await fetchSupportFeed(url, ok as unknown as typeof fetch)).toEqual({ schema: 1, unsupported: [] })
    const init = (ok.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Accept'])
    expect(await fetchSupportFeed(url, (async () => new Response('', { status: 404 })) as typeof fetch)).toBeNull()
    expect(await fetchSupportFeed(url, (async () => new Response('x'.repeat(70_000))) as typeof fetch)).toBeNull()
    expect(await fetchSupportFeed(url, (async () => Promise.reject(new Error('offline'))) as typeof fetch)).toBeNull()
  })
})

describe('backoff', () => {
  it('waits 1, 2, 4, 8 and 16 minutes, then gives up', () => {
    expect(RETRY_DELAYS_MS).toEqual([1, 2, 4, 8, 16].map((m) => m * 60_000))
    expect(MAX_NETWORK_RETRIES).toBe(5)
    expect(retryDelay(1)).toBe(60_000)
    expect(retryDelay(5)).toBe(16 * 60_000)
    expect(retryDelay(6)).toBeNull()
    expect(retryDelay(0)).toBeNull()
  })
})

describe('free space', () => {
  it('needs max(2.5 × size, size + 500 MB)', () => {
    expect(requiredFreeBytes(100 * MB)).toBe(100 * MB + DISK_MARGIN_BYTES)
    expect(requiredFreeBytes(1000 * MB)).toBe(2500 * MB)
    expect(hasRoom(2500 * MB, 1000 * MB)).toBe(true)
    expect(hasRoom(2500 * MB - 1, 1000 * MB)).toBe(false)
    expect(hasRoom(null, 1000 * MB)).toBe(true)
    expect(shortfall(600 * MB, 1000 * MB)).toBe(1900 * MB)
  })

  it('reads the volume of the nearest existing folder', async () => {
    const free = await freeBytes(join(tmpdir(), 'atelier-missing', 'deeper'))
    expect(typeof free).toBe('number')
    expect(updaterCacheDir({ platform: 'darwin', home: '/Users/a' })).toBe(join('/Users/a/Library/Caches'))
    expect(updaterCacheDir({ platform: 'linux', home: '/home/a' })).toBe(join('/home/a/.cache'))
    expect(updaterCacheDir({ platform: 'win32', home: 'C:\\Users\\a', localAppData: 'C:\\L' })).toBe('C:\\L')
  })

  it('sizes an update by its largest file', () => {
    expect(updateSize({ files: [{ url: 'a.zip', sha512: '', size: 5 }, { url: 'a.dmg', sha512: '', size: 9 }] })).toBe(9)
    expect(updateSize({ files: [] })).toBe(0)
  })
})

describe('the pending record', () => {
  it('tells an installed update from a failed one', () => {
    expect(startupOutcome(null, '1.0.0')).toEqual({ kind: 'none' })
    expect(startupOutcome({ version: '1.1.0', startedAt: 1, attempts: 1 }, '1.1.0')).toEqual({ kind: 'installed', version: '1.1.0' })
    expect(startupOutcome({ version: '1.1.0', startedAt: 1, attempts: 2 }, '1.0.0')).toEqual({ kind: 'failed', version: '1.1.0', attempts: 2, canRetry: true })
    expect(startupOutcome({ version: '1.1.0', startedAt: 1, attempts: MAX_INSTALL_ATTEMPTS }, '1.0.0')).toMatchObject({ canRetry: false })
  })

  it('counts attempts per version, up to three', () => {
    const file = { ...EMPTY_UPDATES_FILE }
    const first = beginPending(file, '1.1.0', 10)
    expect(first).toEqual({ version: '1.1.0', startedAt: 10, attempts: 1 })
    expect(beginPending({ ...file, pending: first }, '1.1.0', 20).attempts).toBe(2)
    expect(beginPending({ ...file, pending: first }, '1.2.0', 20).attempts).toBe(1)
    expect(canAttemptInstall({ ...file, pending: { ...first, attempts: 3 } }, '1.1.0')).toBe(false)
    expect(canAttemptInstall({ ...file, pending: { ...first, attempts: 3 } }, '1.2.0')).toBe(true)
  })
})

describe('updates.json', () => {
  it('keeps good fields when others are damaged', () => {
    expect(normalizeUpdatesFile({ lastSeenVersion: '1.0.0', pending: { version: 3 }, lastCheckAt: -1, unsupportedSnoozeUntil: 5 })).toEqual({
      ...EMPTY_UPDATES_FILE,
      lastSeenVersion: '1.0.0',
      unsupportedSnoozeUntil: 5,
    })
    expect(normalizeUpdatesFile('nope')).toEqual(EMPTY_UPDATES_FILE)
  })

  it('persists a snooze across a reload, and reads a damaged file as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-updates-'))
    const store = new UpdatesStore(dir)
    store.update({ unsupportedSnoozeUntil: 12345 })
    expect(new UpdatesStore(dir).get().unsupportedSnoozeUntil).toBe(12345)
    writeFileSync(join(dir, 'updates.json'), '{broken')
    expect(store.reload()).toEqual(EMPTY_UPDATES_FILE)
  })
})
