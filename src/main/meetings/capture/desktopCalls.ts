/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DESKTOP_CALL_APPS, attributeCalls, watchedBundles, type AttributeOptions, type CallUse, type CallsSnapshot, type DesktopCallAppId } from '@shared/desktopCalls'
import { detectMeeting, type CalendarEvent, type MeetingProvider } from '@shared/meetingCapture'
import type { HelperLine, SpeechBroker } from '@shared/speech'

// Calls in desktop apps: when Zoom, Teams, FaceTime,
// Webex, a Slack huddle, Discord or a Google Meet web app starts a call,
// Apex offers to take notes, and a recording started from that offer wraps
// up when the call ends.
//
// Detection: the speech helper (native/speech/CallWatch.swift) reports which
// processes have the microphone open, read from Core Audio's process objects
// (macOS 14.4+), and which known apps are running. Neither needs a
// permission or shows a prompt; nothing is recorded to find out.
//
// Recording: the other side is ScreenCaptureKit audio filtered to that app
// (SCContentFilter including only its SCRunningApplications), rather than
// a Core Audio process tap. The meeting checklist already asks for Screen
// Recording, while a tap would add a second, separate "system audio
// recording" permission and an aggregate device, so the filter is both the
// simpler path and the one that needs nothing new. FaceTime plays call audio
// from a system service, so its calls record the Mac's sound as before.
//
// The rules here are pure and unit-tested: the microphone must stay on for
// a moment before a call counts (an app checking its microphone isn't a
// call), short gaps don't restart that wait, a call keeps going through a
// mute while the app still plays sound and ends a while after both stop or
// at once when the app quits, Apex's own processes never count, and each
// call is offered once.

export interface CallTiming {
  /** The microphone stays on this long before a call counts. */
  startMs: number
  /** A gap shorter than this doesn't restart that wait. */
  flapMs: number
  /** With neither microphone nor sound for this long, the call is over. */
  endMs: number
}

export const CALL_TIMING: CallTiming = { startMs: 3_000, flapMs: 1_500, endMs: 20_000 }
/** APEX_SMOKE: the same rules, faster. */
export const SMOKE_CALL_TIMING: CallTiming = { startMs: 200, flapMs: 100, endMs: 400 }

export interface DesktopCall {
  /** `<app>:<when the microphone came on>`: stable for the call, so it is offered once. */
  id: string
  app: DesktopCallAppId
  startedAt: number
  /** Bundle ids whose sound is the other side; empty records the Mac's sound. */
  audio: string[]
}

export type CallTransition = { type: 'started' | 'ended'; call: DesktopCall }

interface AppState {
  /** The microphone has been on since (no call yet). */
  micSince: number | null
  /** …and went off at, inside the flap allowance. */
  micOffAt: number | null
  call: DesktopCall | null
  /** The call has had neither microphone nor sound since. */
  quietSince: number | null
}

/** Turns successive snapshots into call started and ended transitions. */
export class CallTracker {
  readonly #timing: CallTiming
  readonly #apps = new Map<DesktopCallAppId, AppState>()
  #uses = new Map<DesktopCallAppId, CallUse>()

  constructor(timing: CallTiming = CALL_TIMING) {
    this.#timing = timing
  }

  /** A new snapshot (already attributed) at `now`. */
  observe(uses: Map<DesktopCallAppId, CallUse>, now: number): CallTransition[] {
    this.#uses = uses
    return this.tick(now)
  }

