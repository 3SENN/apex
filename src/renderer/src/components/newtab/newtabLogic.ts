/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure helpers for the new tab: the remembered floor toggle, the arc a
// chosen companion flies along from the floor to the composer (DS-77), and
// companion-coloured text that stays readable in both modes (DS-139).

import { accentTokens, contrastRatio, MIN_CONTRAST, parseHex, toHex, type ColorScheme } from '@shared/accent'
import { t } from '@shared/i18n/core'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

const FLOOR_KEY = 'apex.newtab.companionFloor'

/** The old per-window value of "Companions on New Tab": on unless it was turned off. */
export function parseFloorSetting(value: string | null | undefined): boolean {
  return value !== 'off'
}

/**
 * DS-75b: the floor toggle is the profile setting `companionFloor` now. A
 * window that still remembers "off" from before hands it over once (the
 * caller writes it to settings) and forgets it; null when there is nothing
 * to hand over or storage is blocked.
 */
export function takeLegacyFloorSetting(storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined = globalThis.localStorage): boolean | null {
  try {
    const value = storage?.getItem(FLOOR_KEY)
    if (value === null || value === undefined) return null
    storage?.removeItem(FLOOR_KEY)
    return parseFloorSetting(value) ? null : false
  } catch {
    return null
  }
}

/** Whether the floor shows: the profile setting, on until settings have loaded. */
export function floorShown(settings: { companionFloor?: boolean } | null | undefined): boolean {
  return settings?.companionFloor !== false
}

/** Flights take longer the farther they go, within Apex's 450–750 ms. */
export function flightDuration(distance: number): number {
  return Math.round(Math.max(450, Math.min(750, 450 + distance * 0.45)))
}

/**
 * Keyframes for an element the size of `to` (placed at the stage's top
 * left) that starts over `from`, scaled to it, and lands on `to` along a
 * raised arc. All boxes are in viewport px; `stage` maps them to the
 * element's frame.
 */
export function flightPath(from: Box, to: Box, stage: Box, steps = 16): { keyframes: Keyframe[]; duration: number } {
  const scale0 = to.height > 0 ? from.height / to.height : 1
  // Feet to feet: the bottom centres travel.
  const start = { x: from.left + from.width / 2 - stage.left, y: from.top + from.height - stage.top }
  const end = { x: to.left + to.width / 2 - stage.left, y: to.top + to.height - stage.top }
  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  const lift = 40 + distance * 0.35
  const control = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - lift }
  const keyframes: Keyframe[] = []
  for (let i = 0; i <= steps; i++) {
    const linear = i / steps
    // Quick off the floor, settling onto the field.
    const t = 1 - (1 - linear) * (1 - linear)
    const x = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * end.x
    const y = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * end.y
    const s = scale0 + (1 - scale0) * t
    keyframes.push({
      offset: linear,
      transform: `translate(${(x - (to.width * s) / 2).toFixed(2)}px, ${(y - to.height * s).toFixed(2)}px) scale(${s.toFixed(4)})`,
    })
  }
  return { keyframes, duration: flightDuration(distance) }
}

/** The raised surfaces companion-coloured text sits on (the switcher's segment); dark is a little lifted for margin. */
export const RAISED: Record<ColorScheme, string> = { light: '#ffffff', dark: '#34322f' }

/**
 * A companion colour as text on a raised surface: the readable accent for
 * the scheme, then lifted (dark) or deepened (light) until it reaches 4.5:1.
 */
export function nameColor(color: string, scheme: ColorScheme, surface = RAISED[scheme]): string {
  let text = accentTokens(color, scheme).accent
  const toward = scheme === 'dark' ? [255, 255, 255] : [0, 0, 0]
  for (let i = 0; i < 40 && contrastRatio(text, surface) < MIN_CONTRAST; i++) {
    const rgb = parseHex(text) ?? [128, 128, 128]
    text = toHex([0, 1, 2].map((k) => (rgb[k] as number) + ((toward[k] as number) - (rgb[k] as number)) * 0.08) as [number, number, number])
  }
  return text
}

// The start surface's local logic (DS-107 to DS-112): the ideas card's pages,
// the notifications inbox and the paged strip. Pure, so it is tested without
// a DOM. Ideas are suggestions built here from your skills,
// routines and tabs plus a fixed starter set; nothing comes from a feed.

export type IdeaGlyph = 'sparkles' | 'globe' | 'news' | 'mail' | 'plane' | 'scale' | 'chef' | 'tabs' | 'wand' | 'repeat' | 'book'

