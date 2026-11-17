/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import {
  MUTED_SITES_MAX,
  PROVIDER_NAMES,
  detectMeeting,
  missingPermissions,
  type CalendarEvent,
  type CardAction,
  type CardPayload,
  type MeetingCardKind,
  type MeetingCardSettings,
} from '@shared/meetingCapture'
import { DESKTOP_CALL_APPS, type DesktopCallAppId } from '@shared/desktopCalls'
import type { PermissionKind, SpeechPermissions, TranscriptionSettings } from '@shared/speech'
import { mainT } from '../../i18n/mainT'

// The meeting card's rules and queue (MV-09, ST-20). Pure, so the priority,
// queueing and mute rules are unit-tested; index.ts feeds it navigations,
// calendar events and the recorder's continue question, and shows the head
// of the queue in the meeting-card float.

/** A calendar card shows this long before the meeting starts, and until a while after. */
export const CALENDAR_LEAD_MS = 2 * 60_000
export const CALENDAR_LATE_MS = 5 * 60_000
/** At most this many cards wait; the oldest site suggestion goes first. */
export const QUEUE_MAX = 5

export interface CardSettings {
  meetingCards: MeetingCardSettings
  transcription: Pick<TranscriptionSettings, 'alertMeetingSites' | 'alertCalendar'> & Partial<Pick<TranscriptionSettings, 'alertDesktopCalls' | 'desktopCallsMuted' | 'recordOnly'>>
}

/**
 * What a card can offer with these permissions: the ones still missing
 * (Speech Recognition only counts when meetings are transcribed), whether
 * recording works, and whether it would be audio only (Record audio only is
 * chosen, or Speech Recognition is off for Atelier). Recording needs the
 * microphone; Speech Recognition macOS never asked about isn't off yet, so
 * that card sets up first, as before (recording would ask for it).
 */
export function cardReadiness(p: SpeechPermissions | null, tr: CardSettings['transcription']): { missing: PermissionKind[]; canRecord: boolean; audioOnly: boolean } {
  const chosen = tr.recordOnly === true
  const missing = p ? missingPermissions(p).filter((k) => !(chosen && k === 'speech')) : []
  const speechOff = !chosen && (p?.speech === 'denied' || p?.speech === 'restricted')
  const unasked = !chosen && p?.speech === 'not-determined'
  return { missing, canRecord: !missing.includes('microphone') && !unasked, audioOnly: chosen || speechOff }
}

/** Whether a card of this mode may show. The continue question can't be muted; desktop calls have their own switches. */
export function cardAllowed(mode: CardPayload['mode'], host: string | null, s: CardSettings): boolean {
  if (mode === 'continue') return true
  if (mode === 'app') return !s.meetingCards.all
  const cards = s.meetingCards
  if (cards.all || cards.kinds.includes(mode)) return false
  if (host && cards.sites.includes(host.toLowerCase())) return false
  return true
}

