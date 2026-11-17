/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CardPayload, MeetingCardSettings } from '../src/shared/meetingCapture'
import {
  CALENDAR_LEAD_MS,
  CardQueue,
  QUEUE_MAX,
  appCardFor,
  calendarCardsFor,
  cardAllowed,
  cardReadiness,
  continueCard,
  mutePatch,
  siteCardFor,
  type CardEntry,
  type CardSettings,
} from '../src/main/meetings/capture/cards'
import { SEEN_TTL_MS, SeenKeys, pruneSeen } from '../src/main/meetings/capture/seen'

// The meeting card's priority, queueing and mute rules (MV-09, ST-20).

const MEET = 'https://meet.google.com/abc-defg-hij'
const GRANTED = { microphone: 'granted', speech: 'granted', screen: 'granted' } as const

function settings(cards: Partial<MeetingCardSettings> = {}, alerts: Partial<CardSettings['transcription']> = {}): CardSettings {
  return { meetingCards: { all: false, kinds: [], sites: [], ...cards }, transcription: { alertMeetingSites: true, alertCalendar: true, ...alerts } }
}

function site(over: Partial<Parameters<typeof siteCardFor>[0]> = {}) {
  return siteCardFor({ url: MEET, agentControlled: false, recording: false, available: true, permissions: GRANTED, seen: () => false, settings: settings(), ...over })
}

describe('site cards', () => {
  it('offers record for a meeting, keyed once per meeting', () => {
    expect(site()).toEqual({ key: 'meet:abc-defg-hij', payload: { mode: 'site', provider: 'meet', title: 'Google Meet', host: 'meet.google.com' } })
  })

  it('skips agent tabs, running recordings, a missing helper, seen meetings and the switch being off', () => {
    expect(site({ agentControlled: true })).toBeNull()
    expect(site({ recording: true })).toBeNull()
    expect(site({ available: false })).toBeNull()
    expect(site({ seen: (k) => k === 'meet:abc-defg-hij' })).toBeNull()
    expect(site({ settings: settings({}, { alertMeetingSites: false }) })).toBeNull()
    expect(site({ url: 'https://meet.google.com/landing' })).toBeNull()
  })

  it('asks for missing permissions first, and offers mic-only recording when only Screen Recording is missing', () => {
    const none = site({ permissions: { microphone: 'denied', speech: 'not-determined', screen: 'denied' } })
    expect(none?.payload).toMatchObject({ mode: 'permissions', missing: ['microphone', 'speech', 'screen'], canRecord: false })
    const screen = site({ permissions: { ...GRANTED, screen: 'denied' } })
    expect(screen?.payload).toMatchObject({ mode: 'permissions', missing: ['screen'], canRecord: true })
  })

  it('records audio only when Speech Recognition is missing, or when Record audio only is chosen', () => {
    const speech = site({ permissions: { ...GRANTED, speech: 'denied' } })
    expect(speech?.payload).toMatchObject({ mode: 'permissions', missing: ['speech'], canRecord: true, audioOnly: true })
    // Chosen: Speech Recognition isn't needed, so there is nothing to ask for.
    const chosen = site({ permissions: { ...GRANTED, speech: 'denied' }, settings: settings({}, { recordOnly: true }) })
    expect(chosen?.payload).toEqual({ mode: 'site', provider: 'meet', title: 'Google Meet', host: 'meet.google.com', audioOnly: true })
    expect(site()?.payload.audioOnly).toBeUndefined()
    // Never asked isn't off: set up first (recording would ask), as before.
    const unasked = site({ permissions: { ...GRANTED, speech: 'not-determined' } })
    expect(unasked?.payload).toMatchObject({ mode: 'permissions', missing: ['speech'], canRecord: false })
    expect(unasked?.payload.audioOnly).toBeUndefined()
    expect(cardReadiness(null, { alertMeetingSites: true, alertCalendar: true })).toEqual({ missing: [], canRecord: true, audioOnly: false })
    expect(cardReadiness({ ...GRANTED, microphone: 'denied', speech: 'denied' }, { alertMeetingSites: true, alertCalendar: true })).toMatchObject({ canRecord: false, audioOnly: true })
  })

  it('offers to record a desktop call instead of taking notes when it would be audio only', () => {
    const call = (over: Partial<Parameters<typeof appCardFor>[0]> = {}) =>
      appCardFor({ app: 'zoom', callId: 'c1', title: 'Zoom call', eventStartsAt: null, recording: false, available: true, permissions: GRANTED, seen: () => false, settings: settings(), ...over })
    expect(call()?.payload).toMatchObject({ mode: 'app' })
    expect(call()?.payload.audioOnly).toBeUndefined()
    expect(call({ settings: settings({}, { recordOnly: true }) })?.payload).toMatchObject({ mode: 'app', audioOnly: true })
  })

  it('falls back to the ordinary card when permission reminders are muted', () => {
    const muted = site({ permissions: { ...GRANTED, screen: 'denied' }, settings: settings({ kinds: ['permissions'] }) })
    expect(muted?.payload.mode).toBe('site')
  })

  it('honours every mute', () => {
    expect(site({ settings: settings({ all: true }) })).toBeNull()
    expect(site({ settings: settings({ kinds: ['site'] }) })).toBeNull()
    expect(site({ settings: settings({ sites: ['meet.google.com'] }) })).toBeNull()
    expect(site({ settings: settings({ sites: ['zoom.us'] }) })).not.toBeNull()
  })

  it('never mutes the continue question', () => {
    expect(cardAllowed('continue', null, settings({ all: true, kinds: ['site', 'calendar', 'permissions'] }))).toBe(true)
  })
})

