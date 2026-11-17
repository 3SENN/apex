/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Suggested routines (DS-102): an original starter set,
// plus, only when Settings › Activity memory › proactive routines is on,
// ideas from local signals: a prompt you keep typing, and a site you open
// most mornings. Nothing leaves the machine to make them. Dismissed ids are
// remembered in userData/routine-suggestions.json; excluded sites never
// show.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatSummary } from '@shared/chats'
import type { Exclusions } from '@shared/exclusions'
import type { RoutineSuggestion } from '@shared/routines'
import type { SiteInsight } from '@shared/timeline'
import { writeAtomic } from '../settings'
import { mainT } from '../i18n/mainT'

const DAY = 86_400_000
const WEEKDAYS = [1, 2, 3, 4, 5]

/** Atelier's own starters, shown on the Routines page until dismissed. */
export const STARTER_SUGGESTIONS: readonly RoutineSuggestion[] = [
  {
    id: 'starter-morning-brief',
    get title() { return mainT('skills.mainSuggestions.morningBrief') },
    get reason() { return mainT('skills.mainSuggestions.weekdaysAt800') },
    draft: { get name() { return mainT('skills.mainSuggestions.morningBrief') }, get prompt() { return mainT('skills.mainSuggestions.giveMeAShort') }, schedule: { kind: 'daily', time: '08:00', days: WEEKDAYS } },
  },
  {
    id: 'starter-weekly-review',
    get title() { return mainT('skills.mainSuggestions.fridayReview') },
    get reason() { return mainT('skills.mainSuggestions.fridaysAt1600') },
    draft: { get name() { return mainT('skills.mainSuggestions.fridayReview') }, prompt: '', skillId: 'builtin-weekly-review', schedule: { kind: 'daily', time: '16:00', days: [5] } },
  },
  {
    id: 'starter-reading-digest',
    get title() { return mainT('skills.mainSuggestions.sundayReadingDigest') },
    get reason() { return mainT('skills.mainSuggestions.sundaysAt1000') },
    draft: { get name() { return mainT('skills.mainSuggestions.sundayReadingDigest') }, prompt: '', skillId: 'builtin-reading-digest', schedule: { kind: 'daily', time: '10:00', days: [0] } },
  },
  {
    id: 'starter-price-check',
    get title() { return mainT('skills.mainSuggestions.dailyPriceCheck') },
    get reason() { return mainT('skills.mainSuggestions.everyDayAtNoon') },
    draft: { get name() { return mainT('skills.mainSuggestions.dailyPriceCheck') }, get prompt() { return mainT('skills.mainSuggestions.checkThePriceOf') }, skillId: 'builtin-price-watch', schedule: { kind: 'daily', time: '12:00', days: [] } },
  },
  {
    id: 'starter-month-start',
    get title() { return mainT('skills.mainSuggestions.firstOfTheMonth') },
    get reason() { return mainT('skills.mainSuggestions.onThe1stAt') },
    draft: { get name() { return mainT('skills.mainSuggestions.firstOfTheMonth') }, get prompt() { return mainT('skills.mainSuggestions.fromMyNotesAnd') }, schedule: { kind: 'cron', expr: '0 9 1 * *' } },
  },
  {
    id: 'starter-evening-wrap',
    get title() { return mainT('skills.mainSuggestions.eveningWrapUp') },
    get reason() { return mainT('skills.mainSuggestions.weekdaysAt1800') },
    draft: { get name() { return mainT('skills.mainSuggestions.eveningWrapUp') }, get prompt() { return mainT('skills.mainSuggestions.lookAtWhatWe') }, schedule: { kind: 'daily', time: '18:00', days: WEEKDAYS } },
  },
]

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** A title folded for comparing: lower case, no punctuation, single spaces. */
export function promptKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Prompts you asked on at least three different days in the last month
 * (chat titles are the first line of the first message). The routine runs
 * at the hour you usually ask.
 */
