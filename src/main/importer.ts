/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HistoryItem, ImportSource } from '@shared/services'

// Imports bookmarks and history from other browsers' profile files. Passwords
// and cookies are deliberately out of scope. Databases are copied first,
// because the owning browser keeps them locked while it runs.

export interface ImportSourceDef extends ImportSource {
  /** Chromium: the profile directory. Firefox: the Profiles directory. */
  dir: string
}

export interface ImportedData {
  bookmarks: Array<{ url: string; title: string }>
  history: HistoryItem[]
}

const HISTORY_LIMIT = 5000
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000

export function candidateSources(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): ImportSourceDef[] {
  const chromium = (id: string, name: string, dir: string): ImportSourceDef => ({ id, name, kind: 'chromium', dir })
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return [
      chromium('chrome', 'Google Chrome', join(support, 'Google', 'Chrome', 'Default')),
      chromium('arc', 'Arc', join(support, 'Arc', 'User Data', 'Default')),
      chromium('brave', 'Brave', join(support, 'BraveSoftware', 'Brave-Browser', 'Default')),
      chromium('edge', 'Microsoft Edge', join(support, 'Microsoft Edge', 'Default')),
      chromium('vivaldi', 'Vivaldi', join(support, 'Vivaldi', 'Default')),
      chromium('chromium', 'Chromium', join(support, 'Chromium', 'Default')),
      { id: 'firefox', name: 'Firefox', kind: 'firefox', dir: join(support, 'Firefox', 'Profiles') },
    ]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [
      chromium('chrome', 'Google Chrome', join(local, 'Google', 'Chrome', 'User Data', 'Default')),
      chromium('brave', 'Brave', join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default')),
      chromium('edge', 'Microsoft Edge', join(local, 'Microsoft', 'Edge', 'User Data', 'Default')),
      chromium('vivaldi', 'Vivaldi', join(local, 'Vivaldi', 'User Data', 'Default')),
      { id: 'firefox', name: 'Firefox', kind: 'firefox', dir: join(roaming, 'Mozilla', 'Firefox', 'Profiles') },
    ]
  }
  const config = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return [
    chromium('chrome', 'Google Chrome', join(config, 'google-chrome', 'Default')),
    chromium('brave', 'Brave', join(config, 'BraveSoftware', 'Brave-Browser', 'Default')),
    chromium('edge', 'Microsoft Edge', join(config, 'microsoft-edge', 'Default')),
    chromium('chromium', 'Chromium', join(config, 'chromium', 'Default')),
    chromium('vivaldi', 'Vivaldi', join(config, 'vivaldi', 'Default')),
    { id: 'firefox', name: 'Firefox', kind: 'firefox', dir: join(home, '.mozilla', 'firefox') },
  ]
}

export function availableSources(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): ImportSourceDef[] {
  return candidateSources(platform, home, env).filter((s) =>
    s.kind === 'chromium' ? existsSync(join(s.dir, 'Bookmarks')) || existsSync(join(s.dir, 'History')) : firefoxPlaces(s.dir) !== null)
}

// ---- Chromium ----

/** Chromium stores microseconds since 1601, beyond Number's safe range. */
export function chromeTimeToMs(value: number | bigint | string): number {
  const micros = BigInt(typeof value === 'number' ? Math.trunc(value) : value)
  return micros > 0n ? Number(micros / 1000n) - CHROME_EPOCH_OFFSET_MS : 0
}

const toNumber = (value: unknown): number => (typeof value === 'bigint' ? Number(value) : Number(value) || 0)

/** Flattens a Chromium "Bookmarks" JSON file into URL bookmarks. */
export function parseChromiumBookmarks(json: unknown): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = []
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 64) return
    const n = node as { type?: unknown; url?: unknown; name?: unknown; children?: unknown }
    if (n.type === 'url' && typeof n.url === 'string') out.push({ url: n.url, title: typeof n.name === 'string' ? n.name : n.url })
    if (Array.isArray(n.children)) for (const child of n.children) visit(child, depth + 1)
  }
  const roots = (json as { roots?: Record<string, unknown> } | null)?.roots
  if (roots && typeof roots === 'object') for (const root of Object.values(roots)) visit(root, 0)
  return out
}

function withCopy<T>(file: string, read: (copy: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-import-'))
  const copy = join(dir, 'db.sqlite')
  try {
    copyFileSync(file, copy)
    return read(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function query<T>(file: string, sql: string): T[] {
  return withCopy(file, (copy) => {
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      // Integers are read as BigInt: Chromium timestamps exceed 2^53.
      const statement = db.prepare(sql)
      statement.setReadBigInts(true)
      return statement.all() as T[]
    } finally {
      db.close()
    }
  })
}

export function readChromium(dir: string): ImportedData {
  const bookmarksFile = join(dir, 'Bookmarks')
  const bookmarks = existsSync(bookmarksFile) ? parseChromiumBookmarks(JSON.parse(readFileSync(bookmarksFile, 'utf8'))) : []
  const historyFile = join(dir, 'History')
  const history = existsSync(historyFile)
    ? query<{ url: string; title: string | null; visit_count: bigint; last_visit_time: bigint }>(
        historyFile,
        `SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ${HISTORY_LIMIT}`,
      ).map((r) => ({ url: r.url, title: r.title ?? '', visits: toNumber(r.visit_count) || 1, lastVisit: chromeTimeToMs(r.last_visit_time) }))
    : []
  return { bookmarks, history }
}

// ---- Firefox ----

/** The places.sqlite of the most recently used Firefox profile. */
export function firefoxPlaces(profilesDir: string): string | null {
  if (!existsSync(profilesDir)) return null
  let best: { file: string; mtime: number } | null = null
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(profilesDir, entry.name, 'places.sqlite')
    if (!existsSync(file)) continue
    const mtime = statSync(file).mtimeMs
    if (!best || mtime > best.mtime) best = { file, mtime }
  }
  return best?.file ?? null
}

export function readFirefox(profilesDir: string): ImportedData {
  const places = firefoxPlaces(profilesDir)
  if (!places) return { bookmarks: [], history: [] }
  const bookmarks = query<{ url: string; title: string | null }>(
    places,
    'SELECT p.url AS url, b.title AS title FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id WHERE b.type = 1',
  ).map((r) => ({ url: r.url, title: r.title ?? r.url }))
  const history = query<{ url: string; title: string | null; visit_count: bigint; last_visit_date: bigint | null }>(
    places,
    `SELECT url, title, visit_count, last_visit_date FROM moz_places WHERE visit_count > 0 ORDER BY last_visit_date DESC LIMIT ${HISTORY_LIMIT}`,
  ).map((r) => ({ url: r.url, title: r.title ?? '', visits: toNumber(r.visit_count) || 1, lastVisit: r.last_visit_date ? Number(r.last_visit_date / 1000n) : 0 }))
  return { bookmarks, history }
}

export function readSource(source: ImportSourceDef): ImportedData {
  return source.kind === 'chromium' ? readChromium(source.dir) : readFirefox(source.dir)
}
