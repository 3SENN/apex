/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { RoutineDraft } from '@shared/routines'
import { DESTINATIONS, type Destination } from '@shared/url'
import {
  INTERESTS,
  INTERVIEW_LIMITS,
  INTERVIEW_MAX_QUESTIONS,
  PROFILE_LIMITS,
  REPLY_STYLES,
  TECH_LEVELS,
  habitSchema,
  profileSchema,
  workspacePlan,
  type InterviewLine,
  type InterviewTurn,
  type PlanContext,
  type ProfileHabit,
  type UserProfile,
  type WorkspaceChoice,
  type WorkspacePlan,
} from '@shared/userProfile'
import type { QuickModel } from './agent/quick'
import { log } from './log'
import { setupPicks } from './decisions/uses' // DC-11
import { writeAtomic } from './settings'

// Your profile (ON-18): its store (userData/profile.json, schema-checked; an
// unreadable file is set aside as if there were none), the setup
// conversation's turns and the profile it turns into, both on the person's
// own engine through QuickModel, and the workspace plan applied after the
// review step. Without an engine the conversation doesn't start and setup
// shows its question cards instead; a failed turn ends it the same way.

export const PROFILE_FILE = 'profile.json'

export class UserProfileStore {
  readonly #path: string
  #profile: UserProfile | null = null

