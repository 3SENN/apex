/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from './branding'
import { z } from 'zod'
import type { RoutineDraft } from './routines'
import { DESTINATIONS, type Destination } from './url'
import type { ShowcaseSlideId } from './onboarding'

// Your profile (ON-18): what you do and want, from the setup conversation (or
// its question cards), kept in userData/profile.json and yours to edit in
// Settings › You. Setup matches it to the browser (workspacePlan below): the
// sidebar rows you'll use, routines for the things you do every week, the
// skills that fit, the apps you named and the showcase slides worth showing,
// so nobody starts with what they don't need. Nothing applies without the
// review step. Companions read it through the About me memory note.

export const INTERESTS = ['research', 'shopping', 'writing', 'meetings', 'routines', 'travel', 'coding', 'data', 'design', 'projects', 'sales', 'finance', 'learning'] as const
export type Interest = (typeof INTERESTS)[number]

/** How hands-on you want to be: the basics shown, a mix, or out of the way (⌘K and shortcuts). */
export const TECH_LEVELS = ['simple', 'mixed', 'technical'] as const
export type TechLevel = (typeof TECH_LEVELS)[number]

export const REPLY_STYLES = ['short', 'balanced', 'thorough'] as const
export type ReplyStyle = (typeof REPLY_STYLES)[number]

/** Something you do on a rhythm; setup offers it as a routine. */
export interface ProfileHabit {
  /** What it is, in a few words: "Plan the week". */
  what: string
  /** What the companion does each time, written as a message to it. */
  prompt: string
  /** 0 is Sunday; empty is every day. */
  days: number[]
  /** HH:MM, local time. */
  time: string
  /** A built-in skill it runs, by name, when one fits. */
  skill: string | null
}

export interface UserProfile {
  version: 1
  updatedAt: number
  name: string | null
  /** What you do, in your words. */
  work: string | null
  techLevel: TechLevel | null
  interests: Interest[]
  /** What you want help with, in short phrases. */
  goals: string[]
  habits: ProfileHabit[]
  /** Apps you use, as you named them; the ones Apex can connect are matched in the plan. */
  apps: string[]
  replyStyle: ReplyStyle | null
}

export const PROFILE_LIMITS = { text: 300, goals: 6, habits: 6, apps: 12, phrase: 80 } as const

const phrase = z.string().trim().min(1).max(PROFILE_LIMITS.phrase)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const habitSchema = z
  .object({
    what: phrase,
    prompt: z.string().trim().min(1).max(PROFILE_LIMITS.text * 2),
    days: z.array(z.number().int().min(0).max(6)).max(7),
    time,
    skill: z.string().max(40).nullable(),
  })
  .strict()

export const profileSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.number().finite(),
    name: z.string().trim().max(PROFILE_LIMITS.phrase).nullable(),
    work: z.string().trim().max(PROFILE_LIMITS.text).nullable(),
    techLevel: z.enum(TECH_LEVELS).nullable(),
    interests: z.array(z.enum(INTERESTS)).max(INTERESTS.length),
    goals: z.array(phrase).max(PROFILE_LIMITS.goals),
    habits: z.array(habitSchema).max(PROFILE_LIMITS.habits),
    apps: z.array(phrase).max(PROFILE_LIMITS.apps),
    replyStyle: z.enum(REPLY_STYLES).nullable(),
  })
  .strict()

export function emptyProfile(now: number): UserProfile {
  return { version: 1, updatedAt: now, name: null, work: null, techLevel: null, interests: [], goals: [], habits: [], apps: [], replyStyle: null }
}

/** True when the profile says nothing that would change the workspace. */
export function profileIsEmpty(p: UserProfile): boolean {
  return p.techLevel === null && p.interests.length === 0 && p.habits.length === 0 && p.apps.length === 0 && p.goals.length === 0 && !p.work
}

// ── The setup conversation and the review step (main: src/main/userProfile.ts) ──

export interface InterviewLine {
  from: 'companion' | 'you'
  text: string
}

export interface InterviewTurn {
  /** What the companion says next. */
  say: string
  /** Quick replies, each starting with an emoji: up to four, or six when several can apply. */
  chips: string[]
  /** Several replies can apply (your apps, what you want help with): tap them all, then send. */
  multi: boolean
  /** It has what it needs (or you said you're done): setup moves on. */
  done: boolean
}

/** Questions before the companion wraps up, whatever it still wonders. */
export const INTERVIEW_MAX_QUESTIONS = 7
export const INTERVIEW_LIMITS = { lines: 24, text: 600 } as const

/** What the review step kept: the sidebar rows as set, and the routines (by plan id) to make. */
export interface WorkspaceChoice {
  destinations: Partial<Record<Destination, boolean>>
  routines: string[]
}

// ── From the question cards (no engine for the conversation) ──

