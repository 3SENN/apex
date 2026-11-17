/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeSummary } from '../src/main/chats'

// The chat summary flags: older summaries get actWithoutAsking and muted
// off; files that already have the flags keep theirs.
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'chats', 'formats', name), 'utf8')) as Record<string, unknown>

describe('chat summary flags', () => {
  it('fills the flags for older files', () => {
    expect(normalizeSummary(fixture('original-summary.json'), 'pip')).toMatchObject({ actWithoutAsking: false, muted: false })
  })
  it('keeps them for files that have them', () => {
    expect(normalizeSummary(fixture('flags-summary.json'), 'pip')).toMatchObject({ actWithoutAsking: true, muted: true })
  })
  it('has log events in the expected shapes', () => {
    const log = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'chats', 'formats', 'flags-log.json'), 'utf8')) as { type: string }[]
    expect(log.map((e) => e.type)).toEqual(['user-message', 'tool', 'tool', 'step-limit', 'interrupting', 'stopped'])
  })
})

// Drafts per chat on disk, so they survive a reload or a restart.
describe('composer drafts', () => {
  const id = '0f8f6a2e-1d2b-4c3d-9e4f-5a6b7c8d9e0f'
  it('keeps a draft across a restart, and drops cleared and deleted ones', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { DraftStore } = await import('../src/main/drafts')
    const dir = mkdtempSync(join(tmpdir(), 'apex-drafts-'))
    const first = new DraftStore(dir, 5)
    first.set(id, 'half a thought')
    first.set('11111111-2222-3333-4444-555555555555', 'other')
    first.flush()
    const second = new DraftStore(dir)
    expect(second.get(id)).toBe('half a thought')
    second.set(id, '   ')
    second.remove(['11111111-2222-3333-4444-555555555555'])
    second.flush()
    const third = new DraftStore(dir)
    expect(third.get(id)).toBe('')
    expect(third.get('11111111-2222-3333-4444-555555555555')).toBe('')
  })
})