  constructor(dataDir: string) {
    this.#path = join(dataDir, PROFILE_FILE)
    try {
      const parsed = profileSchema.safeParse(JSON.parse(readFileSync(this.#path, 'utf8')))
      if (parsed.success) this.#profile = parsed.data
      else log.warn('profile', 'Your profile couldn’t be read; it starts empty')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('profile', 'Your profile couldn’t be read; it starts empty')
    }
  }

  get(): UserProfile | null {
    return this.#profile
  }

  set(profile: UserProfile): UserProfile {
    const checked = profileSchema.parse(profile)
    this.#profile = checked
    writeAtomic(this.#path, `${JSON.stringify(checked, null, 2)}\n`)
    return checked
  }

  clear(): void {
    this.#profile = null
    rmSync(this.#path, { force: true })
  }
}

// ── The conversation ──

const turnSchema = z.object({
  say: z.string().min(1).max(400),
  chips: z.array(z.string().min(1).max(40)).max(6),
  multi: z.boolean(),
  done: z.boolean(),
})

export function interviewSystem(companion: string, language: 'en' | 'nl'): string {
  return [
    `You are ${companion}, the person's new companion in ${BRAND_NAME}, a web browser with companions who help in its tabs. Setup is almost done; this is a short, warm chat to get to know them so ${BRAND_NAME} can set up their workspace: which sidebar rows they see, routines for what they do every week, the skills and apps that fit.`,
    'Find out, one at a time and only what they haven’t told you yet:',
    '1. What they do (work, study, a business, a hobby).',
    '2. What they’d like a hand with.',
    '3. What they do on a rhythm, and when (a Monday plan, a Friday invoice, a morning news read).',
    '4. Which apps they use most (Notion, Gmail, GitHub, Figma…).',
    '5. How hands-on they want to be: keep it simple, a mix, or technical and out of the way.',
    'Rules: one short question per turn, two sentences at most, in plain words. Pick up on what they said; follow up once when it helps, then move on. No flattery, no lists, no repeating their words back. Never ask for anything sensitive (passwords, money, health, addresses).',
    'Give quick replies they can tap instead of typing: each starts with one fitting emoji and is a few words ("🎨 Design", "📅 Planning my week"). Give 3 or 4, or up to 6 when several can apply at once (which apps they use, what they want help with); then set multi to true. Make them the likeliest answers for this person, from what they said so far.',
    `After ${INTERVIEW_MAX_QUESTIONS} questions, or when they want to stop, or once you know enough, set done to true and say one short line that you'll set things up now (no question).`,
    `Write in ${language === 'nl' ? 'Dutch' : 'English'}.`,
    'Reply as JSON: { "say": string, "chips": string[], "multi": boolean, "done": boolean }.',
  ].join('\n')
}

function transcriptText(lines: readonly InterviewLine[], companion: string): string {
  return lines.map((l) => `${l.from === 'companion' ? companion : 'Person'}: ${l.text.slice(0, INTERVIEW_LIMITS.text)}`).join('\n')
}

export interface InterviewDeps {
  quick: Pick<QuickModel, 'ready' | 'json'>
  companionName(): string
  language(): 'en' | 'nl'
  companionId?(): string | undefined
}

/** The companion's next line, or null when no engine can run it (setup shows the question cards). */
export async function interviewTurn(deps: InterviewDeps, lines: readonly InterviewLine[]): Promise<InterviewTurn | null> {
  if (!(await deps.quick.ready()).ok) return null
  const companion = deps.companionName()
  const asked = lines.filter((l) => l.from === 'companion').length
  const wrapUp = asked >= INTERVIEW_MAX_QUESTIONS
  try {
    const reply = await deps.quick.json({
      system: interviewSystem(companion, deps.language()),
      prompt: lines.length === 0 ? 'Start the chat: say hello in one line and ask your first question.' : `The chat so far:\n${transcriptText(lines, companion)}\n\n${wrapUp ? 'That was the last question: wrap up now (done: true).' : 'Your next turn.'}`,
      schema: turnSchema,
      kind: 'onboarding',
      maxTokens: 400,
      ...(deps.companionId?.() ? { companionId: deps.companionId() } : {}),
    })
    const chips = [...new Set(reply.chips.map((c) => c.trim()).filter(Boolean))].slice(0, reply.multi ? 6 : 4)
    const done = reply.done || wrapUp
    return { say: reply.say.trim(), chips: done ? [] : chips, multi: !done && reply.multi && chips.length > 1, done }
  } catch (err) {
    log.warn('profile', 'A setup conversation turn failed', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

const extractSchema = z.object({
  name: z.string().max(PROFILE_LIMITS.phrase).nullable(),
  work: z.string().max(PROFILE_LIMITS.text).nullable(),
  techLevel: z.enum(TECH_LEVELS).nullable(),
  interests: z.array(z.enum(INTERESTS)).max(INTERESTS.length),
  goals: z.array(z.string().max(PROFILE_LIMITS.phrase)).max(PROFILE_LIMITS.goals),
  habits: z
    .array(z.object({ what: z.string().max(PROFILE_LIMITS.phrase), prompt: z.string().max(PROFILE_LIMITS.text * 2), days: z.array(z.number().int()), time: z.string().max(5), skill: z.string().max(40).nullable() }))
    .max(PROFILE_LIMITS.habits),
  apps: z.array(z.string().max(PROFILE_LIMITS.phrase)).max(PROFILE_LIMITS.apps),
  replyStyle: z.enum(REPLY_STYLES).nullable(),
})

function extractSystem(skills: readonly string[]): string {
  return [
    `You turn a short setup chat between a person and their new browser companion into their profile, for ${BRAND_NAME} to set up their workspace. Use only what the person said; leave out what they didn’t say (null or an empty list). Never guess a name.`,
    `- interests: any of ${INTERESTS.join(', ')} that fit what they want help with or do.`,
    '- techLevel: simple (wants it simple, not into tech), mixed, or technical (developer, IT, power user, or asked for it out of the way); null if unclear.',
    '- work: what they do, in their words, one short sentence. goals: what they want help with, short phrases.',
    '- habits: things they do on a rhythm. what: a few words ("Plan the week"); prompt: what the companion should do each time, written to the companion; days: 0 (Sunday) to 6, empty for every day; time: HH:MM, 24-hour (pick a sensible one if they only said "morning": 09:00); skill: one of these if it fits, else null: ' + skills.join(', ') + '.',
    '- apps: the apps and services they named, as named.',
    '- replyStyle: short, balanced or thorough if they said how they like answers.',
  ].join('\n')
}

/** The profile a conversation adds up to, or null when the engine can't make one (setup falls back to the cards' answers). */
export async function profileFromInterview(deps: InterviewDeps & { skills(): readonly string[] }, lines: readonly InterviewLine[], now: number): Promise<UserProfile | null> {
  if (!lines.some((l) => l.from === 'you')) return null
  try {
    const transcript = transcriptText(lines, deps.companionName())
    const extracting = deps.quick.json({
      system: extractSystem(deps.skills()),
      prompt: transcript,
      schema: extractSchema,
      kind: 'onboarding',
      maxTokens: 1500,
      ...(deps.companionId?.() ? { companionId: deps.companionId() } : {}),
    })
    // DC-11: a decision model, when on, settles the plain picks alongside the extraction.
    const [raw, picks] = await Promise.all([extracting, setupPicks(transcript, extracting.then((r) => ({ techLevel: r.techLevel, replyStyle: r.replyStyle, interests: [...r.interests] })))])
    const habits: ProfileHabit[] = raw.habits.flatMap((h) => {
      const habit = habitSchema.safeParse({ ...h, what: h.what.trim(), prompt: h.prompt.trim(), days: [...new Set(h.days.filter((d) => d >= 0 && d <= 6))].sort(), skill: h.skill && deps.skills().includes(h.skill) ? h.skill : null })
      return habit.success ? [habit.data] : []
    })
    const clean = (list: readonly string[]): string[] => [...new Set(list.map((s) => s.trim()).filter(Boolean))]
    return profileSchema.parse({
      version: 1,
      updatedAt: now,
      name: raw.name?.trim() || null,
      work: raw.work?.trim() || null,
      techLevel: picks.techLevel,
      interests: [...new Set(picks.interests)],
      goals: clean(raw.goals).slice(0, PROFILE_LIMITS.goals),
      habits,
      apps: clean(raw.apps).slice(0, PROFILE_LIMITS.apps),
      replyStyle: picks.replyStyle,
    })
  } catch (err) {
    log.warn('profile', 'The setup conversation couldn’t be turned into a profile', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// ── The plan, and applying what the review step kept ──

export interface ApplyDeps {
  setDestinations(next: Record<Destination, boolean>): void
  saveRoutine(draft: RoutineDraft): unknown
}

/** Applies a reviewed plan: the sidebar rows as chosen and the routines kept (on, as drafted). Returns how many routines it made. */
export function applyWorkspace(plan: WorkspacePlan, choice: WorkspaceChoice, current: Readonly<Record<Destination, boolean>>, deps: ApplyDeps): { routines: number } {
  const destinations = Object.fromEntries(DESTINATIONS.map((d) => [d, choice.destinations[d] ?? plan.destinations[d] ?? current[d]])) as Record<Destination, boolean>
  // Chats stay: the sidebar's own list of conversations.
  destinations.chats = true
  deps.setDestinations(destinations)
  let routines = 0
  for (const r of plan.routines) {
    if (!choice.routines.includes(r.id)) continue
    try {
      deps.saveRoutine(r.draft)
      routines++
    } catch (err) {
      log.warn('profile', 'A routine from setup couldn’t be saved', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { routines }
}

export { workspacePlan, type PlanContext }
