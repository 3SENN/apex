/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Hourly activity notes: a one-shot completion turns the
// last hour's captures into a short dated note, appended to
// /memories/activity/YYYY-MM-DD.md in the active companion's memory, so a
// companion remembers what you worked on without keeping raw page text.
import { localDayKey, type ActivityItem } from '@shared/activity'

const PROMPT_BUDGET = 40_000
const PER_PAGE = 1_500

export const NOTES_SYSTEM = [
  'You write short private notes about what a person worked on in their browser during the last hour, from pages their own browser captured.',
  'Write 2 to 6 plain bullet points in the second person ("You compared…"), naming sites and topics. No preamble, no headings.',
  'Leave out anything about health, money, relationships, religion, politics or identity documents, and never copy passwords, codes or personal numbers.',
  'If nothing meaningful happened, reply with an empty message.',
].join('\n')

/** The memory file for a day's notes. */
export function activityNotePath(at: number): string {
  return `/memories/activity/${localDayKey(at)}.md`
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Appends one hour's note under a time heading; a new file starts with the date. */
export function appendNote(existing: string, from: number, to: number, note: string): string {
  const head = existing.trim() ? existing.replace(/\s+$/, '') : `# Activity on ${localDayKey(to)}`
  return `${head}\n\n## ${clock(from)}–${clock(to)}\n\n${note.trim()}\n`
}

/** The hour's pages, oldest first: one block per page with an excerpt of its text, within a budget. */
export function notesPrompt(items: readonly ActivityItem[]): string {
  const blocks: string[] = []
  let size = 0
  const seen = new Set<string>()
  for (const item of items) {
    const key = `${item.kind}:${item.url}`
    if (item.kind === 'visit' && seen.has(key)) continue
    seen.add(key)
    const text = item.kind === 'capture' && item.text ? `\n${item.text.slice(0, PER_PAGE)}` : ''
    const block = `[${clock(item.at)}] ${item.title || item.url}\n${item.url}${text}`
    if (size + block.length > PROMPT_BUDGET) break
    blocks.push(block)
    size += block.length
  }
  return `Pages from the last hour:\n\n${blocks.join('\n\n')}`
}