describe('mute patches', () => {
  const card: CardPayload = { mode: 'site', provider: 'meet', title: 'Google Meet', host: 'Meet.Google.com' }
  const current: MeetingCardSettings = { all: false, kinds: [], sites: ['zoom.us'] }

  it('mutes the kind, the site (lowercase, deduped) or everything', () => {
    expect(mutePatch('mute-kind', card, current)).toEqual({ kinds: ['site'] })
    expect(mutePatch('mute-site', card, current)).toEqual({ sites: ['zoom.us', 'meet.google.com'] })
    expect(mutePatch('mute-site', card, { ...current, sites: ['meet.google.com', 'zoom.us'] })).toEqual({ sites: ['zoom.us', 'meet.google.com'] })
    expect(mutePatch('mute-all', card, current)).toEqual({ all: true })
  })

  it('"don\'t show again" mutes permission reminders', () => {
    expect(mutePatch('dont-show-again', { ...card, mode: 'permissions' }, current)).toEqual({ kinds: ['permissions'] })
    expect(mutePatch('dont-show-again', card, { ...current, kinds: ['permissions'] })).toBeNull()
  })

  it('keeps at most 200 muted sites, dropping the oldest', () => {
    const many = Array.from({ length: 200 }, (_, i) => `site${i}.example`)
    const next = mutePatch('mute-site', card, { ...current, sites: many })
    expect(next?.sites).toHaveLength(200)
    expect(next?.sites?.[0]).toBe('site1.example')
    expect(next?.sites?.at(-1)).toBe('meet.google.com')
  })

  it('refuses to mute the continue question or a card without a site', () => {
    expect(mutePatch('mute-all', continueCard('long', 60_000, 'Still recording?'), current)).toBeNull()
    expect(mutePatch('mute-site', { ...card, host: null }, current)).toBeNull()
  })
})

describe('calendar cards', () => {
  const now = 1_800_000_000_000
  const events = [
    { id: 'later', title: 'Planning', startsAt: now + 30 * 60_000, url: 'https://zoom.us/j/1234567890' },
    { id: 'soon', title: 'Standup', startsAt: now + 60_000, url: 'https://meet.google.com/abc-defg-hij' },
    { id: 'started', title: 'Sync', startsAt: now - 60_000, url: null },
    { id: 'old', title: 'Review', startsAt: now - 30 * 60_000, url: null },
  ]
  const input = { now, recording: false, available: true, seen: () => false, settings: settings() }

  it('offers meetings about to start, soonest first, with join only when there is a link', () => {
    const due = calendarCardsFor(events, input)
    expect(due.map((d) => d.event.id)).toEqual(['started', 'soon'])
    expect(due[1]?.payload).toMatchObject({ mode: 'calendar', provider: 'meet', title: 'Standup', joinable: true, startsAt: now + 60_000 })
    expect(due[0]?.payload).toMatchObject({ joinable: false, host: null })
    expect(due[1]?.key).toBe('calendar:soon')
  })

  it('stays quiet while recording, when muted, when seen or with the alert off', () => {
    expect(calendarCardsFor(events, { ...input, recording: true })).toEqual([])
    expect(calendarCardsFor(events, { ...input, settings: settings({}, { alertCalendar: false }) })).toEqual([])
    expect(calendarCardsFor(events, { ...input, settings: settings({ kinds: ['calendar'] }) })).toEqual([])
    expect(calendarCardsFor(events, { ...input, seen: (k) => k === 'calendar:soon' }).map((d) => d.event.id)).toEqual(['started'])
    expect(calendarCardsFor([{ ...events[1]!, startsAt: now + CALENDAR_LEAD_MS + 1 }], input)).toEqual([])
  })
})

