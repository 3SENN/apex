/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { timelineDays } from '../src/renderer/src/companion-card/logic/notes'
import { fileTypeLabel } from '../src/renderer/src/companion-card/logic/files'
import { describeSchedule, scheduleToForm } from '../src/renderer/src/companion-card/logic/schedule'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h).getTime()

describe('memory timeline (DS-116)', () => {
  it('groups notes by calendar day, newest first, with Today and Yesterday', () => {
    const now = at(2026, 9, 29, 15)
    const notes = [
      { path: '/memories/a.md', modifiedAt: at(2026, 9, 29, 9), author: null },
      { path: '/memories/b.md', modifiedAt: at(2026, 9, 28, 20), author: null },
      { path: '/memories/c.md', modifiedAt: at(2026, 9, 29, 14), author: null },
      { path: '/memories/d.md', modifiedAt: at(2025, 2, 3), author: null },
    ]
    const days = timelineDays(notes as never, now)
    expect(days.map((d) => d.label.split(' ')[0])).toEqual(['Today', 'Yesterday', 'Mon'])
    expect(days[0]!.items.map((n) => n.path)).toEqual(['/memories/c.md', '/memories/a.md'])
    expect(days[2]!.label).toContain('2025')
  })
})

describe('files type column (DS-115)', () => {
  it('names common types and falls back to the extension', () => {
    expect(fileTypeLabel({ kind: 'folder', name: 'Trips' })).toBe('Folder')
    expect(fileTypeLabel({ kind: 'file', name: 'notes.md' })).toBe('Markdown')
    expect(fileTypeLabel({ kind: 'file', name: 'scan.PDF' })).toBe('PDF')
    expect(fileTypeLabel({ kind: 'file', name: 'archive.tar.zst' })).toBe('ZST')
    expect(fileTypeLabel({ kind: 'file', name: 'README' })).toBe('File')
    expect(fileTypeLabel({ kind: 'file', name: '.env' })).toBe('File')
  })
})

describe('routine schedules in both shapes', () => {
  it('describes full schedules and older intervals', () => {
    expect(describeSchedule({ kind: 'interval', minutes: 30 })).toBe('Every 30 minutes')
    expect(describeSchedule({ kind: 'interval', minutes: 120 })).toBe('Every 2 hours')
    expect(describeSchedule({ kind: 'interval', hours: 1 })).toBe('Every hour')
    expect(describeSchedule({ kind: 'cron', expr: '0 8 * * 1' })).toBe('Custom schedule (0 8 * * 1)')
    expect(describeSchedule({ kind: 'once', at: at(2026, 9, 29) })).toMatch(/^Once, /)
    expect(scheduleToForm({ kind: 'interval', minutes: 90 })).toMatchObject({ kind: 'interval', hours: 2 })
    expect(scheduleToForm({ kind: 'cron', expr: '* * * * *' })).toMatchObject({ kind: 'daily', time: '09:00' })
  })
})
