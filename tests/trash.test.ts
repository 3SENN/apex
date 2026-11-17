/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { daysLeft, pruneSelection, selectionState, toggled, type TrashKind } from '@shared/workspace'
import { openDb } from '../src/main/db'
import { freePath, movePath } from '../src/main/workspace/fsutil'
import { TrashStore, type TrashAdapter } from '../src/main/workspace/trash'

const DAY = 86_400_000
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'apex-trash-'))
  dirs.push(dir)
  const files = join(dir, 'files')
  mkdirSync(files)
  let now = 5 * DAY
  const purged: unknown[] = []
  // A file adapter like the workspace's: the id is the path; restore moves it back, with a suffix on a clash.
  const fileAdapter: TrashAdapter = {
    kind: 'file',
    title: (id) => basename(id),
    snapshot: (id) => ({ payload: { path: id }, files: [id] }),
    restore: (payload, kept) => {
      const target = freePath((payload as { path: string }).path)
      movePath(kept[0]!, target)
      return basename(target)
    },
    purge: (payload) => void purged.push(payload),
  }
  const records = new Map<string, string>([['p1', 'Launch plan']])
  const projectAdapter: TrashAdapter = {
    kind: 'project',
    title: (id) => records.get(id) ?? id,
    snapshot: (id) => ({ payload: { id, name: records.get(id) } }),
    restore: (payload) => {
      const p = payload as { id: string; name: string }
      records.set(p.id, p.name)
      return p.name
    },
  }
  const adapters = new Map<TrashKind, TrashAdapter>([['file', fileAdapter], ['project', projectAdapter]])
  const counts: number[] = []
  const store = new TrashStore({ db: openDb(':memory:'), dir: join(dir, 'trash'), adapter: (k) => adapters.get(k), now: () => now, onChange: (n) => counts.push(n) })
  const file = (name: string, text = 'hello'): string => {
    const p = join(files, name)
    writeFileSync(p, text)
    return p
  }
  return { store, file, files, records, purged, counts, advance: (ms: number) => (now += ms) }
}

describe('Recently Deleted', () => {
  it('moves files in, lists them with expiry and size, and restores them', () => {
    const s = setup()
    const path = s.file('notes.md', 'twelve bytes')
    const item = s.store.put('file', path)
    expect(existsSync(path)).toBe(false)
    expect(item).toMatchObject({ kind: 'file', title: 'notes.md', size: 12, expiresAt: item.deletedAt + 30 * DAY })
    expect(s.store.list()).toHaveLength(1)
    expect(s.store.restore([item.id])).toEqual({ restored: 1, renamed: [] })
    expect(readFileSync(path, 'utf8')).toBe('twelve bytes')
    expect(s.store.list()).toEqual([])
    expect(s.counts).toEqual([1, 0])
  })

  it('gives a restored file a suffix when its name is taken', () => {
    const s = setup()
    const path = s.file('a.txt', 'old')
    const item = s.store.put('file', path)
    s.file('a.txt', 'new')
    expect(s.store.restore([item.id])).toEqual({ restored: 1, renamed: ['a 2.txt'] })
    expect(readFileSync(join(s.files, 'a 2.txt'), 'utf8')).toBe('old')
    expect(readFileSync(join(s.files, 'a.txt'), 'utf8')).toBe('new')
  })

  it('keeps payload-only items (projects)', () => {
    const s = setup()
    const item = s.store.put('project', 'p1')
    s.records.delete('p1')
    expect(item.size).toBeNull()
    s.store.restore([item.id])
    expect(s.records.get('p1')).toBe('Launch plan')
  })

  it('filters by kind and title, newest first', () => {
    const s = setup()
    s.store.put('file', s.file('report.md'))
    s.advance(1000)
    s.store.put('project', 'p1')
    expect(s.store.list().map((i) => i.title)).toEqual(['Launch plan', 'report.md'])
    expect(s.store.list({ kind: 'file' }).map((i) => i.title)).toEqual(['report.md'])
    expect(s.store.list({ query: 'LAUNCH' }).map((i) => i.title)).toEqual(['Launch plan'])
  })

  it('purges for good, empties, and drops items after 30 days', () => {
    const s = setup()
    const a = s.store.put('file', s.file('a.md'))
    s.store.put('file', s.file('b.md'))
    expect(s.store.purge([a.id])).toBe(1)
    expect(s.purged).toHaveLength(1)
    expect(s.store.list()).toHaveLength(1)
    expect(s.store.empty()).toBe(1)
    s.store.put('file', s.file('c.md'))
    s.advance(29 * DAY)
    expect(s.store.purgeExpired()).toBe(0)
    s.advance(2 * DAY)
    expect(s.store.purgeExpired()).toBe(1)
    expect(s.store.list()).toEqual([])
  })

  it('refuses kinds with no adapter and leaves files in place when a move fails', () => {
    const s = setup()
    expect(() => s.store.put('skill', 'x')).toThrow('can’t handle')
    expect(() => s.store.put('file', join(s.files, 'missing.md'))).toThrow()
    expect(s.store.list()).toEqual([])
  })

  it('reports a missing saved copy instead of restoring nothing', () => {
    const s = setup()
    const item = s.store.put('file', s.file('gone.md'))
    rmSync(join(s.files, '..', 'trash', item.id), { recursive: true, force: true })
    expect(() => s.store.restore([item.id])).toThrow('missing')
  })
})

describe('the Recently deleted list', () => {
  it('counts days left, and keeps the selection to what is shown', () => {
    const now = 1_000 * 86_400_000
    expect(daysLeft(now + 30 * 86_400_000, now)).toBe(30)
    expect(daysLeft(now + 3_600_000, now)).toBe(0)
    expect(daysLeft(now - 1, now)).toBe(0)
    const shown = ['a', 'b', 'c']
    expect(selectionState(shown, new Set())).toBe('none')
    expect(selectionState(shown, new Set(['a']))).toBe('some')
    expect(selectionState(shown, new Set(shown))).toBe('all')
    expect([...toggled(new Set(['a']), 'b')]).toEqual(['a', 'b'])
    expect([...toggled(new Set(['a', 'b']), 'a')]).toEqual(['b'])
    expect([...pruneSelection(new Set(['a', 'x']), shown)]).toEqual(['a'])
  })
})