describe('card queue', () => {
  function queue() {
    const shown: CardEntry[] = []
    let hidden = 0
    const q = new CardQueue({ show: (e) => shown.push(e), hide: () => hidden++ })
    const offer = (mode: CardPayload['mode'], key: string | null, tabId: string | null = null) =>
      q.offer({ payload: { mode, provider: null, title: key ?? mode, host: null }, tabId, url: null, key })
    return { q, shown, hidden: () => hidden, offer }
  }

  it('shows one card at a time and the next when it closes', () => {
    const { q, shown, hidden, offer } = queue()
    offer('site', 'a')
    offer('site', 'b')
    expect(shown.map((e) => e.key)).toEqual(['a'])
    q.done()
    expect(shown.map((e) => e.key)).toEqual(['a', 'b'])
    q.done()
    expect(hidden()).toBe(1)
    expect(q.current()).toBeNull()
  })

  it('stamps each payload with its card id', () => {
    const { shown, offer } = queue()
    const entry = offer('site', 'a')
    expect(shown[0]?.payload.id).toBe(entry.id)
  })

  it('lets the continue question jump ahead; the card it displaced comes back after', () => {
    const { q, shown, offer } = queue()
    offer('site', 'a')
    offer('calendar', 'b')
    offer('continue', null)
    expect(q.current()?.payload.mode).toBe('continue')
    // Other cards wait while the question is up.
    offer('site', 'c')
    expect(q.current()?.payload.mode).toBe('continue')
    q.done()
    expect(q.current()?.key).toBe('a')
    expect(q.waiting().map((e) => e.key)).toEqual(['b', 'c'])
    expect(shown.map((e) => e.payload.mode)).toEqual(['site', 'continue', 'site'])
  })

  it('keeps one continue question', () => {
    const { q, offer } = queue()
    offer('continue', null)
    offer('continue', null)
    q.done()
    expect(q.current()).toBeNull()
  })

  it('ignores a meeting already queued', () => {
    const { q, offer } = queue()
    offer('site', 'a')
    offer('site', 'a')
    offer('site', 'b')
    offer('site', 'b')
    expect(q.waiting().map((e) => e.key)).toEqual(['b'])
  })

  it('withdraws a closed tab’s cards, the current one included', () => {
    const { q, shown, offer } = queue()
    offer('site', 'a', 't1')
    offer('site', 'b', 't2')
    offer('site', 'c', 't1')
    q.withdraw((e) => e.tabId === 't1')
    expect(q.current()?.key).toBe('b')
    expect(q.waiting()).toEqual([])
    expect(shown.map((e) => e.key)).toEqual(['a', 'b'])
  })

  it('drops the oldest waiting site card past the limit', () => {
    const { q, offer } = queue()
    offer('site', 'now')
    offer('permissions', 'p')
    for (let i = 0; i < QUEUE_MAX + 2; i++) offer('site', `s${i}`)
    expect(q.waiting()).toHaveLength(QUEUE_MAX)
    expect(q.waiting()[0]?.key).toBe('p')
    expect(q.waiting().at(-1)?.key).toBe(`s${QUEUE_MAX + 1}`)
  })
})

describe('seen meetings', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    vi.useRealTimers()
  })

  it('forgets keys after seven days', () => {
    const now = 1_800_000_000_000
    expect(pruneSeen({ a: now - 1000, b: now - SEEN_TTL_MS - 1, c: Number.NaN as number }, now)).toEqual({ a: now - 1000 })
  })

  it('persists keys, but keeps private windows’ keys in memory only', () => {
    dir = mkdtempSync(join(tmpdir(), 'apex-seen-'))
    const path = join(dir, 'meeting-cards.json')
    const now = 1_800_000_000_000
    const seen = new SeenKeys(path, now)
    seen.add('meet:abc-defg-hij', { now })
    seen.add('meet:private-one', { private: true, now })
    expect(seen.has('meet:abc-defg-hij', now)).toBe(true)
    expect(seen.has('meet:private-one', now)).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>
    expect(Object.keys(saved)).toEqual(['meet:abc-defg-hij'])
    const reloaded = new SeenKeys(path, now + 1000)
    expect(reloaded.has('meet:abc-defg-hij', now + 1000)).toBe(true)
    expect(reloaded.has('meet:private-one', now + 1000)).toBe(false)
    expect(reloaded.has('meet:abc-defg-hij', now + SEEN_TTL_MS + 1)).toBe(false)
  })
})
