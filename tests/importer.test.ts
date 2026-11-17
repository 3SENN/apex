/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { readChromium, readFirefox } from '../src/main/importer'

// Synthetic profiles with the real schemas' relevant columns; no real
// browser data is read.

describe('reading browser profiles', () => {
  it('reads Chromium bookmarks and history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-chrome-'))
    writeFileSync(join(dir, 'Bookmarks'), JSON.stringify({
      roots: { bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'Docs', url: 'https://docs.example/' }] } },
    }))
    const db = new DatabaseSync(join(dir, 'History'))
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)')
    db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)').run('https://news.example/', 'News', 7, 13_380_163_200_000_000, 0)
    db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)').run('https://hidden.example/', 'Hidden', 1, 13_380_163_200_000_000, 1)
    db.close()

    const data = readChromium(dir)
    expect(data.bookmarks).toEqual([{ url: 'https://docs.example/', title: 'Docs' }])
    expect(data.history).toEqual([{ url: 'https://news.example/', title: 'News', visits: 7, lastVisit: Date.UTC(2025, 0, 1) }])
  })

  it('reads Firefox bookmarks and history from the newest profile', () => {
    const profiles = mkdtempSync(join(tmpdir(), 'apex-firefox-'))
    const profile = join(profiles, 'abc.default-release')
    mkdirSync(profile)
    const db = new DatabaseSync(join(profile, 'places.sqlite'))
    db.exec('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER)')
    db.exec('CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, title TEXT)')
    db.prepare('INSERT INTO moz_places (id, url, title, visit_count, last_visit_date) VALUES (?, ?, ?, ?, ?)').run(1, 'https://mdn.example/', 'MDN', 3, 1_735_689_600_000_000)
    db.prepare('INSERT INTO moz_places (id, url, title, visit_count, last_visit_date) VALUES (?, ?, ?, ?, ?)').run(2, 'https://never.example/', 'Never', 0, null)
    db.prepare('INSERT INTO moz_bookmarks (type, fk, title) VALUES (?, ?, ?)').run(1, 1, 'MDN docs')
    db.prepare('INSERT INTO moz_bookmarks (type, fk, title) VALUES (?, ?, ?)').run(2, null, 'A folder')
    db.close()

    const data = readFirefox(profiles)
    expect(data.bookmarks).toEqual([{ url: 'https://mdn.example/', title: 'MDN docs' }])
    expect(data.history).toEqual([{ url: 'https://mdn.example/', title: 'MDN', visits: 3, lastVisit: Date.UTC(2025, 0, 1) }])
  })

  it('returns nothing for a missing Firefox profile folder', () => {
    expect(readFirefox(join(tmpdir(), 'apex-no-such-dir'))).toEqual({ bookmarks: [], history: [] })
  })
})
