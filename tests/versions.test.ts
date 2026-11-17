/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileRef } from '@shared/workspace'
import { openDb } from '../src/main/db'
import { VersionStore, type VersionTarget } from '../src/main/workspace/versions'

const DAY = 86_400_000
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(live: Map<string, Buffer> = new Map()) {
  const dir = mkdtempSync(join(tmpdir(), 'apex-versions-'))
  dirs.push(dir)
  let now = 1_000_000
  const target: VersionTarget = {
    read: (ref) => live.get(JSON.stringify(ref)) ?? null,
    write: (ref, data) => void live.set(JSON.stringify(ref), data),
  }
  const changes: FileRef[] = []
  const store = new VersionStore({ db: openDb(':memory:'), dir: join(dir, 'versions'), target: (kind) => (kind === 'folder' ? target : undefined), now: () => now, onChange: (r) => changes.push(r) })
  return { store, live, changes, tick: (ms = 1000) => (now += ms), setNow: (t: number) => (now = t), get now() { return now } }
}

const ref: FileRef = { kind: 'folder', folderId: 'f1', path: 'notes/a.md' }
const key = JSON.stringify(ref)

describe('version history', () => {
  it('keeps the text a write replaces, then the new text, and marks the current one', () => {
    const s = setup(new Map([[key, Buffer.from('first')]]))
    s.store.snapshot(ref, 'second', 'saved')
    s.live.set(key, Buffer.from('second'))
    const list = s.store.list(ref)
    expect(list.map((v) => s.store.read(ref, v.id))).toEqual(['second', 'first'])
    expect(list.map((v) => v.label)).toEqual(['saved', 'saved'])
    expect(list.map((v) => v.current)).toEqual([true, false])
    expect(s.changes).toHaveLength(1)
  })

  it('does not add a version for an unchanged save', () => {
    const s = setup()
    s.store.snapshot(ref, 'same', 'saved')
    s.tick()
    s.store.snapshot(ref, 'same', 'saved')
    expect(s.store.list(ref)).toHaveLength(1)
  })

  it('labels deletes, moves and restores', () => {
    const s = setup()
    s.store.snapshot(ref, 'one', 'saved')
    s.tick()
    s.store.snapshot(ref, 'one', 'moved')
    s.tick()
    s.store.snapshot(ref, 'one', 'deleted')
    expect(s.store.list(ref).map((v) => v.label)).toEqual(['deleted', 'moved', 'saved'])
  })

  it('restores an earlier version in place and records it as restored', () => {
    const s = setup(new Map([[key, Buffer.from('v1')]]))
    s.store.snapshot(ref, 'v1', 'saved')
    s.tick()
    s.store.snapshot(ref, 'v2', 'saved')
    s.live.set(key, Buffer.from('v2'))
    const first = s.store.list(ref).find((v) => s.store.read(ref, v.id) === 'v1')
    s.tick()
    const restored = s.store.restore(ref, first!.id)
    expect(restored.label).toBe('restored')
    expect(restored.current).toBe(true)
    expect(s.live.get(key)?.toString()).toBe('v1')
    expect(s.store.list(ref).map((v) => v.label)).toEqual(['restored', 'saved', 'saved'])
  })

  it('refuses to restore kinds without a writer, and unknown versions', () => {
    const s = setup()
    const memory: FileRef = { kind: 'memory', owner: 'shared', path: '/memories/a.md' }
    s.store.snapshot(memory, 'x', 'saved')
    const [v] = s.store.list(memory)
    expect(v?.current).toBe(true)
    expect(() => s.store.restore(memory, v!.id)).toThrow('can’t be restored')
    expect(() => s.store.read(ref, 'nope')).toThrow('no longer exists')
  })

  it('keeps the last 50 within 30 days, and always the newest', () => {
    const s = setup()
    for (let i = 0; i < 60; i++) {
      s.store.snapshot(ref, `text ${i}`, 'saved')
      s.tick(60_000)
    }
    expect(s.store.list(ref)).toHaveLength(50)
    expect(s.store.read(ref, s.store.list(ref)[0]!.id)).toBe('text 59')
    s.setNow(s.now + 40 * DAY)
    s.store.snapshot(ref, 'fresh', 'saved')
    expect(s.store.list(ref).map((v) => s.store.read(ref, v.id))).toEqual(['fresh'])
    s.setNow(s.now + 40 * DAY)
    s.store.snapshot(ref, 'fresh', 'deleted')
    // The older one is past 30 days, the newest always stays.
    expect(s.store.list(ref).map((v) => v.label)).toEqual(['deleted'])
  })

  it('skips files that are too large', () => {
    const s = setup()
    s.store.snapshot(ref, Buffer.alloc(6 * 1024 * 1024, 97), 'saved')
    expect(s.store.list(ref)).toEqual([])
  })
})
