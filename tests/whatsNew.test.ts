/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WhatsNewEntry } from '../src/shared/updates'
import { WHATS_NEW } from '../src/shared/whatsNew'
import { compareVersions, parseVersion } from '../src/main/updates/supportFeed'
import { notesFor, selectWhatsNew } from '../src/main/updates/whatsNew'

// What's new: selection after an update, and the entries themselves.

const entries: WhatsNewEntry[] = [
  { version: '1.2.0', date: '2026-12-01', title: 'Twelve', highlights: [{ title: 'C', body: 'c' }] },
  { version: '1.0.0', date: '2026-10-01', title: 'Ten', highlights: [{ title: 'A', body: 'a' }] },
  { version: '1.1.0', date: '2026-11-01', title: 'Eleven', highlights: [{ title: 'B', body: 'b' }, { title: 'B2', body: 'b2' }] },
]

describe("what's new selection", () => {
  it('shows nothing on a first install', () => {
    expect(selectWhatsNew(entries, null, '1.2.0')).toBeNull()
  })

  it('shows the one entry after a single update', () => {
    expect(selectWhatsNew(entries, '1.0.0', '1.1.0')).toEqual({ entry: entries[2], since: false })
  })

  it('combines every version since the last one seen, newest first, after skipping versions', () => {
    const card = selectWhatsNew(entries, '0.9.0', '1.2.0')
    expect(card?.since).toBe(true)
    expect(card?.entry).toMatchObject({ version: '1.2.0', title: 'Twelve' })
    expect(card?.entry.highlights.map((h) => h.title)).toEqual(['C', 'B', 'B2', 'A'])
  })

  it('shows nothing when nothing is newer, or after a downgrade', () => {
    expect(selectWhatsNew(entries, '1.2.0', '1.2.0')).toBeNull()
    expect(selectWhatsNew(entries, '1.2.0', '1.1.0')).toBeNull()
    expect(selectWhatsNew(entries, '1.2.0', '1.3.0')).toBeNull()
  })

  it("finds Help › What's New's entry", () => {
    expect(notesFor(entries, '1.1.0')?.title).toBe('Eleven')
    expect(notesFor(entries, '1.1.5')?.title).toBe('Eleven')
    expect(notesFor(entries, '0.5.0')).toBeNull()
  })
})

describe("the what's new entries", () => {
  it('are valid, newest first, and include the package version', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
    expect(WHATS_NEW.some((e) => e.version === pkg.version)).toBe(true)
    for (const [i, e] of WHATS_NEW.entries()) {
      expect(parseVersion(e.version), e.version).not.toBeNull()
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.title.length).toBeLessThanOrEqual(200)
      expect(e.highlights.length).toBeGreaterThan(0)
      expect(e.highlights.length).toBeLessThanOrEqual(20)
      for (const h of e.highlights) expect(h.body.length).toBeLessThanOrEqual(2000)
      if (i > 0) expect(compareVersions(WHATS_NEW[i - 1]!.version, e.version)).toBe(1)
    }
  })
})
