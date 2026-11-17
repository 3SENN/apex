/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Calendar and Reminders client tools (calendar_events,
// list_reminders). Read-only, and offered only while that kind is switched
// on in Atelier (Agent permissions › This Mac); without macOS's permission
// they say so instead of guessing.
import { z } from 'zod'
import { CALENDAR_RANGE_MAX_MS, type CalendarKind } from '@shared/calendar'
import { CLIENT_TOOL_RESULT_MAX, registerClientTool, type ClientTool } from '../agent/tools/registry'
import type { CalendarService } from '../calendar'

const DAY = 24 * 60 * 60_000

const when = z.string().max(64).refine((v) => !Number.isNaN(Date.parse(v)), 'Use an ISO 8601 date or date-time.')

function notReadable(kind: CalendarKind): string {
  return kind === 'events'
    ? 'Calendar access is off or not granted. The person can turn it on in Settings › Agent permissions › This Mac.'
    : 'Reminders access is off or not granted. The person can turn it on in Settings › Agent permissions › This Mac.'
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

export function registerCalendarTools(calendar: CalendarService): void {
  registerClientTool({
    name: 'calendar_events',
    group: 'calendar',
    description:
      "Reads events from the person's macOS Calendar, read-only. Give an ISO 8601 range (from defaults to now, to to seven days later; at most two months). Optionally filter by text in the title, calendar or location. Times come back in ISO 8601 UTC with the person's time zone.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start, ISO 8601 (default: now).' },
        to: { type: 'string', description: 'End, ISO 8601 (default: seven days after from).' },
        query: { type: 'string', description: 'Only events whose title, calendar or location contains this text.' },
      },
      additionalProperties: false,
    },
    parse: z.object({ from: when.optional(), to: when.optional(), query: z.string().max(200).optional() }).strict(),
    enabled: (setup) => setup.workspace.calendar && calendar.enabled('events'),
    async run(input) {
      if (!calendar.readable('events')) {
        await calendar.status()
        if (!calendar.readable('events')) return { content: notReadable('events'), isError: true }
      }
      const from = input.from ? Date.parse(input.from) : Date.now()
      const to = input.to ? Date.parse(input.to) : from + 7 * DAY
      if (to < from) return { content: '`to` is before `from`.', isError: true }
      if (to - from > CALENDAR_RANGE_MAX_MS) return { content: 'Ask for at most two months at a time.', isError: true }
      const needle = input.query?.trim().toLowerCase()
      const events = (await calendar.upcoming({ from, to })).filter(
        (e) => !needle || [e.title, e.calendar, e.location ?? ''].some((f) => f.toLowerCase().includes(needle)),
      )
      const body = {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        from: iso(from),
        to: iso(to),
        events: events.map((e) => ({ title: e.title, start: iso(e.startsAt), end: iso(e.endsAt), allDay: e.allDay, calendar: e.calendar, location: e.location, meetingUrl: e.url })),
      }
      return { content: JSON.stringify(body).slice(0, CLIENT_TOOL_RESULT_MAX) }
    },
  } satisfies ClientTool<{ from?: string; to?: string; query?: string }>)

  registerClientTool({
    name: 'list_reminders',
    group: 'calendar',
    description: "Lists the person's macOS Reminders, read-only: title, list, due date and whether it is done. Completed ones are left out unless includeCompleted is true.",
    inputSchema: {
      type: 'object',
      properties: { includeCompleted: { type: 'boolean', description: 'Include completed reminders.' } },
      additionalProperties: false,
    },
    parse: z.object({ includeCompleted: z.boolean().optional() }).strict(),
    enabled: (setup) => setup.workspace.calendar && calendar.enabled('reminders'),
    async run(input) {
      if (!calendar.readable('reminders')) {
        await calendar.status()
        if (!calendar.readable('reminders')) return { content: notReadable('reminders'), isError: true }
      }
      const reminders = (await calendar.reminders()).filter((r) => input.includeCompleted || !r.completed)
      const body = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, reminders: reminders.map((r) => ({ title: r.title, list: r.list, due: iso(r.dueAt), completed: r.completed })) }
      return { content: JSON.stringify(body).slice(0, CLIENT_TOOL_RESULT_MAX) }
    },
  } satisfies ClientTool<{ includeCompleted?: boolean }>)
}