export function repeatedPrompts(chats: readonly ChatSummary[], now: number): RoutineSuggestion[] {
  const groups = new Map<string, { title: string; days: Set<string>; hours: number[] }>()
  for (const chat of chats) {
    if (chat.private || chat.routineId || chat.routineRun || chat.parentChatId || chat.createdAt < now - 30 * DAY) continue
    const key = promptKey(chat.title)
    if (key.length < 8 || key.split(' ').length < 2) continue
    const at = new Date(chat.createdAt)
    const g = groups.get(key) ?? { title: chat.title, days: new Set<string>(), hours: [] }
    g.days.add(at.toDateString())
    g.hours.push(at.getHours())
    groups.set(key, g)
  }
  const out: RoutineSuggestion[] = []
  for (const [key, g] of groups) {
    if (g.days.size < 3) continue
    const hours = [...g.hours].sort((a, b) => a - b)
    const hour = hours[Math.floor(hours.length / 2)] ?? 9
    const time = `${String(hour).padStart(2, '0')}:00`
    out.push({
      id: `prompt-${hash(key)}`,
      title: g.title.length > 48 ? `${g.title.slice(0, 47)}…` : g.title,
      reason: mainT('skills.mainSuggestions.youAskedThisOn', { size: g.days.size, time }),
      draft: { name: g.title.slice(0, 80), prompt: g.title, schedule: { kind: 'daily', time, days: [] } },
    })
  }
  return out.sort((a, b) => a.title.localeCompare(b.title)).slice(0, 3)
}

/** Sites you opened on at least four of the last fourteen mornings (06:00–10:00). */
export function morningSites(sites: (q: { from: number; to: number }) => SiteInsight[], now: number, excluded: (url: string) => boolean): RoutineSuggestion[] {
  const mornings = new Map<string, { site: SiteInsight; count: number }>()
  const today = new Date(now)
  for (let d = 1; d <= 14; d++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d)
    const from = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 6).getTime()
    let list: SiteInsight[] = []
    try {
      list = sites({ from, to: from + 4 * 3_600_000 })
    } catch {
      return []
    }
    for (const site of list) {
      const entry = mornings.get(site.origin) ?? { site, count: 0 }
      entry.count++
      mornings.set(site.origin, entry)
    }
  }
  return [...mornings.values()]
    .filter((m) => m.count >= 4 && !excluded(m.site.origin))
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map(({ site }) => {
      const host = site.origin.replace(/^https?:\/\//, '')
      return {
        id: `site-${hash(site.origin)}`,
        title: mainT('skills.mainSuggestions.whatSNewOn', { host }),
        reason: mainT('skills.mainSuggestions.youOpenMostMornings', { host }),
        draft: { name: mainT('skills.mainSuggestions.whatSNewOn', { host }), prompt: mainT('skills.mainSuggestions.checkAndTellMe', { origin: site.origin }), schedule: { kind: 'daily', time: '08:00', days: WEEKDAYS } },
      }
    })
}

export interface SuggestionSources {
  dataDir: string
  /** Whether personalised suggestions are on (`proactive.routines`), and what activity memory excludes. */
  proactive(): { routines: boolean; excluded: Exclusions | null }
  chats(): ChatSummary[]
  sites?: (q: { from: number; to: number }) => SiteInsight[]
  isExcluded(url: string, excluded: Exclusions): boolean
  /** Routine names already saved: a starter with the same name is hidden. */
  routineNames(): string[]
  now?: () => number
}

export class RoutineSuggestions {
  readonly #src: SuggestionSources
  readonly #path: string
  #dismissed: Set<string>

  constructor(src: SuggestionSources) {
    this.#src = src
    this.#path = join(src.dataDir, 'routine-suggestions.json')
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.#path, 'utf8'))
    } catch {
      raw = null
    }
    const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { dismissed?: unknown }).dismissed) ? (raw as { dismissed: unknown[] }).dismissed : []
    this.#dismissed = new Set(list.filter((x): x is string => typeof x === 'string'))
  }

  list(): RoutineSuggestion[] {
    const now = this.#src.now?.() ?? Date.now()
    const names = new Set(this.#src.routineNames().map((n) => n.toLowerCase()))
    const out: RoutineSuggestion[] = []
    const { routines: personal, excluded } = this.#src.proactive()
    if (personal) {
      out.push(...repeatedPrompts(this.#src.chats(), now))
      if (this.#src.sites) {
        // Without the exclusion list, nothing site-based is suggested.
        const blocked = (url: string): boolean => {
          if (!excluded) return true
          try {
            return this.#src.isExcluded(url, excluded)
          } catch {
            return true
          }
        }
        out.push(...morningSites(this.#src.sites, now, blocked))
      }
    }
    out.push(...STARTER_SUGGESTIONS)
    return out.filter((s) => !this.#dismissed.has(s.id) && !names.has(s.draft.name.toLowerCase()))
  }

  dismiss(id: string): void {
    if (this.#dismissed.has(id)) return
    this.#dismissed.add(id)
    writeAtomic(this.#path, JSON.stringify({ dismissed: [...this.#dismissed] }, null, 2))
  }
}
