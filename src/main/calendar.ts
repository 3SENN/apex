/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Calendar and Reminders helper's main side. Opt-in and read-only:
// each kind needs Apex's switch and macOS's permission. The helper
// (native/calendar, Swift and EventKit) answers one command per run in JSON
// lines; tests and smoke point APEX_CALENDAR_HELPER at a fake. It implements
// the meetings CalendarSource (setCalendarSource once events are on) and
// emits 'meeting-soon' for the meeting card (MV-09) and alert (ST-20).
import { BRAND_NAME } from '@shared/branding'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CALENDAR_ITEMS_MAX,
  CALENDAR_RANGE_MAX_MS,
  MEETING_SOON_MS,
  calendarReadable,
  type CalendarEvent,
  type CalendarKind,
  type CalendarPermission,
  type CalendarService as CalendarApi,
  type CalendarStatus,
  type Reminder,
} from '@shared/calendar'
import type { CalendarSource } from '@shared/meetingCapture'
import { log } from './log'
import { writeAtomic } from './settings'

// ── The helper protocol (one JSON object per line) ──

const permission = z.enum(['not-determined', 'denied', 'granted', 'restricted'])

const helperLine = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), events: permission, reminders: permission }),
  z.object({
    type: z.literal('event'),
    id: z.string().min(1).max(512),
    title: z.string().max(1000),
    startsAt: z.number(),
    endsAt: z.number(),
    allDay: z.boolean(),
    calendar: z.string().max(500),
    location: z.string().max(2000).nullable(),
    url: z.string().max(4000).nullable(),
  }),
  z.object({
    type: z.literal('reminder'),
    id: z.string().min(1).max(512),
    title: z.string().max(1000),
    dueAt: z.number().nullable(),
    list: z.string().max(500),
    completed: z.boolean(),
  }),
  z.object({ type: z.literal('changed') }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('error'), message: z.string().max(2000) }),
])

export type HelperLine = z.infer<typeof helperLine>

/** Parses the helper's output; unknown or broken lines are skipped (and logged), never trusted. */
export function parseHelperOutput(text: string): HelperLine[] {
  const out: HelperLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const parsed = helperLine.safeParse(JSON.parse(line))
      if (parsed.success) out.push(parsed.data)
      else log.warn('calendar', 'helper line did not match the protocol')
    } catch {
      log.warn('calendar', 'helper printed a line that is not JSON')
    }
  }
  return out
}

