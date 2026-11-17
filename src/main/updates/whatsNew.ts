/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WhatsNewEntry } from '@shared/updates'
import { compareVersions, parseVersion } from './supportFeed'

// What's new. After an update the card shows once with the
// combined highlights of every entry in (lastSeen, current]. A first install
// (no lastSeen) never shows it, and Help › What's New reopens the current
// version's entry.

export interface WhatsNewCard {
  entry: WhatsNewEntry
  /** True when the card combines more than one version. */
  since: boolean
}

/** Entries newest first, whatever order they were written in. */
function newestFirst(entries: readonly WhatsNewEntry[]): WhatsNewEntry[] {
  return [...entries].filter((e) => parseVersion(e.version)).sort((a, b) => compareVersions(b.version, a.version))
}

/** The card to show after updating from `lastSeen` to `current`, or null. */
export function selectWhatsNew(entries: readonly WhatsNewEntry[], lastSeen: string | null, current: string): WhatsNewCard | null {
  if (lastSeen === null || !parseVersion(lastSeen) || !parseVersion(current)) return null
  if (compareVersions(lastSeen, current) >= 0) return null
  const range = newestFirst(entries).filter((e) => compareVersions(e.version, lastSeen) > 0 && compareVersions(e.version, current) <= 0)
  const newest = range[0]
  if (!newest) return null
  if (range.length === 1) return { entry: newest, since: false }
  return {
    // The newest entry names the card; the highlights run newest first.
    entry: { version: current, date: newest.date, title: newest.title, highlights: range.flatMap((e) => e.highlights).slice(0, 20) },
    since: true,
  }
}

/** The entry for Help › What's New: this version's, else the newest one before it. */
export function notesFor(entries: readonly WhatsNewEntry[], current: string): WhatsNewEntry | null {
  return newestFirst(entries).find((e) => compareVersions(e.version, current) <= 0) ?? null
}