export interface Idea {
  id: string
  label: string
  /** The full request, shown in the hover preview and put in the composer (or sent). */
  prompt: string
  /** One-shot ideas send at once; the rest prefill the composer for you to finish. */
  oneShot: boolean
  glyph: IdeaGlyph
}

export interface IdeaPage {
  id: string
  title: string
  description: string
  /** Where "See all" goes; null hides it. */
  seeAll: { label: string; url: string } | null
  ideas: Idea[]
}

export const IDEAS_PER_PAGE = 4

const STARTERS: Idea[] = [
  { id: 'start:news', get label() { return t('tabs.newTabLogic.catchUpOnToday') }, get prompt() { return t('tabs.newTabLogic.giveMeAShort') }, oneShot: true, glyph: 'news' },
  { id: 'start:trip', get label() { return t('tabs.newTabLogic.planAWeekendAway') }, get prompt() { return t('tabs.newTabLogic.helpMePlanA') }, oneShot: false, glyph: 'plane' },
  { id: 'start:compare', get label() { return t('tabs.newTabLogic.compareTwoProducts') }, get prompt() { return t('tabs.newTabLogic.compareTheseTwoProducts') }, oneShot: false, glyph: 'scale' },
  { id: 'start:email', get label() { return t('tabs.newTabLogic.draftAFriendlyEmail') }, get prompt() { return t('tabs.newTabLogic.helpMeWriteA') }, oneShot: false, glyph: 'mail' },
  { id: 'start:recipe', get label() { return t('tabs.newTabLogic.findAQuickDinner') }, get prompt() { return t('tabs.newTabLogic.findAQuickDinner2') }, oneShot: false, glyph: 'chef' },
  { id: 'start:learn', get label() { return t('tabs.newTabLogic.learnSomethingNew') }, get prompt() { return t('tabs.newTabLogic.tellMeSomethingInteresting') }, oneShot: true, glyph: 'book' },
  { id: 'start:tabs', get label() { return t('tabs.newTabLogic.tidyUpMyTabs') }, get prompt() { return t('tabs.newTabLogic.lookThroughMyOpen') }, oneShot: true, glyph: 'tabs' },
  { id: 'start:briefing', get label() { return t('tabs.newTabLogic.setUpAMorning') }, get prompt() { return t('tabs.newTabLogic.everyWeekdayAt8') }, oneShot: false, glyph: 'repeat' },
]

export interface IdeaSources {
  companionName: string
  skills: ReadonlyArray<{ id: string; name: string; description: string }>
  routines: ReadonlyArray<{ id: string; name: string; prompt: string; enabled: boolean }>
  tabs: ReadonlyArray<{ id: string; title: string; url: string }>
  dismissed: ReadonlySet<string>
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function shortTitle(title: string, max = 48): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

/** The ideas card's pages, in order: starters, then your tabs, skills and routines. Empty pages are dropped. */
export function buildIdeaPages(sources: IdeaSources): IdeaPage[] {
  const keep = (ideas: Idea[]): Idea[] => ideas.filter((i) => !sources.dismissed.has(i.id))
  const pages: IdeaPage[] = []
  const starters = chunk(keep(STARTERS), IDEAS_PER_PAGE)
  starters.forEach((ideas, i) =>
    pages.push({
      id: `starters-${i}`,
      title: i === 0 ? t('tabs.newTabLogic.ideasToStartWith') : t('tabs.newTabLogic.moreToTry'),
      description: t('tabs.newTabLogic.aFewThingsCan', { companionName: sources.companionName }),
      seeAll: null,
      ideas,
    }),
  )

  const web = sources.tabs.filter((t) => /^https?:\/\//.test(t.url) && t.title.trim())
  const fromTabs = keep(
    web.slice(0, 3).map((tab): Idea => ({ id: `tab:${tab.url}`, label: t('tabs.newTabLogic.summarise', { value: shortTitle(tab.title, 36) }), prompt: t('tabs.newTabLogic.summariseInAFew', { url: tab.url }), oneShot: true, glyph: 'globe' })),
  )
  if (web.length >= 2) {
    const [a, b] = web
    fromTabs.push(...keep([{ id: `tabs:compare:${a!.url}|${b!.url}`, label: t('tabs.newTabLogic.compareTwoOfMy'), prompt: t('tabs.newTabLogic.compareAndAndTell', { url: a!.url, url2: b!.url }), oneShot: true, glyph: 'scale' }]))
  }
  if (fromTabs.length > 0) {
    pages.push({ id: 'tabs', title: t('tabs.newTabLogic.fromYourTabs'), description: t('tabs.newTabLogic.quickAsksAboutThe'), seeAll: null, ideas: fromTabs.slice(0, IDEAS_PER_PAGE) })
  }

  const skills = keep(sources.skills.map((s): Idea => ({ id: `skill:${s.id}`, label: `/${s.name}`, prompt: `/${s.name} `, oneShot: false, glyph: 'wand' })))
  if (skills.length > 0) {
    pages.push({ id: 'skills', title: t('tabs.newTabLogic.yourSkills'), description: t('tabs.newTabLogic.skillsYouTaughtYour'), seeAll: { label: t('tabs.newTabLogic.seeAllSkills'), url: 'apex://skills' }, ideas: skills.slice(0, IDEAS_PER_PAGE) })
  }

  const routines = keep(sources.routines.filter((r) => r.prompt.trim()).map((r): Idea => ({ id: `routine:${r.id}`, label: t('tabs.newTabLogic.runNow', { value: shortTitle(r.name, 30) }), prompt: r.prompt, oneShot: true, glyph: 'repeat' })))
  if (routines.length > 0) {
    pages.push({ id: 'routines', title: t('tabs.newTabLogic.yourRoutines'), description: t('tabs.newTabLogic.runOneOfYour'), seeAll: { label: t('tabs.newTabLogic.seeAllRoutines'), url: 'apex://routines' }, ideas: routines.slice(0, IDEAS_PER_PAGE) })
  }
  return pages
}

/** Keeps the page index in range as pages come and go. */
export function clampPage(index: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, index))
}