/** A meeting link inside an event's url, location or title (the meeting card offers Join for it). */
export function meetingUrl(...fields: (string | null)[]): string | null {
  for (const field of fields) {
    const hit = field?.match(/https:\/\/[^\s<>"']*(zoom\.us\/[jw]\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet\/|whereby\.com\/|webex\.com\/)[^\s<>"']*/i)
    if (hit) return hit[0]
  }
  return null
}

export function toEvent(line: Extract<HelperLine, { type: 'event' }>): CalendarEvent {
  return {
    id: line.id,
    title: line.title || 'Untitled event',
    startsAt: line.startsAt,
    endsAt: line.endsAt,
    allDay: line.allDay,
    calendar: line.calendar,
    location: line.location,
    url: meetingUrl(line.url, line.location, line.title) ?? (line.url && /^https?:\/\//.test(line.url) ? line.url : null),
  }
}

// ── Where the helper is ──

export function calendarHelperPath(o: { packaged: boolean; resourcesPath: string; appPath: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): string | null {
  const env = o.env ?? process.env
  const override = env.APEX_CALENDAR_HELPER
  if (override) {
    // A fused build can't run a script as Node: launching itself on one starts a whole second Apex.
    // Only a smoke run that lends its own Node (APEX_SMOKE_NODE) may point a packaged app at the fake.
    if (o.packaged && isScript(override) && !(env.APEX_SMOKE === '1' && env.APEX_SMOKE_NODE)) return null
    return existsSync(override) ? override : null
  }
  if ((o.platform ?? process.platform) !== 'darwin') return null
  const path = o.packaged ? join(o.resourcesPath, 'apex-calendar') : join(o.appPath, 'native', 'calendar', 'build', 'apex-calendar')
  return existsSync(path) ? path : null
}

const isScript = (path: string): boolean => /\.(m?js|cjs)$/.test(path)

/** A script helper (the tests' fake) runs under this process's Node; the real one is a binary. */
function command(helper: string, args: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (isScript(helper)) {
    // A fused build can't run as Node (the RunAsNode fuse is off), so the packaged
    // smoke run lends its own Node for the fake helper. Honoured only under smoke.
    const node = process.env.APEX_SMOKE === '1' ? process.env.APEX_SMOKE_NODE : undefined
    if (node) return { file: node, args: [helper, ...args], env: { ...process.env } }
    return { file: process.execPath, args: [helper, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { file: helper, args, env: process.env }
}

export type HelperRunner = (args: string[], timeoutMs: number) => Promise<HelperLine[]>

export function helperRunner(helper: string): HelperRunner {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      const cmd = command(helper, args)
      execFile(cmd.file, cmd.args, { env: cmd.env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error && !stdout) return reject(new Error(error.killed ? 'The Calendar helper took too long.' : 'The Calendar helper could not run.'))
        const lines = parseHelperOutput(String(stdout))
        const failure = lines.find((l): l is Extract<HelperLine, { type: 'error' }> => l.type === 'error')
        if (failure) return reject(new Error(failure.message))
        resolve(lines)
      })
    })
}

// ── The service ──

interface CalendarFile {
  enabled: { events: boolean; reminders: boolean }
}

const DEFAULT_FILE: CalendarFile = { enabled: { events: false, reminders: false } }

export interface CalendarDeps {
  dataDir: string
  /** The helper's path, or null when it is missing (the unavailable state). Read on each use, so smoke can point it at the fake. */
  helper(): string | null
  /** Tests: answers instead of a helper process. */
  run?: HelperRunner
  broadcast(event: { type: 'calendar'; status: CalendarStatus }): void
  openExternal(url: string): void
  /** The meetings seam: the source while events are readable, null otherwise. */
  setSource(source: CalendarSource | null): void
  /** The calendar-watch experiment: keep the helper listening for changes. */
  watch?: boolean
  now?: () => number
}

const PRIVACY_PANES: Record<CalendarKind, string> = {
  events: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  reminders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders',
}

const HELPER_TIMEOUT_MS = 10_000
/** The permission prompt waits on the person. */
const REQUEST_TIMEOUT_MS = 120_000
const POLL_MS = 60_000
/** How far ahead the meeting-soon check reads. */
const LOOKAHEAD_MS = 15 * 60_000

export class CalendarService extends EventEmitter<{ 'meeting-soon': [event: CalendarEvent] }> implements CalendarSource, CalendarApi {
  readonly #deps: CalendarDeps
  readonly #path: string
  #file: CalendarFile
  #permissions: { events: CalendarPermission; reminders: CalendarPermission } = { events: 'not-determined', reminders: 'not-determined' }
  #timer: ReturnType<typeof setInterval> | null = null
  #watcher: ChildProcess | null = null
  /** Events already announced as soon, so each fires once. */
  readonly #announced = new Set<string>()

  constructor(deps: CalendarDeps) {
    super()
    this.#deps = deps
    this.#path = join(deps.dataDir, 'calendar.json')
    this.#file = this.#load()
  }

  /** How to ask the helper, or null without one. */
  get #run(): HelperRunner | null {
    if (this.#deps.run) return this.#deps.run
    const helper = this.#deps.helper()
    return helper ? helperRunner(helper) : null
  }

  #load(): CalendarFile {
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<CalendarFile>
      return { enabled: { events: raw.enabled?.events === true, reminders: raw.enabled?.reminders === true } }
    } catch {
      return structuredClone(DEFAULT_FILE)
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #snapshot(): CalendarStatus {
    return { available: this.#run !== null, ...this.#permissions, enabled: { ...this.#file.enabled } }
  }

  /** Reads the permissions again and applies them: the source, the poll, and the broadcast. */
  async status(): Promise<CalendarStatus> {
    const run = this.#run
    if (run) {
      try {
        const line = (await run(['status'], HELPER_TIMEOUT_MS)).find((l) => l.type === 'status')
        if (line && line.type === 'status') this.#permissions = { events: line.events, reminders: line.reminders }
      } catch (err) {
        log.warn('calendar', 'status check failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return this.#apply()
  }

  #apply(): CalendarStatus {
    const status = this.#snapshot()
    const events = calendarReadable(status, 'events')
    this.#deps.setSource(events ? this : null)
    if (events && !this.#timer) {
      this.#timer = setInterval(() => void this.#checkSoon(), POLL_MS)
      this.#timer.unref?.()
      void this.#checkSoon()
      if (this.#deps.watch) this.#startWatch()
    } else if (!events) this.#stopTimers()
    this.#deps.broadcast({ type: 'calendar', status })
    return status
  }

  async requestAccess(kind: CalendarKind): Promise<CalendarStatus> {
    const run = this.#run
    if (!run) throw new Error(`The Calendar helper is not part of this build of ${BRAND_NAME}.`)
    const lines = await run(['request', kind], REQUEST_TIMEOUT_MS)
    const line = lines.find((l) => l.type === 'status')
    if (line && line.type === 'status') this.#permissions = { events: line.events, reminders: line.reminders }
    // Asking is a clear yes to using it; switch the kind on once macOS grants it.
    if (this.#permissions[kind] === 'granted') this.#setFile(kind, true)
    return this.#apply()
  }

  async setEnabled(kind: CalendarKind, on: boolean): Promise<CalendarStatus> {
    this.#setFile(kind, on)
    return this.status()
  }

  #setFile(kind: CalendarKind, on: boolean): void {
    this.#file = { enabled: { ...this.#file.enabled, [kind]: on } }
    writeAtomic(this.#path, JSON.stringify(this.#file, null, 2))
  }

  /** Whether a kind is readable right now (the client tools' check). */
  readable(kind: CalendarKind): boolean {
    return calendarReadable(this.#snapshot(), kind)
  }

  /** Whether a kind is switched on in Apex (permission aside), for offering its tool. */
  enabled(kind: CalendarKind): boolean {
    return this.#run !== null && this.#file.enabled[kind]
  }

  async upcoming(range: { from: number; to: number }): Promise<CalendarEvent[]>
  async upcoming(withinMs: number): Promise<CalendarEvent[]>
  async upcoming(arg: { from: number; to: number } | number): Promise<CalendarEvent[]> {
    const now = this.#now()
    // The meetings CalendarSource asks with a window from now; the service asks with a range.
    const range = typeof arg === 'number' ? { from: now, to: now + Math.max(0, arg) } : arg
    if (range.to < range.from) throw new Error('The range ends before it starts.')
    if (range.to - range.from > CALENDAR_RANGE_MAX_MS) throw new Error('Ask for at most two months at a time.')
    const run = this.#run
    if (!run || !this.readable('events')) return []
    const lines = await run(['events', '--from', String(Math.floor(range.from)), '--to', String(Math.ceil(range.to))], HELPER_TIMEOUT_MS)
    return lines
      .filter((l): l is Extract<HelperLine, { type: 'event' }> => l.type === 'event')
      .map(toEvent)
      .filter((e) => e.endsAt >= range.from && e.startsAt <= range.to)
      .sort((a, b) => a.startsAt - b.startsAt)
      .slice(0, CALENDAR_ITEMS_MAX)
  }

  async reminders(): Promise<Reminder[]> {
    const run = this.#run
    if (!run || !this.readable('reminders')) return []
    const lines = await run(['reminders'], HELPER_TIMEOUT_MS)
    return lines
      .filter((l): l is Extract<HelperLine, { type: 'reminder' }> => l.type === 'reminder')
      .map(({ id, title, dueAt, list, completed }) => ({ id, title: title || 'Untitled reminder', dueAt, list, completed }))
      .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER))
      .slice(0, CALENDAR_ITEMS_MAX)
  }

  openPrivacySettings(kind: CalendarKind): void {
    this.#deps.openExternal(PRIVACY_PANES[kind])
  }

  /** Announces each timed event once, when it is about to start (the meeting card and alert listen). */
  async #checkSoon(): Promise<void> {
    try {
      const now = this.#now()
      const events = await this.upcoming({ from: now, to: now + LOOKAHEAD_MS })
      for (const event of soonEvents(events, now, this.#announced)) {
        this.#announced.add(event.id + ':' + event.startsAt)
        this.emit('meeting-soon', event)
      }
    } catch (err) {
      log.warn('calendar', 'upcoming check failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** The calendar-watch experiment: the helper stays open and prints `changed` when the store changes. */
  #startWatch(): void {
    const helper = this.#deps.helper()
    if (this.#watcher || !helper) return
    const cmd = command(helper, ['watch'])
    const child = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: ['ignore', 'pipe', 'ignore'] })
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (parseHelperOutput(lines.join('\n')).some((l) => l.type === 'changed')) void this.#checkSoon()
    })
    child.on('exit', () => {
      if (this.#watcher === child) this.#watcher = null
    })
    this.#watcher = child
  }

  #stopTimers(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#watcher?.kill()
    this.#watcher = null
  }

  dispose(): void {
    this.#stopTimers()
    this.#deps.setSource(null)
  }
}

/** Timed events starting within MEETING_SOON_MS that haven't been announced (all-day ones never are). */
export function soonEvents(events: readonly CalendarEvent[], now: number, announced: ReadonlySet<string>): CalendarEvent[] {
  return events.filter((e) => !e.allDay && e.startsAt >= now - 60_000 && e.startsAt - now <= MEETING_SOON_MS && !announced.has(e.id + ':' + e.startsAt))
}
