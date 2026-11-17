/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Activity memory and the timeline for every profile (
// ST-49 to ST-52). Each profile keeps
// its own store and visits log under its data folder; the services act on
// the profile of the focused window. Capture runs from TabManager's
// page-visited and page-left events through the gate in gate.ts, page text
// is read after 20 s on the page, and an hourly pass turns captures into a
// dated note in the active companion's memory.
import { join } from 'node:path'
import {
  activityStatusAt,
  clearRange,
  localDayBounds,
  localDayKey,
  nextLocalMidnight,
  retentionCutoffs,
  retentionShortened,
  type ActivityItem,
  type ActivityService,
  type ActivitySettings,
  type ActivityStatus,
} from '@shared/activity'
import { isExcluded, normalizeSite } from '@shared/exclusions'
import { isFlagOn } from '@shared/flags'
import type { Owner } from '@shared/services'
import type { PageLeft, PageVisit, TimelineService } from '@shared/timeline'
import type { CompleteInput } from '../agent/hostApi'
import { log } from '../log'
import { InsightsCache } from '../timeline/insights'
import { groupSessions, siteInsights, summarizeDays, type Visit } from '../timeline/sessions'
import { VisitsLog } from '../timeline/visits'
import { CAPTURE_DWELL_MS, CAPTURE_TEXT_MAX, captureGate } from './gate'
import { activityNotePath, appendNote, NOTES_SYSTEM, notesPrompt } from './notes'
import { ActivityStore, EXCLUDED_CHATS_MAX, CAPTURE_EXCERPT } from './store'
import { mainT } from '../i18n/mainT'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** How often the manager wakes for hourly notes and daily cleanup. */
const TICK_MS = 10 * 60_000

/** What capture needs from the tab that showed a page; the window feature builds it from the tab, PageBridge and the capture masker. */
export interface PageAccess {
  /** The tab's current address, or null once it closed. */
  url(): string | null
  title(): string
  text(): Promise<string>
  /** True when the page has password or payment fields, or when that can't be told. */
  guarded(): Promise<boolean>
  /** A downscaled JPEG with guarded fields masked, or null. */
  thumbnail(): Promise<Buffer | null>
}

export interface ActivityManagerDeps {
  dataDirFor(profileId: string): string
  currentProfile(): string
  flags(): Record<string, string>
  complete(input: CompleteInput): Promise<string>
  /** The companion whose memory gets the hourly notes; null when there is none. */
  activeCompanion(): string | null
  memory: { read(path: string, owner: Owner): string; write(path: string, text: string, owner: Owner, author: 'agent' | 'you'): void } | null
  broadcast(status: ActivityStatus): void
  now?(): number
}

interface Profile {
  store: ActivityStore
  visits: VisitsLog
  insights: InsightsCache
}

interface Pending {
  profileId: string
  url: string
  visitId: number | null
  itemId: string | null
  timer: ReturnType<typeof setTimeout> | null
}

export class ActivityManager {
  readonly #deps: ActivityManagerDeps
  readonly #now: () => number
  readonly #profiles = new Map<string, Profile>()
  readonly #pending = new Map<string, Pending>()
  #edgeTimer: ReturnType<typeof setTimeout> | null = null
  #tick: ReturnType<typeof setInterval> | null = null
  #noting = false
  #lastStatus = ''

  constructor(deps: ActivityManagerDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  profile(id: string): Profile {
    let p = this.#profiles.get(id)
    if (!p) {
      const dir = join(this.#deps.dataDirFor(id), 'activity')
      const store = new ActivityStore(dir)
      p = { store, visits: new VisitsLog(join(dir, 'visits.sqlite')), insights: new InsightsCache(join(dir, 'insights.json'), this.#deps.complete, this.#now) }
      this.#profiles.set(id, p)
    }
    return p
  }

  #current(): Profile {
    return this.profile(this.#deps.currentProfile())
  }

  status(profileId = this.#deps.currentProfile()): ActivityStatus {
    return activityStatusAt(this.profile(profileId).store.settings(), this.#now())
  }

  // ── timers ──

  start(): void {
    this.#tick ??= setInterval(() => void this.#onTick(), TICK_MS)
    this.#tick.unref?.()
    this.#announce()
    void this.#onTick()
  }

  /** Broadcasts the current status when it changed, and wakes again at its next edge. */
  #announce(force = false): void {
    const status = this.status()
    const key = JSON.stringify(status)
    if (force || key !== this.#lastStatus) {
      this.#lastStatus = key
      this.#deps.broadcast(status)
    }
    if (this.#edgeTimer) clearTimeout(this.#edgeTimer)
    // Re-check at least every half hour, so a changed clock or time zone is caught.
    const wait = status.nextChange === null ? 30 * 60_000 : Math.min(Math.max(1000, status.nextChange - this.#now() + 250), 30 * 60_000)
    this.#edgeTimer = setTimeout(() => this.#announce(), wait)
    this.#edgeTimer.unref?.()
  }

  async #onTick(): Promise<void> {
    this.#announce()
    for (const [id, p] of this.#profiles) {
      try {
        const state = p.store.state()
        if (state.lastCleanup === null || this.#now() - state.lastCleanup >= DAY_MS) this.cleanup(id)
      } catch (err) {
        log.warn('activity', 'Retention cleanup failed', { error: errorText(err) })
      }
    }
    await this.writeHourlyNotes()
  }

  dispose(): void {
    if (this.#tick) clearInterval(this.#tick)
    if (this.#edgeTimer) clearTimeout(this.#edgeTimer)
    this.#tick = null
    this.#edgeTimer = null
    for (const pending of this.#pending.values()) if (pending.timer) clearTimeout(pending.timer)
    this.#pending.clear()
    for (const p of this.#profiles.values()) {
      p.store.close()
      p.visits.close()
    }
    this.#profiles.clear()
  }

  // ── capture ──

  onVisit(visit: PageVisit, page: PageAccess): void {
    this.#settle(visit.tabId)
    if (visit.privateWindow) return
    try {
      const p = this.profile(visit.profileId)
      // The timeline is your browsing: pages the agent drives stay out of it, like private windows.
      const visitId = visit.agentControlled ? null : p.visits.record(visit)
      const settings = p.store.settings()
      const gate = captureGate({ status: activityStatusAt(settings, this.#now()), url: visit.url, privateWindow: visit.privateWindow, agentControlled: visit.agentControlled, excluded: settings.excluded })
      const itemId = gate.ok ? p.store.addVisit(visit) : null
      const pending: Pending = { profileId: visit.profileId, url: visit.url, visitId, itemId, timer: null }
      if (itemId) {
        pending.timer = setTimeout(() => void this.#capturePage(visit.tabId, pending, page), CAPTURE_DWELL_MS)
        pending.timer.unref?.()
      }
      this.#pending.set(visit.tabId, pending)
    } catch (err) {
      log.warn('activity', 'Could not record a visit', { error: errorText(err) })
    }
  }

  /** The visited page's title, as soon as it arrives: the timeline and search show it before the 20 s capture. */
  onTitle(tabId: string, url: string, title: string): void {
    const pending = this.#pending.get(tabId)
    if (!pending || pending.url !== url || !title) return
    try {
      const p = this.profile(pending.profileId)
      if (pending.itemId) p.store.setTitle(pending.itemId, title)
      if (pending.visitId !== null) p.visits.setTitle(pending.visitId, title)
    } catch (err) {
      log.warn('activity', 'Could not update a visit title', { error: errorText(err) })
    }
  }

  onLeft(left: PageLeft): void {
    const pending = this.#pending.get(left.tabId)
    if (!pending || pending.url !== left.url) return
    this.#settle(left.tabId)
    try {
      const p = this.profile(pending.profileId)
      if (pending.visitId !== null) p.visits.setDwell(pending.visitId, left.dwellMs)
      if (pending.itemId !== null) p.store.setDwell(pending.itemId, left.dwellMs)
    } catch (err) {
      log.warn('activity', 'Could not record time on a page', { error: errorText(err) })
    }
  }

  #settle(tabId: string): void {
    const pending = this.#pending.get(tabId)
    if (pending?.timer) clearTimeout(pending.timer)
    this.#pending.delete(tabId)
  }

  /** After 20 s on the page: its text and, with the flag on, a thumbnail. Every gate is checked again first. */
  async #capturePage(tabId: string, pending: Pending, page: PageAccess): Promise<void> {
    pending.timer = null
    if (this.#pending.get(tabId) !== pending || page.url() !== pending.url) return
    try {
      const p = this.profile(pending.profileId)
      const settings = p.store.settings()
      const base = { status: activityStatusAt(settings, this.#now()), url: pending.url, privateWindow: false, agentControlled: false, excluded: settings.excluded }
      if (!captureGate(base).ok) return
      const guarded = await page.guarded()
      if (!captureGate({ ...base, guarded }).ok || page.url() !== pending.url) return
      const title = page.title()
      if (pending.itemId) p.store.setTitle(pending.itemId, title)
      if (pending.visitId !== null) p.visits.setTitle(pending.visitId, title)
      const text = (await page.text()).replace(/\s+\n/g, '\n').trim().slice(0, CAPTURE_TEXT_MAX)
      const at = this.#now()
      if (text && page.url() === pending.url) p.store.addCapture({ url: pending.url, title, at, text })
      if (isFlagOn(this.#deps.flags(), 'activity-screenshots')) {
        const jpeg = await page.thumbnail()
        if (jpeg && page.url() === pending.url) p.store.addScreenshot({ url: pending.url, title, at, jpeg })
      }
    } catch (err) {
      // A page that navigated, closed or didn't answer in time is simply not captured.
      log.debug('activity', 'Page capture skipped', { error: errorText(err) })
    }
  }

  // ── upkeep ──

  /** Applies retention to one profile now; returns how many items went. */
  cleanup(profileId = this.#deps.currentProfile()): number {
    const p = this.profile(profileId)
    const deleted = p.store.cleanup(retentionCutoffs(p.store.settings().retention, this.#now()))
    p.store.saveState({ lastCleanup: this.#now() })
    if (deleted > 0) log.info('activity', 'Retention cleanup', { deleted })
    return deleted
  }

  /** Once an hour per profile: a dated note of what was captured, in the active companion's memory. */
  async writeHourlyNotes(): Promise<number> {
    if (this.#noting || !this.#deps.memory) return 0
    this.#noting = true
    let written = 0
    try {
      for (const [id, p] of this.#profiles) {
        const settings = p.store.settings()
        if (!settings.enabled) continue
        const now = this.#now()
        const through = p.store.state().notesThrough
        if (through === null) {
          p.store.saveState({ notesThrough: now })
          continue
        }
        if (now - through < HOUR_MS) continue
        const companionId = this.#deps.activeCompanion()
        const items = p.store.between(through, now, ['visit', 'capture']).filter((i) => i.url && !isExcluded(i.url, settings.excluded))
        if (items.length === 0 || !companionId) {
          p.store.saveState({ notesThrough: now })
          continue
        }
        try {
          const note = (await this.#deps.complete({ companionId, system: NOTES_SYSTEM, prompt: notesPrompt(items), maxTokens: 700, kind: 'activity' })).trim()
          p.store.saveState({ notesThrough: now })
          if (!note) continue
          const path = activityNotePath(now)
          let existing = ''
          try {
            existing = this.#deps.memory.read(path, companionId)
          } catch {
            existing = ''
          }
          this.#deps.memory.write(path, appendNote(existing, through, now, note), companionId, 'agent')
          p.store.addNote({ at: now, title: mainT('core.mainManager.notes', { value: localDayKey(now) }), text: note })
          written++
        } catch (err) {
          // Tried again at the next tick; a provider limit just delays the note.
          log.warn('activity', 'Hourly activity note failed', { profile: id, error: errorText(err) })
        }
      }
    } finally {
      this.#noting = false
    }
    return written
  }

  // ── CH-21: the per-chat switch ──

  /** Kept in the profile's state.json, so a chat's choice survives a restart. */
  chatIncluded(chatId: string): boolean {
    return !this.#current().store.state().excludedChats.includes(chatId)
  }

  includeInChat(chatId: string, included: boolean): boolean {
    const store = this.#current().store
    const list = store.state().excludedChats.filter((id) => id !== chatId)
    if (!included) list.push(chatId)
    store.saveState({ excludedChats: list.slice(-EXCLUDED_CHATS_MAX) })
    return included
  }

  /** Whether search_activity may answer this chat: activity memory on for this profile and the chat's switch on. */
  offeredTo(chatId: string): boolean {
    return this.#current().store.settings().enabled && this.chatIncluded(chatId)
  }

  // ── search for the agent ──

  search(q: { query: string; from?: number; to?: number; limit?: number }): ActivityItem[] {
    const p = this.#current()
    const settings = p.store.settings()
    if (!settings.enabled) return []
    const { items } = p.store.items({ query: q.query, from: q.from, to: q.to, limit: Math.min(q.limit ?? 20, 50) }, CAPTURE_EXCERPT)
    // Exclusions apply to what is already stored too: a site excluded later stays hidden.
    return items.filter((i) => i.kind !== 'screenshot' && (!i.url || !isExcluded(i.url, settings.excluded)))
  }

  // ── services ──

  service(): ActivityService {
    const update = (patch: Partial<ActivitySettings>): ActivitySettings => {
      const p = this.#current()
      const before = p.store.settings()
      const next: ActivitySettings = { ...before, ...patch }
      if (patch.excluded) {
        const sites = [...new Set(patch.excluded.sites.map((s) => normalizeSite(s)).filter((s): s is string => s !== null))]
        next.excluded = { categories: [...new Set(patch.excluded.categories)], sites }
      }
      if (patch.schedule) next.schedule = { ...patch.schedule, days: [...new Set(patch.schedule.days)].sort((a, b) => a - b) }
      // Turning it on starts the hourly notes from now, never from older captures.
      if (next.enabled && !before.enabled) p.store.saveState({ notesThrough: this.#now() })
      const saved = p.store.saveSettings(next)
      if (retentionShortened(before.retention, saved.retention)) this.cleanup()
      this.#announce()
      return saved
    }
    const setTiming = (patch: Partial<Pick<ActivitySettings, 'pausedUntil' | 'override'>>): ActivityStatus => {
      const p = this.#current()
      p.store.saveSettings({ ...p.store.settings(), ...patch })
      this.#announce()
      return this.status()
    }
    return {
      status: () => this.status(),
      settings: () => this.#current().store.settings(),
      update,
      pause: (until) => {
        const now = this.#now()
        const end = until === 'today' ? nextLocalMidnight(now) : until
        if (end <= now) throw new Error('Choose a time in the future.')
        return setTiming({ pausedUntil: end })
      },
      resume: () => {
        const current = this.#current().store.settings().override
        return setTiming({ pausedUntil: null, override: current.kind === 'off-until' ? { kind: 'none' } : current })
      },
      override: (o) => {
        const now = this.#now()
        if (o.kind === 'none') return setTiming({ override: { kind: 'none' } })
        if (o.kind === 'off-until-tomorrow') return setTiming({ override: { kind: 'off-until', until: nextLocalMidnight(now) } })
        if (o.until <= now) throw new Error('Choose a time in the future.')
        // Capturing until a time also ends a pause.
        return setTiming({ override: { kind: 'on-until', until: o.until }, pausedUntil: null })
      },
      items: (q) => {
        const p = this.#current()
        return p.store.items(q)
      },
      remove: (ids) => this.#current().store.remove(ids),
      clear: (range) => {
        const span = clearRange(range, this.#now())
        const deleted = this.#current().store.clear(span.from, span.to)
        log.info('activity', 'Cleared activity memory', { range, deleted })
        return { deleted, from: span.from, to: span.to }
      },
      chatIncluded: (chatId) => this.chatIncluded(chatId),
      includeInChat: (chatId, included) => this.includeInChat(chatId, included),
    }
  }

  /** History removed a page or was cleared: the visits logs follow, in every profile. */
  historyRemoved(url: string | null): void {
    const ids = new Set([this.#deps.currentProfile(), ...this.#profiles.keys()])
    for (const id of ids) {
      try {
        const visits = this.profile(id).visits
        if (url === null) visits.clear()
        else visits.removeUrl(url)
      } catch (err) {
        log.warn('activity', 'Could not prune the visits log', { error: errorText(err) })
      }
    }
  }

  timeline(): TimelineService {
    const visible = (p: Profile, from: number, to: number): Visit[] => {
      const excluded = p.store.settings().excluded
      return p.visits.range(from, to).filter((v) => !isExcluded(v.url, excluded))
    }
    return {
      days: (range) => summarizeDays(visible(this.#current(), range.from, range.to)),
      sessions: (day) => {
        const p = this.#current()
        const { from, to } = localDayBounds(day)
        const settings = p.store.settings()
        const sessions = groupSessions(visible(p, from, to - 1))
        const notes = p.store.items({ from, to: to - 1, kind: 'note', limit: 48 }).items
        const shots = p.store.items({ from, to: to - 1, kind: 'screenshot', limit: 200 }).items.filter((s) => s.url && s.media && !isExcluded(s.url, settings.excluded))
        return sessions.map((s) => {
          // An hourly note covers the hour before it was written; take one that overlaps the session.
          const note = notes.find((n) => n.at >= s.start && n.at <= s.end + HOUR_MS + TICK_MS) ?? null
          const thumbnails = shots
            .filter((t) => t.at >= s.start && t.at <= s.end + CAPTURE_DWELL_MS)
            .slice(0, 12)
            .reverse()
            .map((t) => ({ at: t.at, url: t.url as string, media: t.media as string }))
          return { ...s, note: note?.text?.slice(0, 600) ?? null, ...(thumbnails.length > 0 ? { thumbnails } : {}) }
        })
      },
      sites: (q) => siteInsights(visible(this.#current(), q.from, q.to), { sort: q.sort, query: q.query }),
      insights: async (range) => {
        const p = this.#current()
        const settings = p.store.settings()
        if (!settings.proactive.insights) return []
        const notes = p.store.items({ from: range.from, to: range.to, kind: 'note', limit: 200 }).items
        return p.insights.insights({ enabled: true, range, notes, sites: siteInsights(visible(p, range.from, range.to)), companionId: this.#deps.activeCompanion() ?? undefined })
      },
      dismissInsight: (id) => this.#current().insights.dismiss(id),
    }
  }

  /** Bytes on disk in every loaded profile, for Settings › Your data. */
  size(): number {
    return [...this.#profiles.values()].reduce((n, p) => n + p.store.size(), 0)
  }

  clearAll(): number {
    return this.#current().store.clear(null, this.#now())
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
