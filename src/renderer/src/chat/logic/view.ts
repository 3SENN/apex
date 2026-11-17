/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompanionMood } from '@shared/companion'
import type { AgentStatus } from '@shared/ipc'
import { t } from '@shared/i18n/core'

// Pure rules for a chat view: the reading position, and the companion's mood
// for one chat (the global mood hook mixes every chat's events).

/** Distance from the bottom, in px, that still counts as reading the newest output. */
export const STICK_THRESHOLD = 48

interface ScrollBox {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

export function isNearBottom(el: ScrollBox, threshold = STICK_THRESHOLD): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/** After you scroll up, the view doesn't stick to new output again for this long. */
export const FOLLOW_GRACE_MS = 450
/** Jump to newest scrolls smoothly up to this far; further, it jumps at once. */
export const SMOOTH_JUMP_MAX = 1600

/** Keys that read as wanting to look further up: they stop the view following new output. */
export function isUpwardIntent(key: { key: string; shiftKey?: boolean }): boolean {
  return key.key === 'ArrowUp' || key.key === 'PageUp' || key.key === 'Home' || (key.key === ' ' && key.shiftKey === true)
}

/** Whether new output should keep the view at the bottom, after a scroll event. */
export function shouldFollow(el: ScrollBox, releasedAt: number, now: number): boolean {
  if (now - releasedAt < FOLLOW_GRACE_MS) return false
  return isNearBottom(el)
}

export function jumpBehavior(distance: number, reducedMotion: boolean): ScrollBehavior {
  return reducedMotion || distance > SMOOTH_JUMP_MAX ? 'instant' : 'smooth'
}

/** The fades at the scroller's edges: only where content is hidden that way, and only once there are messages. */
export function edgeFades(el: ScrollBox, hasMessages: boolean): { top: boolean; bottom: boolean } {
  // DS-61: only the top edge fades (under the header); the bottom never does.
  if (!hasMessages) return { top: false, bottom: false }
  return { top: el.scrollTop > 1, bottom: false }
}

/** The live timer beside a working status: 0:07, 3:45, 1:02:03. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** The still line under a finished reply: "Took 12 s", "Took 3 min 45 s", "Took 1 h 4 min". */
export function formatWorked(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return t('chat.view.tookH', { h, value: m > 0 ? ` ${m} min` : '' })
  if (m > 0) return t('chat.view.tookMin', { m, value: s > 0 ? ` ${s} s` : '' })
  return t('chat.view.tookS', { s })
}

export const TALK_HOLD_MS = 700
export const CELEBRATE_MS = 2600

export interface MoodInput {
  status: AgentStatus
  /** The last thing the run did, and when. */
  activity: 'text' | 'thinking' | 'tool' | null
  activityAt: number
  /** How the last run ended, and when; null while running or before any run. */
  outcome: 'ok' | 'error' | null
  outcomeAt: number
  listening: boolean
  now: number
}

/** The mood, and how long until it would change on its own (null: not until the next event). */
export function chatMood(input: MoodInput): { mood: CompanionMood; changesIn: number | null } {
  const { status, now } = input
  if (status === 'awaiting-approval') return { mood: 'approval', changesIn: null }
  if (status === 'running') {
    if (input.activity === 'tool') return { mood: 'working', changesIn: null }
    const talking = input.activity === 'text' && now - input.activityAt < TALK_HOLD_MS
    return talking ? { mood: 'talking', changesIn: TALK_HOLD_MS - (now - input.activityAt) } : { mood: 'thinking', changesIn: null }
  }
  if (input.outcome && now - input.outcomeAt < CELEBRATE_MS) {
    return { mood: input.outcome === 'ok' ? 'happy' : 'sad', changesIn: CELEBRATE_MS - (now - input.outcomeAt) }
  }
  return { mood: input.listening ? 'listening' : 'idle', changesIn: null }
}

/** Is this error notice the plain "you stopped it" one? */
export function isStopNotice(text: string): boolean {
  return text === 'Stopped.'
}

/** Notices that a key in Settings would fix get an Open settings action. */
export function mentionsApiKey(text: string): boolean {
  return /api key/i.test(text)
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The time on a reply's face tooltip: "4:12 pm" today, "12 Mar, 4:12 pm" before. */
export function formatClock(ms: number, now = Date.now(), locale?: string): string {
  const at = new Date(ms)
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  if (at.toDateString() === new Date(now).toDateString()) return time
  return `${at.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}, ${time}`
}

/**
 * How tall the companion waiting in an empty chat stands (CO-20, DS-72): up
 * to about 200 px on the chat page and 140 px in the panel, shrinking in
 * short windows so the greeting, starters and composer still fit.
 */
export function waitingSize(variant: 'page' | 'panel', room: number | null): number {
  const [min, max, share] = variant === 'page' ? [150, 200, 0.25] : [104, 140, 0.2]
  if (room === null) return variant === 'page' ? 200 : 140
  return Math.round(Math.min(max, Math.max(min, room * share)))
}