const USE_CASE_INTERESTS: Readonly<Record<string, Interest>> = {
  research: 'research',
  shopping: 'shopping',
  writing: 'writing',
  meetings: 'meetings',
  routines: 'routines',
  travel: 'travel',
  coding: 'coding',
  data: 'data',
  design: 'design',
  projects: 'projects',
}

/** A profile from the setup cards' answers, for when the conversation couldn't run. */
export function profileFromAnswers(answers: Readonly<Record<string, string | string[] | null>>, now: number): UserProfile {
  const text = (id: string): string | null => {
    const v = answers[id]
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, PROFILE_LIMITS.text) : null
  }
  const picks = Array.isArray(answers['use-cases']) ? (answers['use-cases'] as string[]) : []
  const interests = [...new Set(picks.map((p) => USE_CASE_INTERESTS[p]).filter((i): i is Interest => i !== undefined))]
  const other = picks.filter((p) => !USE_CASE_INTERESTS[p]).map((p) => p.trim().slice(0, PROFILE_LIMITS.phrase)).filter(Boolean)
  const level = text('hands-on')
  const style = text('reply-style')
  return {
    ...emptyProfile(now),
    name: text('call-you')?.slice(0, PROFILE_LIMITS.phrase) ?? null,
    work: text('work'),
    techLevel: (TECH_LEVELS as readonly string[]).includes(level ?? '') ? (level as TechLevel) : null,
    interests,
    goals: other.slice(0, PROFILE_LIMITS.goals),
    replyStyle: (REPLY_STYLES as readonly string[]).includes(style ?? '') ? (style as ReplyStyle) : null,
  }
}

// ── The About me note companions read ──

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

/** "Mondays at 09:00", "every day at 18:00". */
export function habitWhen(h: Pick<ProfileHabit, 'days' | 'time'>): string {
  const days = [...new Set(h.days)].sort()
  const which = days.length === 0 || days.length === 7 ? 'every day' : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'weekdays' : days.map((d) => DAY_NAMES[d]).join(', ')
  return `${which} at ${h.time}`
}

/** The About me memory note (SETUP_MEMORY_PATH): what the profile says, for companions to read; edit or delete freely. */
export function profileMemoryNote(p: UserProfile): string | null {
  const lines: string[] = []
  if (p.name) lines.push(`- Name: ${p.name}`)
  if (p.work) lines.push(`- Works on: ${p.work}`)
  if (p.techLevel) lines.push(`- Hands-on: ${{ simple: 'keep things simple, explain steps', mixed: 'a mix', technical: 'technical, skip the basics' }[p.techLevel]}`)
  if (p.interests.length) lines.push(`- Wants help with: ${p.interests.join(', ')}`)
  for (const g of p.goals) lines.push(`- Goal: ${g}`)
  for (const h of p.habits) lines.push(`- Every so often: ${h.what} (${habitWhen(h)})`)
  if (p.apps.length) lines.push(`- Uses: ${p.apps.join(', ')}`)
  if (p.replyStyle) lines.push(`- Prefers answers that are: ${{ short: 'short and to the point', balanced: 'a bit detailed', thorough: 'thorough, with reasons' }[p.replyStyle]}`)
  if (lines.length === 0) return null
  return ['# About me', '', `From ${BRAND_NAME} setup. Edit or delete anything here; companions read this note.`, '', ...lines, ''].join('\n')
}

// ── Matching: the profile to the workspace ──

export interface PlanDirectoryEntry {
  id: string
  name: string
  site: string
  category: string
}

export interface PlanContext {
  /** The connector directory (src/main/connectors/directory.json). */
  directory: readonly PlanDirectoryEntry[]
  /** Built-in skill names (weekly-review, meeting-prep…). */
  skills: readonly string[]
  /** The person's own companion, for the routines. */
  companionId?: string
  timeZone?: string | null
}

export interface PlannedRoutine {
  /** Stable within a plan: the review step's toggle key. */
  id: string
  /** Its skillId is the built-in skill's name; saving it looks up the id. */
  draft: RoutineDraft
  /** The habit it comes from, for the review card. */
  habit: ProfileHabit
}

export interface WorkspacePlan {
  /** Sidebar rows (SH-07's destinations). */
  destinations: Record<Destination, boolean>
  /** Showcase slides worth showing; empty skips the showcase. */
  showcase: ShowcaseSlideId[]
  /** Tips and guides up front (the getting-started guides row, first-week tips). */
  guided: boolean
  routines: PlannedRoutine[]
  /** Built-in skills that fit, by name, best first. */
  skills: string[]
  /** Directory connector ids: the apps you named, else (a few) for what you do. */
  connectors: string[]
}

