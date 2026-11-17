/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Possible to-dos and insights on the timeline.
// Opt-in: nothing is generated unless proactive.insights is on. One
// one-shot completion reads the activity notes of the range (never raw page
// text) and the site totals, and returns a few short items you can dismiss.
// Results are cached per range in <profile>/activity/insights.json.
import { createHash } from 'node:crypto'
import type { ActivityItem } from '@shared/activity'
import type { Insight, SiteInsight } from '@shared/timeline'
import type { CompleteInput } from '../agent/hostApi'
import { writeAtomic } from '../settings'
import { readJson } from '../stores'
import { siteLabel } from './sessions'
import { mainT } from '../i18n/mainT'

const KINDS = ['habit', 'focus', 'routine-idea', 'todo'] as const satisfies readonly Insight['kind'][]
/** A cached answer is reused this long for the same range and notes. */
const FRESH_MS = 6 * 3_600_000
const MAX_INSIGHTS = 6
const NOTES_BUDGET = 24_000

export const INSIGHTS_SYSTEM = [
  'You look over notes a person\'s browser kept about their own browsing, and point out a few things worth their attention.',
  'Return only a JSON array (no prose) of at most 6 objects: {"kind": "habit" | "focus" | "routine-idea" | "todo", "title": short, "detail": one or two sentences}.',
  'Use "todo" for something they seemed to leave unfinished, "routine-idea" for something they repeat that a scheduled routine could do, "habit" and "focus" for patterns in how they spend time.',
  'Be specific and kind. Never guess at health, money, relationships, religion or politics. If nothing stands out, return [].',
].join('\n')

interface CacheFile {
  key: string | null
  at: number
  items: Insight[]
  dismissed: string[]
}

function insightId(kind: string, title: string): string {
  return createHash('sha256').update(`${kind}\n${title.toLowerCase()}`).digest('hex').slice(0, 24)
}

/** Reads the model's answer: the first JSON array in it, each entry checked; anything malformed is dropped. */
export function parseInsights(text: string, now: number): Insight[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Insight[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const kind = KINDS.find((k) => k === e.kind)
    const title = typeof e.title === 'string' ? e.title.trim().slice(0, 120) : ''
    const detail = typeof e.detail === 'string' ? e.detail.trim().slice(0, 400) : ''
    if (!kind || !title) continue
    // A routine idea opens the routine editor; nothing else gets an action.
    const action = kind === 'routine-idea' ? { label: mainT('core.mainInsights.makeARoutine'), url: 'apex://routines/new' } : null
    out.push({ id: insightId(kind, title), kind, title, detail, action, at: now })
    if (out.length >= MAX_INSIGHTS) break
  }
  return out
}

/** The prompt: dated notes (newest kept when over budget) and the top sites. */
export function insightsPrompt(notes: readonly ActivityItem[], sites: readonly SiteInsight[]): string {
  const lines: string[] = []
  let size = 0
  for (const note of [...notes].sort((a, b) => b.at - a.at)) {
    const line = `## ${new Date(note.at).toLocaleString()}\n${note.text ?? ''}`
    if (size + line.length > NOTES_BUDGET) break
    lines.unshift(line)
    size += line.length
  }
  const top = sites.slice(0, 15).map((s) => `- ${siteLabel(s.origin)}: ${s.visits} visits, ${Math.round(s.activeMs / 60_000)} min`)
  return `Activity notes:\n\n${lines.join('\n\n') || '(none)'}\n\nMost-used sites:\n${top.join('\n') || '(none)'}`
}

export interface InsightsInput {
  enabled: boolean
  range: { from: number; to: number }
  notes: ActivityItem[]
  sites: SiteInsight[]
  companionId?: string
}

export class InsightsCache {
  readonly #file: string
  readonly #complete: (input: CompleteInput) => Promise<string>
  readonly #now: () => number
  readonly #inflight = new Map<string, Promise<Insight[]>>()

  constructor(file: string, complete: (input: CompleteInput) => Promise<string>, now: () => number = Date.now) {
    this.#file = file
    this.#complete = complete
    this.#now = now
  }

  #read(): CacheFile {
    const raw = readJson(this.#file) as Partial<CacheFile> | undefined
    return {
      key: typeof raw?.key === 'string' ? raw.key : null,
      at: typeof raw?.at === 'number' ? raw.at : 0,
      items: Array.isArray(raw?.items) ? raw.items : [],
      dismissed: Array.isArray(raw?.dismissed) ? raw.dismissed.filter((d): d is string => typeof d === 'string') : [],
    }
  }

  #write(file: CacheFile): void {
    writeAtomic(this.#file, JSON.stringify({ ...file, dismissed: file.dismissed.slice(-500) }))
  }

  /** Off, or nothing to read: no insights and no model call. */
  async insights(input: InsightsInput): Promise<Insight[]> {
    if (!input.enabled || (input.notes.length === 0 && input.sites.length === 0)) return []
    const key = `${input.range.from}-${input.range.to}-${input.notes.length}-${input.notes[input.notes.length - 1]?.id ?? ''}`
    const cached = this.#read()
    const visible = (items: Insight[]): Insight[] => items.filter((i) => !this.#read().dismissed.includes(i.id))
    if (cached.key === key && this.#now() - cached.at < FRESH_MS) return visible(cached.items)
    let pending = this.#inflight.get(key)
    if (!pending) {
      pending = this.#complete({
        companionId: input.companionId,
        system: INSIGHTS_SYSTEM,
        prompt: insightsPrompt(input.notes, input.sites),
        maxTokens: 900,
        kind: 'activity',
      })
        .then((text) => {
          const items = parseInsights(text, this.#now())
          this.#write({ ...this.#read(), key, at: this.#now(), items })
          return items
        })
        .finally(() => this.#inflight.delete(key))
      this.#inflight.set(key, pending)
    }
    return visible(await pending)
  }

  dismiss(id: string): void {
    const file = this.#read()
    if (!file.dismissed.includes(id)) this.#write({ ...file, dismissed: [...file.dismissed, id] })
  }
}