/** The paged strip's controls (DS-142): previous is disabled at the start, next at the end. */
export function pagerState(index: number, count: number): { canPrev: boolean; canNext: boolean } {
  const at = clampPage(index, count)
  return { canPrev: at > 0, canNext: at < count - 1 }
}

// ---- notifications inbox (DS-112) ----

export interface InboxItem {
  id: string
  kind: 'approval' | 'routine'
  title: string
  detail: string
  at: number
  unread: boolean
  /** The chat it opens, if any. */
  chatId: string | null
  status?: 'ok' | 'error' | 'needs-input' | 'stopped' | 'running'
}

export interface InboxSources {
  chats: ReadonlyArray<{ id: string; title: string; updatedAt: number; needsInput: boolean }>
  runs: ReadonlyArray<{ id: string; routineId: string; chatId: string | null; startedAt: number; finishedAt: number | null; status: InboxItem['status'] & string; read: boolean }>
  routineNames: ReadonlyMap<string, string>
}

const RUN_DETAIL: Record<string, string> = {
  get ok() { return t('tabs.newTabLogic.finished') },
  get error() { return t('tabs.newTabLogic.somethingWentWrong') },
  get 'needs-input'() { return t('tabs.newTabLogic.needsYou') },
  get stopped() { return t('tabs.newTabLogic.stopped') },
  get running() { return t('tabs.newTabLogic.runningNow') },
}

/** Pending approvals and routine results, newest first. Approvals always count as unread. */
export function buildInbox(sources: InboxSources, limit = 20): InboxItem[] {
  const items: InboxItem[] = []
  for (const chat of sources.chats) {
    if (!chat.needsInput) continue
    items.push({ id: `chat:${chat.id}`, kind: 'approval', title: chat.title || t('tabs.newTabLogic.untitledChat'), detail: t('tabs.newTabLogic.waitingForYourApproval'), at: chat.updatedAt, unread: true, chatId: chat.id })
  }
  for (const run of sources.runs) {
    if (run.status === 'running') continue
    items.push({
      id: `run:${run.id}`,
      kind: 'routine',
      title: sources.routineNames.get(run.routineId) ?? t('tabs.newTabLogic.aRoutine'),
      detail: RUN_DETAIL[run.status] ?? t('tabs.newTabLogic.finished'),
      at: run.finishedAt ?? run.startedAt,
      unread: !run.read,
      chatId: run.chatId,
      status: run.status,
    })
  }
  return items.sort((a, b) => b.at - a.at).slice(0, limit)
}

export function inboxUnread(items: readonly InboxItem[]): number {
  return items.filter((i) => i.unread).length
}

// ---- staged arrival (DS-111) ----

/** When each part of the start surface arrives, in ms after the page mounts. Reduce Motion shows everything at once. */
export const ARRIVAL_MS = { composer: 200, figure: 300, ideas: 850, inbox: 1050 } as const

export function arrivalDelays(reduced: boolean): Record<keyof typeof ARRIVAL_MS, number> {
  if (reduced) return { composer: 0, figure: 0, ideas: 0, inbox: 0 }
  return { ...ARRIVAL_MS }
}