const INTEREST_SKILLS: Readonly<Partial<Record<Interest, readonly string[]>>> = {
  research: ['research-brief', 'reading-digest'],
  shopping: ['compare-options', 'price-watch'],
  writing: ['document-outline'],
  meetings: ['meeting-prep'],
  routines: ['weekly-review'],
  travel: ['trip-plan'],
  design: ['brand-kit'],
  projects: ['weekly-review', 'meeting-prep'],
  learning: ['reading-digest', 'page-summary'],
}

/** For what you do, when you named no app: at most a few, never for a simple setup. */
const INTEREST_CONNECTORS: Readonly<Partial<Record<Interest, readonly string[]>>> = {
  coding: ['github', 'linear', 'vercel'],
  data: ['supabase', 'bigquery'],
  design: ['figma', 'canva'],
  projects: ['notion', 'asana', 'atlassian'],
  sales: ['intercom'],
  finance: ['stripe', 'paypal'],
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The directory entries for the apps you named: by name, id or site ("jira" finds Atlassian through its site's products). */
export function matchApps(apps: readonly string[], directory: readonly PlanDirectoryEntry[]): string[] {
  const out: string[] = []
  for (const app of apps) {
    const a = norm(app)
    if (a.length < 2) continue
    const hit = directory.find((e) => {
      const names = [e.id, e.name, e.site.split('.')[0] ?? ''].map(norm)
      return names.some((n) => n === a || (a.length >= 4 && (n.includes(a) || a.includes(n))))
    }) ?? (a === 'jira' || a === 'confluence' ? directory.find((e) => e.id === 'atlassian') : undefined)
    if (hit && !out.includes(hit.id)) out.push(hit.id)
  }
  return out
}

/** A habit as a routine draft: on its days and time, in your own chats, with its skill when there is one. */
export function habitRoutine(h: ProfileHabit, ctx: Pick<PlanContext, 'skills' | 'companionId' | 'timeZone'>): RoutineDraft {
  return {
    name: h.what,
    prompt: h.prompt,
    schedule: { kind: 'daily', time: h.time, days: [...new Set(h.days)].sort() },
    ...(ctx.companionId ? { companionId: ctx.companionId } : {}),
    timeZone: ctx.timeZone ?? null,
    ...(h.skill && ctx.skills.includes(h.skill) ? { skillId: h.skill } : {}),
  }
}

/**
 * The workspace a profile asks for. Chats are always there; every other row,
 * routine, skill and app has to come from something you said. Technical
 * setups keep the sidebar to what they use (⌘K reaches the rest), simple ones
 * get the guides. A profile that says nothing keeps today's defaults.
 */
export function workspacePlan(p: UserProfile, ctx: PlanContext, defaults: Readonly<Record<Destination, boolean>>): WorkspacePlan {
  const has = (i: Interest): boolean => p.interests.includes(i)
  const level = p.techLevel ?? 'mixed'
  const skills = [...new Set(p.interests.flatMap((i) => INTEREST_SKILLS[i] ?? []))].filter((s) => ctx.skills.includes(s)).slice(0, 4)
  const named = matchApps(p.apps, ctx.directory)
  const known = new Set(ctx.directory.map((e) => e.id))
  const suggested = named.length > 0 || level === 'simple' ? [] : [...new Set(p.interests.flatMap((i) => INTEREST_CONNECTORS[i] ?? []))].filter((id) => known.has(id)).slice(0, 3)
  const connectors = [...named, ...suggested]
  const routines = p.habits.slice(0, 3).map((habit, i) => ({ id: `habit-${i}`, draft: habitRoutine(habit, ctx), habit }))

  if (profileIsEmpty(p)) {
    return { destinations: { ...defaults }, showcase: ['tabs', 'meetings', 'documents', 'research', 'routines', 'memory'], guided: false, routines, skills, connectors }
  }

  const destinations = Object.fromEntries(DESTINATIONS.map((d) => [d, false])) as Record<Destination, boolean>
  destinations.chats = true
  destinations.routines = routines.length > 0 || has('routines')
  destinations.meetings = has('meetings')
  if (level !== 'technical') {
    // Connectors stays in More: setup connects the apps it offers, and companions already work in open sites.
    destinations.skills = level === 'mixed' && skills.length > 0
    destinations.workspace = level === 'mixed' && (has('writing') || has('research') || has('projects'))
    destinations.guides = level === 'simple'
  }

  const slides: ShowcaseSlideId[] = []
  if (level !== 'technical') {
    slides.push('tabs')
    if (has('meetings')) slides.push('meetings')
    if (has('writing') || has('projects')) slides.push('documents')
    if (has('research') || has('learning')) slides.push('research')
    if (routines.length > 0 || has('routines')) slides.push('routines')
    slides.push('memory')
  }
  return { destinations, showcase: slides.slice(0, 4), guided: level === 'simple', routines, skills, connectors }
}
