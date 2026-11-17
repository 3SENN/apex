/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chatDateGroup, type ChatDateGroup } from '@shared/chats'
import { t } from '@shared/i18n/core'

// Memory notes and companion files in the card: deep-link ids, grouping and
// filtering. Paths contain slashes and dots, which apex:// item ids don't
// allow, so links carry them base64url-encoded.

const ITEM_MAX = 128
const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(id: string): string | null {
  try {
    const padded = id.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (id.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** The apex://companion/<id>/<section>/<item> id for a path, or null when the path is too long to link. */
export function pathToItem(path: string): string | null {
  if (!path) return null
  const id = toBase64Url(path)
  return id.length <= ITEM_MAX ? id : null
}

/** The path a link's item id stands for; null for ids that aren't encoded paths. */
export function itemToPath(item: string | null): string | null {
  if (!item || !ITEM_ID.test(item)) return null
  const path = fromBase64Url(item)
  return path && !path.includes('\0') ? path : null
}

export type AuthorFilter = 'all' | 'agent' | 'you'

export interface NoteLike {
  path: string
  modifiedAt: number
  author: 'agent' | 'you' | null
}

/** "/memories/trips/kyoto.md" → "kyoto". */
export function noteTitle(path: string): string {
  const last = path.split('/').filter(Boolean).pop() ?? path
  return last.replace(/\.(md|txt)$/i, '') || last
}

/** The folder part shown under a note's title: "trips" for /memories/trips/kyoto.md, '' at the top. */
export function noteFolder(path: string): string {
  const parts = path.replace(/^\/memories\/?/, '').split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

/** Notes matching every word of `query` (in the path) and the author filter. Unknown authors match only 'all'. */
export function filterNotes<T extends NoteLike>(notes: readonly T[], filter: { author?: AuthorFilter; query?: string } = {}): T[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const author = filter.author ?? 'all'
  return notes.filter((n) => {
    if (author !== 'all' && n.author !== author) return false
    const haystack = n.path.toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}

export const DATE_GROUP_LABELS: Record<ChatDateGroup, string> = {
  get today() { return t('coCard.notes.today') },
  get yesterday() { return t('coCard.notes.yesterday') },
  get week() { return t('coCard.notes.previous7Days') },
  get month() { return t('coCard.notes.previous30Days') },
  get older() { return t('coCard.notes.earlier') },
}

/** Notes grouped by when they last changed, newest group and newest note first; empty groups are left out. */
export function groupByDate<T extends NoteLike>(notes: readonly T[], now = Date.now()): Array<{ group: ChatDateGroup; label: string; items: T[] }> {
  const order: ChatDateGroup[] = ['today', 'yesterday', 'week', 'month', 'older']
  const buckets = new Map<ChatDateGroup, T[]>()
  for (const note of [...notes].sort((a, b) => b.modifiedAt - a.modifiedAt)) {
    const group = chatDateGroup(note.modifiedAt, now)
    const list = buckets.get(group) ?? []
    list.push(note)
    buckets.set(group, list)
  }
  return order.flatMap((group) => {
    const items = buckets.get(group)
    return items ? [{ group, label: DATE_GROUP_LABELS[group], items }] : []
  })
}

/**
 * A memory path for a new note typed as a name: "Trip ideas" →
 * "/memories/trip-ideas.md". Slashes make folders. Returns null when nothing
 * usable is left, or for the shared folder, which belongs to the shared owner.
 */
export function notePathFromName(name: string): string | null {
  const parts = name
    .split('/')
    .map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._ -]+/g, '')
        .replace(/\s+/g, '-')
        .replace(/^\.+/, '')
        .slice(0, 60),
    )
    .filter((part) => part && part !== '.' && part !== '..')
  if (parts.length === 0) return null
  if (parts[0] === 'shared') return null
  const last = parts.length - 1
  if (!/\.[a-z0-9]{1,8}$/.test(parts[last] ?? '')) parts[last] = `${parts[last]}.md`
  return `/memories/${parts.join('/')}`
}

/**
 * DS-116: notes grouped by calendar day for the timeline, newest first, with
 * the date column's label: "Today", "Yesterday", or a short date ("Mon 3 Oct",
 * with the year when it isn't this year).
 */
export function timelineDays<T extends NoteLike>(notes: readonly T[], now = Date.now()): Array<{ day: string; label: string; items: T[] }> {
  const dayKey = (ms: number): string => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now).setDate(new Date(now).getDate() - 1))
  const thisYear = new Date(now).getFullYear()
  const out: Array<{ day: string; label: string; items: T[] }> = []
  for (const note of [...notes].sort((a, b) => b.modifiedAt - a.modifiedAt)) {
    const day = dayKey(note.modifiedAt)
    let entry = out[out.length - 1]
    if (!entry || entry.day !== day) {
      const date = new Date(note.modifiedAt)
      const label =
        day === today
          ? t('coCard.notes.today')
          : day === yesterday
            ? t('coCard.notes.yesterday')
            : date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(date.getFullYear() === thisYear ? {} : { year: 'numeric' }) }).replace(',', '')
      entry = { day, label, items: [] }
      out.push(entry)
    }
    entry.items.push(note)
  }
  return out
}


/** One row of the Memory tab's tidy timeline: the next pass (or "off") on top, then past passes, newest first. */
export interface TidyEntry {
  key: string
  kind: 'next' | 'off' | 'pass'
  /** The bold date column line ("Tonight", "Today", "Yesterday", "Mon 3 Nov"). */
  day: string
  /** The muted line under it ("after 03:00", "11:28"). */
  time: string
  pass: import('@shared/activity').TidyPass | null
}

export interface TidyLabels {
  tonight: string
  today: string
  yesterday: string
  /** "after {hour}" with the hour filled in. */
  after(hour: string): string
}

const hh = (hour: number): string => `${String(hour).padStart(2, '0')}:00`

function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** "Today", "Yesterday" or a short date, for a past moment. */
export function pastDayLabel(at: number, now: number, labels: Pick<TidyLabels, 'today' | 'yesterday'>): string {
  if (sameDay(at, now)) return labels.today
  const d = new Date(now)
  if (sameDay(at, new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).getTime())) return labels.yesterday
  const date = new Date(at)
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(date.getFullYear() === d.getFullYear() ? {} : { year: 'numeric' }) }).replace(',', '')
}

/**
 * The tidy timeline for one companion: the next nightly pass (within a day
 * reads "Tonight"; when Tidy memory is off, an "off" row instead), then its
 * past passes, newest first.
 */
export function tidyEntries(
  passes: ReadonlyArray<import('@shared/activity').TidyPass>,
  companionId: string,
  upkeep: { enabled: boolean; afterHour: number; nextAt: number | null },
  now: number,
  labels: TidyLabels,
): TidyEntry[] {
  const out: TidyEntry[] = []
  if (!upkeep.enabled) out.push({ key: 'off', kind: 'off', day: '', time: '', pass: null })
  else {
    const at = upkeep.nextAt ?? now
    const day = at - now < 86_400_000 ? labels.tonight : pastDayLabel(at, now, labels)
    out.push({ key: 'next', kind: 'next', day, time: labels.after(hh(upkeep.afterHour)), pass: null })
  }
  const mine = passes.filter((p) => p.companionId === companionId).sort((a, b) => b.at - a.at)
  for (const pass of mine) {
    const time = new Date(pass.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    out.push({ key: pass.id, kind: 'pass', day: pastDayLabel(pass.at, now, labels), time, pass })
  }
  return out
}
