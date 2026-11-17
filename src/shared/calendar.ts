/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The contract for the macOS Calendar and Reminders
// helper. Each kind needs its own system permission and its
// own switch; nothing is read until both say yes. In main, CalendarService
// implements meeting capture's CalendarSource, calls setCalendarSource and emits
// `meeting-soon(event)` for the meeting card (MV-09) and alert (ST-20).
import type { CalendarEvent as MeetingCalendarEvent } from './meetingCapture'

export type CalendarKind = 'events' | 'reminders'
export type CalendarPermission = 'not-determined' | 'denied' | 'granted' | 'restricted'

export interface CalendarStatus {
  /** False without the helper (other platforms, or a build without it). */
  available: boolean
  events: CalendarPermission
  reminders: CalendarPermission
  enabled: { events: boolean; reminders: boolean }
}

/** One event; a superset of meeting capture's CalendarEvent, so it can feed its CalendarSource directly. */
export interface CalendarEvent extends MeetingCalendarEvent {
  endsAt: number
  allDay: boolean
  calendar: string
  location: string | null
}

export interface Reminder {
  id: string
  title: string
  dueAt: number | null
  list: string
  completed: boolean
}

/** Status, upcoming and reminders ask the helper, so they resolve asynchronously. */
export interface CalendarService {
  status(): Promise<CalendarStatus>
  requestAccess(kind: CalendarKind): Promise<CalendarStatus>
  setEnabled(kind: CalendarKind, on: boolean): Promise<CalendarStatus>
  upcoming(range: { from: number; to: number }): Promise<CalendarEvent[]>
  reminders(): Promise<Reminder[]>
  openPrivacySettings(kind: CalendarKind): void
}

/** The widest window upcoming() reads in one call. */
export const CALENDAR_RANGE_MAX_MS = 62 * 24 * 60 * 60_000
/** Events and reminders one call returns at most. */
export const CALENDAR_ITEMS_MAX = 500
/** How long before a meeting starts it counts as "soon" (the meeting card and alert). */
export const MEETING_SOON_MS = 2 * 60_000

/** Whether the agent may read this kind: switched on in Apex and granted by macOS. */
export function calendarReadable(status: CalendarStatus, kind: CalendarKind): boolean {
  return status.available && status.enabled[kind] && status[kind] === 'granted'
}
