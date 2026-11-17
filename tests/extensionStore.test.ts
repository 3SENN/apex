/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionStateStore, STATE_VERSION, migrateState } from '../src/main/extensions/store'

// The per-profile extensions store (enabled, pinned, granted optional
// permissions, native-host decisions) and its migration.

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)

describe('migrateState', () => {
  it('starts empty from nothing or junk', () => {
    for (const raw of [null, undefined, 42, 'x', [], {}]) expect(migrateState(raw)).toEqual({ version: STATE_VERSION, extensions: {}, native: {}, order: [] })
  })

  it('turns version 1 lists into one record per extension', () => {
    const out = migrateState({ version: 1, pinned: [B, A, 'not-an-id'], disabled: [C], grants: { [A]: ['bookmarks', 'bookmarks', 7], nope: ['x'] } })
    expect(out.version).toBe(STATE_VERSION)
    expect(Object.keys(out.extensions).sort()).toEqual([A, B, C])
    expect(out.extensions[A]).toMatchObject({ enabled: true, pinned: true, granted: ['bookmarks'], source: 'store' })
    expect(out.extensions[C]).toMatchObject({ enabled: false, pinned: false })
    // Pin order survives the move.
    expect(out.order).toEqual([B, A])
  })

  it('reads version 1 even without its version number', () => {
    expect(migrateState({ pinned: [A] }).extensions[A]?.pinned).toBe(true)
  })

  it('keeps good fields of a damaged version 2 record and drops bad ids', () => {
    const out = migrateState({
      version: 2,
      extensions: { [A]: { enabled: 'yes', pinned: true, granted: 'all', source: 'unpacked', path: '/dev/ext', installedAt: Number.NaN }, BAD: { enabled: true } },
      order: [A, B],
    })
    expect(out.extensions[A]).toEqual({ enabled: true, pinned: true, granted: [], source: 'unpacked', path: '/dev/ext', installedAt: 0 })
    expect(out.extensions).not.toHaveProperty('BAD')
    // B isn't installed, so it leaves the order.
    expect(out.order).toEqual([A])
  })

  it('appends pins the order forgot', () => {
    const out = migrateState({ version: 2, extensions: { [A]: { pinned: true }, [B]: { pinned: true } }, order: [B] })
    expect(out.order).toEqual([B, A])
  })

  it('keeps only remembered native answers that make sense', () => {
    const out = migrateState({ version: 2, extensions: {}, native: { [A]: { 'com.example.host': 'always', 'bad name!': 'always', 'com.other': 'once' }, [B]: { 'com.x': 'deny' }, short: { 'com.y': 'always' } } })
    expect(out.native).toEqual({ [A]: { 'com.example.host': 'always' }, [B]: { 'com.x': 'deny' } })
  })
})

describe('ExtensionStateStore', () => {
  let dir = ''
  let file = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apex-ext-store-'))
    file = join(dir, 'Extensions', 'apex-state.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('saves records, pins in order and native decisions, and reads them back', () => {
    const store = new ExtensionStateStore(file)
    store.upsert(A, { pinned: true })
    store.upsert(B, { pinned: true, granted: ['history', 'history'] })
    store.upsert(C, { enabled: false }, 'unpacked')
    store.setNativeDecision(A, 'com.example.host', 'always')
    expect(store.pinOrder()).toEqual([A, B])
    expect(store.get(B)?.granted).toEqual(['history'])
    expect(store.get(C)).toMatchObject({ enabled: false, source: 'unpacked' })

    const again = new ExtensionStateStore(file)
    expect(again.pinOrder()).toEqual([A, B])
    expect(again.nativeDecision(A, 'com.example.host')).toBe('always')
    expect(again.nativeDecision(A, 'com.other')).toBeNull()
    expect(again.snapshot().version).toBe(STATE_VERSION)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('unpins, and forgets everything about a removed extension', () => {
    const store = new ExtensionStateStore(file)
    store.upsert(A, { pinned: true })
    store.upsert(B, { pinned: true })
    store.setNativeDecision(A, 'com.example.host', 'deny')
    store.upsert(A, { pinned: false })
    expect(store.pinOrder()).toEqual([B])
    store.upsert(A, { pinned: true })
    expect(store.pinOrder()).toEqual([B, A])
    store.remove(A)
    expect(store.get(A)).toBeNull()
    expect(store.nativeDecision(A, 'com.example.host')).toBeNull()
    expect(store.ids()).toEqual([B])
  })

  it('migrates a version 1 file on load and writes version 2 on the next change', () => {
    const v1 = join(dir, 'v1.json')
    writeFileSync(v1, JSON.stringify({ version: 1, pinned: [A], disabled: [], grants: {} }))
    const store = new ExtensionStateStore(v1)
    expect(store.get(A)?.pinned).toBe(true)
    store.upsert(A, { enabled: false })
    expect(JSON.parse(readFileSync(v1, 'utf8'))).toMatchObject({ version: STATE_VERSION, extensions: { [A]: { enabled: false, pinned: true } } })
  })

  it('sets a damaged file aside and starts clean', () => {
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ not json')
    const store = new ExtensionStateStore(broken)
    expect(store.ids()).toEqual([])
    expect(existsSync(`${broken}.broken`)).toBe(true)
  })
})