/** The settings patch for a mute action on this card, or null when it can't be muted that way. */
export function mutePatch(action: CardAction, card: CardPayload, current: MeetingCardSettings): Partial<MeetingCardSettings> | null {
  if (card.mode === 'continue') return null
  // A desktop call's own mutes are transcription settings (appMutePatch).
  if (card.mode === 'app') return action === 'mute-all' ? { all: true } : null
  switch (action) {
    case 'mute-all':
      return { all: true }
    case 'mute-kind':
    case 'dont-show-again': {
      const kind: MeetingCardKind = action === 'dont-show-again' ? 'permissions' : card.mode
      return current.kinds.includes(kind) ? null : { kinds: [...current.kinds, kind] }
    }
    case 'mute-site': {
      const host = card.host?.toLowerCase()
      if (!host) return null
      // Newest last; past the cap the oldest mute goes.
      return { sites: [...current.sites.filter((h) => h !== host), host].slice(-MUTED_SITES_MAX) }
    }
    default:
      return null
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

export interface SiteCardInput {
  url: string
  /** The tab's title, when it says more than the provider's name. */
  title?: string | null
  agentControlled: boolean
  /** A recording is running (or starting) already. */
  recording: boolean
  /** speech.status().available */
  available: boolean
  permissions: SpeechPermissions | null
  seen(key: string): boolean
  settings: CardSettings
  smoke?: boolean
}

/** The card a navigation to `url` should queue, with the meeting key to mark seen, or null. */
export function siteCardFor(input: SiteCardInput): { key: string; payload: CardPayload } | null {
  const meeting = detectMeeting(input.url, { smoke: input.smoke })
  if (!meeting || input.agentControlled || input.recording || !input.available) return null
  if (!input.settings.transcription.alertMeetingSites || input.seen(meeting.key)) return null
  const host = hostOf(input.url)
  const title = cleanTitle(input.title, meeting.title)
  const { missing, canRecord, audioOnly } = cardReadiness(input.permissions, input.settings.transcription)
  if (missing.length > 0 && cardAllowed('permissions', host, input.settings)) {
    return { key: meeting.key, payload: { mode: 'permissions', provider: meeting.provider, title, host, missing, canRecord, ...(audioOnly ? { audioOnly } : {}) } }
  }
  // Muted permission reminders fall back to the ordinary card; recording then reports what is missing.
  if (!cardAllowed('site', host, input.settings)) return null
  return { key: meeting.key, payload: { mode: 'site', provider: meeting.provider, title, host, ...(audioOnly ? { audioOnly } : {}) } }
}

/** Calendar events due a card now (the CalendarSource), oldest first. */
export function calendarCardsFor(
  events: readonly CalendarEvent[],
  input: { now: number; recording: boolean; available: boolean; seen(key: string): boolean; settings: CardSettings },
): Array<{ key: string; event: CalendarEvent; payload: CardPayload }> {
  if (input.recording || !input.available || !input.settings.transcription.alertCalendar) return []
  const due = events
    .filter((e) => e.startsAt - input.now <= CALENDAR_LEAD_MS && input.now - e.startsAt <= CALENDAR_LATE_MS)
    .filter((e) => !input.seen(`calendar:${e.id}`))
    .sort((a, b) => a.startsAt - b.startsAt)
  const out: Array<{ key: string; event: CalendarEvent; payload: CardPayload }> = []
  for (const event of due) {
    const host = event.url ? hostOf(event.url) : null
    if (!cardAllowed('calendar', host, input.settings)) continue
    const provider = event.url ? (detectMeeting(event.url)?.provider ?? null) : null
    out.push({
      key: `calendar:${event.id}`,
      event,
      payload: { mode: 'calendar', provider, title: event.title.replace(/\s+/g, ' ').trim().slice(0, 200) || (provider ? PROVIDER_NAMES[provider] : mainT('capture.card.label')), host, startsAt: event.startsAt, joinable: Boolean(event.url) },
    })
  }
  return out
}

function cleanTitle(title: string | null | undefined, fallback: string): string {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  // Meeting tabs are often titled just with the service's name or the code.
  return clean && clean.toLowerCase() !== fallback.toLowerCase() ? clean : fallback
}

// ── the queue ──

export interface CardEntry {
  id: string
  payload: CardPayload
  /** The tab whose navigation raised it (site and permissions cards). */
  tabId: string | null
  url: string | null
  /** The detected meeting's key or the calendar key, already marked seen. */
  key: string | null
  /** A desktop call's card: the call it records, and whose end wraps the recording up. */
  call?: { id: string; app: DesktopCallAppId; audio: string[] } | null
}

export interface CardQueueDeps {
  /** Shows (or replaces) the card in the float. */
  show(entry: CardEntry): void
  hide(): void
}

/**
 * One card at a time. A continue question jumps ahead of everything (the
 * card it displaces waits at the front); other cards wait their turn.
 */
export class CardQueue {
  readonly #deps: CardQueueDeps
  #current: CardEntry | null = null
  #waiting: CardEntry[] = []

  constructor(deps: CardQueueDeps) {
    this.#deps = deps
  }

  current(): CardEntry | null {
    return this.#current
  }

  waiting(): readonly CardEntry[] {
    return this.#waiting
  }

  /** Queues a card; returns its entry. */
  offer(card: Omit<CardEntry, 'id'> & { id?: string }): CardEntry {
    const entry: CardEntry = { ...card, id: card.id ?? randomUUID(), payload: { ...card.payload } }
    entry.payload.id = entry.id
    if (entry.payload.mode === 'continue') {
      // Only one question at a time; a new one replaces the old.
      this.#waiting = this.#waiting.filter((e) => e.payload.mode !== 'continue')
      if (this.#current && this.#current.payload.mode !== 'continue') this.#waiting.unshift(this.#current)
      this.#current = entry
      this.#deps.show(entry)
      return entry
    }
    if (entry.key && (this.#current?.key === entry.key || this.#waiting.some((e) => e.key === entry.key))) return entry
    if (!this.#current) {
      this.#current = entry
      this.#deps.show(entry)
      return entry
    }
    this.#waiting.push(entry)
    while (this.#waiting.length > QUEUE_MAX) {
      const oldest = this.#waiting.findIndex((e) => e.payload.mode === 'site')
      this.#waiting.splice(oldest >= 0 ? oldest : 0, 1)
    }
    return entry
  }

  /** The current card closed (acted on or dismissed): the next one shows. */
  done(): void {
    this.#current = null
    const next = this.#waiting.shift()
    if (next) {
      this.#current = next
      this.#deps.show(next)
    } else {
      this.#deps.hide()
    }
  }

  /** Drops matching cards, the current one included. */
  withdraw(match: (entry: CardEntry) => boolean): void {
    this.#waiting = this.#waiting.filter((e) => !match(e))
    if (this.#current && match(this.#current)) this.done()
  }
}

// ── desktop calls ──

export interface AppCardInput {
  app: DesktopCallAppId
  /** The call's id (DesktopCall.id): the card's key, so each call is offered once. */
  callId: string
  /** The meeting's name: the calendar event's, or "<App> call". */
  title: string
  /** The calendar event it was named after, when one matched. */
  eventStartsAt?: number | null
  recording: boolean
  available: boolean
  permissions: SpeechPermissions | null
  seen(key: string): boolean
  settings: CardSettings
}

/** The key a desktop call's card is queued and remembered under. */
export const callKey = (callId: string): string => `call:${callId}`

/** The card a desktop call should queue, or null (off, muted, recording, or offered already). */
export function appCardFor(input: AppCardInput): { key: string; payload: CardPayload } | null {
  const tr = input.settings.transcription
  if (input.recording || !input.available || tr.alertDesktopCalls === false || (tr.desktopCallsMuted ?? []).includes(input.app)) return null
  const key = callKey(input.callId)
  if (input.seen(key) || !cardAllowed('app', null, input.settings)) return null
  const provider = DESKTOP_CALL_APPS[input.app].provider
  const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 200) || DESKTOP_CALL_APPS[input.app].name
  const { missing, canRecord, audioOnly } = cardReadiness(input.permissions, tr)
  if (missing.length > 0 && cardAllowed('permissions', null, input.settings)) {
    return { key, payload: { mode: 'permissions', provider, title, host: null, missing, canRecord, app: input.app, ...(audioOnly ? { audioOnly } : {}) } }
  }
  return { key, payload: { mode: 'app', provider, title, host: null, app: input.app, ...(input.eventStartsAt ? { startsAt: input.eventStartsAt } : {}), ...(audioOnly ? { audioOnly } : {}) } }
}

/** The transcription patch for a mute action on a desktop call's card, or null when it isn't one. */
export function appMutePatch(action: CardAction, card: CardPayload, current: Pick<TranscriptionSettings, 'desktopCallsMuted'>): Partial<TranscriptionSettings> | null {
  if (card.mode !== 'app' || !card.app) return null
  if (action === 'mute-kind') return { alertDesktopCalls: false }
  if (action === 'mute-app') return current.desktopCallsMuted.includes(card.app) ? null : { desktopCallsMuted: [...current.desktopCallsMuted, card.app] }
  return null
}

/** A continue question's card. */
export function continueCard(reason: 'long' | 'silent', countdownMs: number, title: string): CardPayload {
  return { mode: 'continue', provider: null, title, host: null, reason, countdownMs }
}