  /** Re-evaluates the last snapshot at `now` (the timers' beat). */
  tick(now: number): CallTransition[] {
    const out: CallTransition[] = []
    const ids = new Set<DesktopCallAppId>([...this.#apps.keys(), ...this.#uses.keys()])
    for (const id of ids) {
      const use = this.#uses.get(id)
      const s = this.#apps.get(id) ?? { micSince: null, micOffAt: null, call: null, quietSince: null }
      this.#apps.set(id, s)
      const input = use?.input ?? false
      const sound = input || (use?.output ?? false)
      const present = sound || (use?.running ?? false)
      if (!s.call) {
        if (input) {
          s.micSince ??= now
          s.micOffAt = null
        } else if (s.micSince !== null) {
          s.micOffAt ??= now
          if (now - s.micOffAt >= this.#timing.flapMs) {
            s.micSince = null
            s.micOffAt = null
          }
        }
        if (input && s.micSince !== null && now - s.micSince >= this.#timing.startMs) {
          s.call = { id: `${id}:${s.micSince}`, app: id, startedAt: s.micSince, audio: [...(use?.audio ?? [])] }
          s.quietSince = null
          out.push({ type: 'started', call: { ...s.call } })
        }
      } else {
        if (use?.audio.length) s.call.audio = [...new Set([...s.call.audio, ...use.audio])]
        if (sound) s.quietSince = null
        else s.quietSince ??= now
        const over = !present || (s.quietSince !== null && now - s.quietSince >= this.#timing.endMs)
        if (over) {
          out.push({ type: 'ended', call: { ...s.call } })
          s.call = null
          s.quietSince = null
          s.micSince = null
          s.micOffAt = null
        }
      }
      if (!s.call && s.micSince === null && !present) this.#apps.delete(id)
    }
    return out
  }

  /** When a transition could next happen without a new snapshot, or null. */
  nextAt(): number | null {
    let next: number | null = null
    const at = (t: number): void => {
      next = next === null ? t : Math.min(next, t)
    }
    for (const s of this.#apps.values()) {
      if (s.call) {
        if (s.quietSince !== null) at(s.quietSince + this.#timing.endMs)
      } else if (s.micSince !== null) {
        at(s.micOffAt !== null ? s.micOffAt + this.#timing.flapMs : s.micSince + this.#timing.startMs)
      }
    }
    return next
  }

  /** The calls going on now. */
  calls(): DesktopCall[] {
    return [...this.#apps.values()].flatMap((s) => (s.call ? [{ ...s.call }] : []))
  }

  /** Forgets everything (the watch was switched off), without transitions. */
  reset(): void {
    this.#apps.clear()
    this.#uses = new Map()
  }
}

/** Calendar events whose names a desktop call takes, at most this far ahead… */
export const CALL_EVENT_AHEAD_MS = 10 * 60_000
/** …or this long after their start when nothing names the app's service. */
export const CALL_EVENT_LATE_MS = 15 * 60_000

/**
 * Pure: the calendar event a call starting `now` belongs to, or null. An
 * event with a link to the app's own service wins while it runs; otherwise
 * the event starting closest to now, within ten minutes ahead or a quarter
 * of an hour late. All-day events never name a call.
 */
export function calendarEventForCall(events: readonly CalendarEvent[], o: { now: number; provider: MeetingProvider | null }): CalendarEvent | null {
  const timed = events.filter((e) => !e.allDay && e.startsAt - o.now <= CALL_EVENT_AHEAD_MS && (e.endsAt ?? e.startsAt + 60 * 60_000) >= o.now)
  const closest = (list: CalendarEvent[]): CalendarEvent | null =>
    list.reduce<CalendarEvent | null>((best, e) => (!best || Math.abs(e.startsAt - o.now) < Math.abs(best.startsAt - o.now) ? e : best), null)
  if (o.provider) {
    const linked = timed.filter((e) => e.url && detectMeeting(e.url)?.provider === o.provider)
    if (linked.length) return closest(linked)
  }
  return closest(timed.filter((e) => o.now - e.startsAt <= CALL_EVENT_LATE_MS))
}

/** The name a call's meeting gets: the event's, or "<App> call". */
export function callTitle(app: DesktopCallAppId, event: CalendarEvent | null, fallback: (name: string) => string): string {
  const named = (event?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return named || fallback(DESKTOP_CALL_APPS[app].name)
}

// ── the watcher: the broker's `calls` lines through the tracker, on a timer ──

export interface DesktopCallWatcherDeps {
  broker: Pick<SpeechBroker, 'onLine' | 'watchCalls'>
  /** The setting is on and this Mac can run the helper. */
  enabled(): boolean
  own(): AttributeOptions
  started(call: DesktopCall): void
  ended(call: DesktopCall): void
  timing?: CallTiming
  now?(): number
}

export class DesktopCallWatcher {
  readonly #deps: DesktopCallWatcherDeps
  readonly #tracker: CallTracker
  readonly #off: () => void
  #timer: ReturnType<typeof setTimeout> | null = null
  #supported: boolean | null = null
  #on = false

  constructor(deps: DesktopCallWatcherDeps) {
    this.#deps = deps
    this.#tracker = new CallTracker(deps.timing)
    this.#off = deps.broker.onLine((line) => this.#line(line))
    this.sync()
  }

  /** Starts or stops the helper's watch to match the settings. */
  sync(): void {
    const on = this.#deps.enabled()
    if (on === this.#on) return
    this.#on = on
    this.#deps.broker.watchCalls(on ? watchedBundles() : null)
    if (!on) {
      this.#tracker.reset()
      this.#clearTimer()
    }
  }

  /** Whether this Mac reports microphone use per app (macOS 14.4+); null until the helper has said. */
  supported(): boolean | null {
    return this.#supported
  }

  calls(): DesktopCall[] {
    return this.#tracker.calls()
  }

  /** For tests and smoke: a snapshot as if the helper had sent it. */
  feed(snapshot: CallsSnapshot): void {
    this.#line({ type: 'calls', ...snapshot })
  }

  dispose(): void {
    this.#off()
    this.#clearTimer()
    if (this.#on) this.#deps.broker.watchCalls(null)
    this.#on = false
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #line(line: HelperLine): void {
    if (line.type !== 'calls') return
    this.#supported = line.supported
    if (!this.#on) return
    this.#apply(this.#tracker.observe(attributeCalls(line, this.#deps.own()), this.#now()))
  }

  #apply(transitions: CallTransition[]): void {
    for (const t of transitions) {
      try {
        if (t.type === 'started') this.#deps.started(t.call)
        else this.#deps.ended(t.call)
      } catch {
        // One handler failing never stops the watch.
      }
    }
    this.#schedule()
  }

  #schedule(): void {
    this.#clearTimer()
    const at = this.#tracker.nextAt()
    if (at === null || !this.#on) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#apply(this.#tracker.tick(this.#now()))
    }, Math.max(0, at - this.#now()) + 5)
    this.#timer.unref?.()
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}
