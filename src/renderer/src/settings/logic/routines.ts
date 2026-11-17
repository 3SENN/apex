/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Routine wording, countdowns, validation and ordering for the Routines page.
import type { Routine, RoutineSchedule } from '@shared/services'
import type * as D from '@shared/routines'
import { isPastRoutine } from '@shared/routines'
import { formatDuration } from '../../ui/logic/time'
import { t } from '@shared/i18n/core'
import { formatWeekday } from '@shared/i18n/format'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** "08:30" in the locale's clock ("8:30 AM", "08:30"); unparseable input comes back as is. */
export function formatClock(time: string, locale?: string): string {
  if (!TIME.test(time)) return time
  const [h, m] = time.split(':').map(Number)
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(locale, { timeStyle: 'short' })
}

/** Which days a daily routine runs, in words. */
export function describeDays(days: readonly number[]): string {
  const set = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b)
  if (set.length === 0 || set.length === 7) return t('settings.routines.everyDay')
  if (set.join() === '1,2,3,4,5') return t('settings.routines.weekdays')
  if (set.join() === '0,6') return t('settings.routines.weekends')
  // Week starts on Monday in the label, so Sunday goes last.
  const ordered = [...set.filter((d) => d !== 0), ...set.filter((d) => d === 0)]
  return ordered.map((d) => formatWeekday(d)).join(', ')
}

/** Hours between runs for either interval shape (the old `hours`, or the newer `minutes`). */
export function intervalHours(schedule: Extract<RoutineSchedule, { kind: 'interval' }>): number {
  return 'hours' in schedule ? schedule.hours : schedule.minutes / 60
}

export function describeSchedule(schedule: RoutineSchedule, locale?: string): string {
  switch (schedule.kind) {
    case 'interval': {
      const hours = intervalHours(schedule)
      if (hours < 1) return t('settings.routines.everyMinutes', { value: Math.round(hours * 60) })
      return hours === 1 ? t('settings.routines.everyHour') : t('settings.routines.everyHours', { value: Number(hours.toFixed(2)) })
    }
    case 'cron':
      return t('settings.routines.onACustomSchedule', { expr: schedule.expr })
    case 'once':
      return t('settings.routines.once', { value: new Date(schedule.at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })
    default:
      return t('settings.routines.at', { value: describeDays(schedule.days), time: formatClock(schedule.time, locale) })
  }
}

/**
 * The countdown on a routine row: "Paused", "Due now", "Next run in 2 h 5 min",
 * or a weekday and time once it is more than a day away.
 */
export function nextRunLabel(routine: Pick<Routine, 'enabled' | 'nextRunAt'>, now: number, locale?: string): string {
  if (!routine.enabled) return t('settings.routines.paused')
  if (routine.nextRunAt === null) return t('settings.routines.notScheduled')
  const wait = routine.nextRunAt - now
  if (wait <= 60_000) return t('settings.routines.dueNow')
  if (wait < DAY) return t('settings.routines.nextRunIn', { wait: formatDuration(wait) })
  const at = new Date(routine.nextRunAt)
  const day = at.toLocaleDateString(locale, wait < 6 * DAY ? { weekday: 'long' } : { month: 'short', day: 'numeric' })
  return t('settings.routines.nextRunAt', { day, value: at.toLocaleTimeString(locale, { timeStyle: 'short' }) })
}

/** The same checks main makes, so the editor can point at the field before saving. */
export function scheduleError(schedule: RoutineSchedule): string | null {
  if (schedule.kind === 'interval') {
    const hours = intervalHours(schedule)
    if (!('hours' in schedule)) return Number.isFinite(schedule.minutes) && schedule.minutes > 0 ? null : t('settings.routines.chooseHowOftenIt')
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return t('settings.routines.chooseAWholeNumber')
    return null
  }
  if (schedule.kind === 'cron') return schedule.expr.trim() ? null : t('settings.routines.enterASchedule')
  if (schedule.kind === 'once') return Number.isFinite(schedule.at) ? null : t('settings.routines.chooseADateAnd')
  if (!TIME.test(schedule.time)) return t('settings.routines.chooseATimeSuch')
  return null
}

export interface RoutineDraft {
  id?: string
  name: string
  prompt: string
  schedule: RoutineSchedule
  enabled: boolean
  owner: string
}

/** Field-level problems in a draft, empty when it can be saved. */
export function routineDraftErrors(draft: Pick<RoutineDraft, 'name' | 'prompt' | 'schedule'>): Partial<Record<'name' | 'prompt' | 'schedule', string>> {
  const errors: Partial<Record<'name' | 'prompt' | 'schedule', string>> = {}
  if (!draft.name.trim()) errors.name = t('settings.routines.giveTheRoutineA')
  if (!draft.prompt.trim()) errors.prompt = t('settings.routines.sayWhatTheRoutine')
  const schedule = scheduleError(draft.schedule)
  if (schedule) errors.schedule = schedule
  return errors
}

export type RoutineStatusFilter = 'all' | 'active' | 'paused'
export type RoutineSort = 'next' | 'name'

export function matchesStatus(routine: Pick<Routine, 'enabled'>, filter: RoutineStatusFilter): boolean {
  return filter === 'all' || (filter === 'active') === routine.enabled
}

/** 'next': active routines soonest first, then paused ones by name. 'name': alphabetical. */
export function sortRoutines<T extends Pick<Routine, 'name' | 'enabled' | 'nextRunAt'>>(routines: readonly T[], sort: RoutineSort): T[] {
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  if (sort === 'name') return [...routines].sort(byName)
  const rank = (r: T): number => (r.enabled ? (r.nextRunAt ?? Number.MAX_SAFE_INTEGER) : Number.POSITIVE_INFINITY)
  return [...routines].sort((a, b) => rank(a) - rank(b) || byName(a, b))
}

/** A fresh draft: weekday mornings, active. */
export function newRoutineDraft(owner: string): RoutineDraft {
  return { name: '', prompt: '', schedule: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, enabled: true, owner }
}

// ---- past runs ----

export type RunStatus = 'working' | 'needs-input' | 'error' | 'unread' | 'success' | 'idle'

/** What a routine run's chat is showing, most urgent first. */
export function runStatus(chat: { status: string; unread: boolean; needsInput: boolean }): RunStatus {
  if (chat.status === 'running') return 'working'
  if (chat.status === 'needs-approval' || chat.needsInput) return 'needs-input'
  if (chat.status === 'error') return 'error'
  if (chat.unread) return 'unread'
  return chat.status === 'finished' ? 'success' : 'idle'
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  get working() { return t('settings.routines.running') },
  get 'needs-input'() { return t('settings.routines.needsYou') },
  get error() { return t('settings.routines.failed') },
  get unread() { return t('settings.routines.newResult') },
  get success() { return t('settings.routines.done') },
  get idle() { return t('settings.routines.done') },
}

export const DATE_GROUP_LABEL = { get today() { return t('settings.routines.today') }, get yesterday() { return t('settings.routines.yesterday') }, get week() { return t('settings.routines.earlierThisWeek') }, get month() { return t('settings.routines.thisMonth') }, get older() { return t('settings.routines.older') } } as const

/** Runs of one routine (or all), newest first, at most `limit`. */
export function runsOf<T extends { routineId: string | null; lastActiveAt: number }>(chats: readonly T[], routineId: string | null, limit = Number.POSITIVE_INFINITY): T[] {
  return chats
    .filter((c) => c.routineId !== null && (routineId === null || c.routineId === routineId))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, limit)
}

/** A starter on the Routines page's suggestion grid (DS-102): Atelier's own ideas, opened as a filled-in draft. */
export interface RoutineSuggestion {
  id: string
  name: string
  description: string
  prompt: string
  schedule: RoutineSchedule
}

export const ROUTINE_SUGGESTIONS: readonly RoutineSuggestion[] = [
  {
    id: 'morning-brief',
    get name() { return t('settings.routines.morningBrief') },
    get description() { return t('settings.routines.aShortReadOf') },
    get prompt() { return t('settings.routines.putTogetherAShort') },
    schedule: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] },
  },
  {
    id: 'price-watch',
    get name() { return t('settings.routines.priceWatch') },
    get description() { return t('settings.routines.checksAProductPage') },
    get prompt() { return t('settings.routines.checkThePriceOn') },
    schedule: { kind: 'daily', time: '12:00', days: [0, 1, 2, 3, 4, 5, 6] },
  },
  {
    id: 'weekly-review',
    get name() { return t('settings.routines.weeklyReview') },
    get description() { return t('settings.routines.looksBackOverThe') },
    get prompt() { return t('settings.routines.lookBackOverThis') },
    schedule: { kind: 'daily', time: '17:00', days: [5] },
  },
  {
    id: 'reading-list',
    get name() { return t('settings.routines.readingListDigest') },
    get description() { return t('settings.routines.sumsUpThePages') },
    get prompt() { return t('settings.routines.summariseThePagesI') },
    schedule: { kind: 'daily', time: '19:00', days: [0] },
  },
]

/** Suggestions still worth showing: not dismissed and not already set up under the same name. */
export function visibleSuggestions(dismissed: ReadonlySet<string>, routines: ReadonlyArray<{ name: string }>): RoutineSuggestion[] {
  const names = new Set(routines.map((r) => r.name.trim().toLowerCase()))
  return ROUTINE_SUGGESTIONS.filter((s) => !dismissed.has(s.id) && !names.has(s.name.toLowerCase()))
}

/** A suggestion as a draft for the editor. */
export function suggestionDraft(suggestion: RoutineSuggestion, owner: string): RoutineDraft {
  return { name: suggestion.name, prompt: suggestion.prompt, schedule: structuredClone(suggestion.schedule), enabled: true, owner }
}


/** Every 30 minutes up to once a day (SK-08). */
export const INTERVAL_CHOICES: readonly number[] = [30, 60, 120, 180, 240, 360, 480, 720, 1440]

export type DayPreset = 'every' | 'weekdays' | 'weekends' | 'custom'

export function dayPresetOf(days: readonly number[]): DayPreset {
  const set = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b).join()
  if (set === '' || set === '0,1,2,3,4,5,6') return 'every'
  if (set === '1,2,3,4,5') return 'weekdays'
  if (set === '0,6') return 'weekends'
  return 'custom'
}

export function presetDays(preset: Exclude<DayPreset, 'custom'>): number[] {
  return preset === 'weekdays' ? [1, 2, 3, 4, 5] : preset === 'weekends' ? [0, 6] : []
}

/** "Every 30 minutes", "Every hour", "Every 2 hours", "Once a day". */
export function intervalLabel(minutes: number): string {
  if (minutes >= 1440) return t('settings.routines.onceADay')
  if (minutes < 60) return t('settings.routines.everyMinutes2', { minutes })
  const hours = minutes / 60
  return hours === 1 ? t('settings.routines.everyHour') : t('settings.routines.everyHours', { value: Number(hours.toFixed(2)) })
}

/** "09:00" for hour 9, "24:00" for the end of the day, in the locale's clock. */
export function hourLabel(hour: number, locale?: string): string {
  if (hour >= 24) return 'midnight'
  return formatClock(`${String(hour).padStart(2, '0')}:00`, locale)
}

/** A minute of the day in the locale's clock: 540 → "09:00"; 1440 is midnight. */
export function minuteLabel(minute: number, locale?: string): string {
  if (minute >= 1440) return 'midnight'
  return formatClock(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, locale)
}

/** Whether the locale reads a 12-hour clock (SK-08 shows times that way). */
export function uses12Hour(locale?: string): boolean {
  try {
    const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle
    return cycle === 'h11' || cycle === 'h12'
  } catch {
    return false
  }
}

// ---- time zones ----

/** Every IANA zone the runtime knows, for the searchable picker. */
export function timeZoneList(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['UTC']
  }
}

/** The zone the system uses. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** "Europe/Amsterdam" → "Amsterdam (Europe)"; underscores read as spaces. */
export function timeZoneLabel(zone: string): string {
  const parts = zone.split('/')
  const city = (parts.pop() ?? zone).replace(/_/g, ' ')
  return parts.length ? `${city} (${parts.join(' / ').replace(/_/g, ' ')})` : city
}

/** Zones whose name has every word of the query, at most `limit`. */
export function searchTimeZones(zones: readonly string[], query: string, limit = 50): string[] {
  const words = query.toLowerCase().replace(/_/g, ' ').split(/[\s/,]+/).filter(Boolean)
  const out: string[] = []
  for (const zone of zones) {
    const text = zone.toLowerCase().replace(/_/g, ' ')
    if (words.every((w) => text.includes(w))) out.push(zone)
    if (out.length >= limit) break
  }
  return out
}

// ---- wall times in a zone (one-off tasks pick a date and time there) ----

function zoneOffset(ts: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ts)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ts / 1000) * 1000
}

/** The instant a wall date and time ('2026-11-02', '08:30') happens in a zone (null: the system's). */
export function wallToEpoch(date: string, time: string, zone: string | null): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!d || !TIME.test(time)) return null
  const [hh = 0, mm = 0] = time.split(':').map(Number)
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])]
  const real = new Date(Date.UTC(y, m - 1, day))
  if (real.getUTCMonth() !== m - 1 || real.getUTCDate() !== day) return null
  if (!zone) return new Date(y, m - 1, day, hh, mm).getTime()
  try {
    const local = Date.UTC(y, m - 1, day, hh, mm)
    const guess = local - zoneOffset(local, zone)
    return local - zoneOffset(guess, zone)
  } catch {
    return null
  }
}

/** A moment as the wall date and time of a zone: ['2026-11-02', '08:30']. */
export function epochToWall(ts: number, zone: string | null): [string, string] {
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (!zone) {
    const d = new Date(ts)
    return [`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, `${pad(d.getHours())}:${pad(d.getMinutes())}`]
  }
  const shifted = new Date(ts + zoneOffset(ts, zone))
  return [`${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`, `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`]
}

// ---- the timing form ----

export type TimingKind = 'daily' | 'interval' | 'cron' | 'once'

/** Everything the timing field edits; only the chosen kind's fields count. */
export interface TimingForm {
  kind: TimingKind
  time: string
  /** Daily days; empty means every day. */
  days: number[]
  minutes: number
  /** Interval: only between these hours. */
  windowOn: boolean
  start: number
  end: number
  /** Interval days; empty means every day. */
  intervalDays: number[]
  expr: string
  date: string
  onceTime: string
}

/** A fresh form: weekday mornings. A one-off defaults to tomorrow at nine. */
export function defaultTiming(now = Date.now(), zone: string | null = null): TimingForm {
  const [date] = epochToWall(now + DAY, zone)
  return { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5], minutes: 60, windowOn: false, start: 9, end: 17, intervalDays: [], expr: '0 9 * * 1-5', date, onceTime: '09:00' }
}

/** The form for a saved schedule; the old hourly interval reads as minutes. */
export function timingFromSchedule(schedule: RoutineSchedule, zone: string | null, now = Date.now()): TimingForm {
  const form = defaultTiming(now, zone)
  switch (schedule.kind) {
    case 'daily':
      return { ...form, kind: 'daily', time: schedule.time, days: [...schedule.days] }
    case 'interval': {
      if ('hours' in schedule) return { ...form, kind: 'interval', minutes: Math.min(1440, schedule.hours * 60) }
      // The window is stored in minutes of the day; the form picks whole hours.
      const b = schedule.between
      return { ...form, kind: 'interval', minutes: schedule.minutes, windowOn: Boolean(b), start: b ? Math.floor(b.start / 60) : form.start, end: b ? Math.ceil(b.end / 60) : form.end, intervalDays: [...(schedule.days ?? [])] }
    }
    case 'cron':
      return { ...form, kind: 'cron', expr: schedule.expr }
    case 'once': {
      const [date, onceTime] = epochToWall(schedule.at, zone)
      return { ...form, kind: 'once', date, onceTime }
    }
  }
}

const cleanDays = (days: readonly number[]): number[] => {
  const set = [...new Set(days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b)
  return set.length === 7 ? [] : set
}

/** The schedule a timing form describes, or a sentence saying what to fix. */
export function timingToSchedule(form: TimingForm, zone: string | null, now = Date.now()): { schedule: D.RoutineSchedule } | { error: string } {
  switch (form.kind) {
    case 'daily':
      if (!TIME.test(form.time)) return { error: t('settings.routines.chooseATimeSuch') }
      return { schedule: { kind: 'daily', time: form.time, days: cleanDays(form.days) } }
    case 'interval': {
      if (!Number.isInteger(form.minutes) || form.minutes < 30 || form.minutes > 1440) return { error: t('settings.routines.chooseEvery30Minutes') }
      if (form.windowOn && !(form.start >= 0 && form.end <= 24 && form.start < form.end)) return { error: t('settings.routines.theHoursHaveTo') }
      const days = cleanDays(form.intervalDays)
      return { schedule: { kind: 'interval', minutes: form.minutes, ...(form.windowOn ? { between: { start: form.start * 60, end: form.end * 60 } } : {}), ...(days.length ? { days } : {}) } }
    }
    case 'cron': {
      const expr = form.expr.trim().replace(/\s+/g, ' ')
      if (!expr) return { error: t('settings.routines.enterAScheduleSuch') }
      if (expr.split(' ').length !== 5 && !expr.startsWith('@')) return { error: t('settings.routines.useFiveFieldsMinute') }
      return { schedule: { kind: 'cron', expr } }
    }
    case 'once': {
      const at = wallToEpoch(form.date, form.onceTime, zone)
      if (at === null) return { error: t('settings.routines.pickADateAnd') }
      if (at <= now) return { error: t('settings.routines.pickATimeIn') }
      return { schedule: { kind: 'once', at } }
    }
  }
}

// ---- the editor as a whole ----

export interface RoutineEditorForm {
  name: string
  /** A companion id, or 'shared' (runs as the active companion). '' until one is picked. */
  companionId: string
  /** 'prompt': typed instructions; 'skill': a skill, with optional extra words. */
  task: 'prompt' | 'skill'
  prompt: string
  skillId: string
  timing: TimingForm
  timeZone: string | null
  destination: 'new-chat' | 'append'
  chatId: string
  enabled: boolean
  /** DC-07: "Only tell me if…" (empty: every run notifies). */
  notifyIf: string
}

export type RoutineEditorField = 'name' | 'companion' | 'task' | 'timing' | 'destination'

/** Each missing or wrong field's own message (SK-07); empty when it can be saved. */
export function routineEditorErrors(
  form: RoutineEditorForm,
  ctx: { companionExists(id: string): boolean; skillExists(id: string): boolean; now?: number },
): Partial<Record<RoutineEditorField, string>> {
  const errors: Partial<Record<RoutineEditorField, string>> = {}
  if (!form.name.trim()) errors.name = t('settings.routines.giveTheRoutineA')
  if (!form.companionId || (form.companionId !== 'shared' && !ctx.companionExists(form.companionId))) errors.companion = t('settings.routines.pickACompanionTo')
  if (form.task === 'skill') {
    if (!form.skillId) errors.task = t('settings.routines.pickASkillTo')
    else if (!ctx.skillExists(form.skillId)) errors.task = t('settings.routines.thatSkillNoLonger')
  } else if (!form.prompt.trim()) errors.task = t('settings.routines.sayWhatTheRoutine')
  const timing = timingToSchedule(form.timing, form.timeZone, ctx.now)
  if ('error' in timing) errors.timing = timing.error
  if (form.destination === 'append' && !form.chatId) errors.destination = t('settings.routines.pickTheChatTo')
  return errors
}

/** What `routines.save` gets from a valid form. */
export function routineEditorInput(form: RoutineEditorForm, extra: { id?: string; revision?: number; now?: number }): D.RoutineSaveInput | null {
  const timing = timingToSchedule(form.timing, form.timeZone, extra.now)
  if ('error' in timing) return null
  return {
    ...(extra.id ? { id: extra.id } : {}),
    ...(extra.revision !== undefined ? { revision: extra.revision } : {}),
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    ...(form.task === 'skill' && form.skillId ? { skillId: form.skillId } : {}),
    schedule: timing.schedule,
    companionId: form.companionId,
    destination: form.destination === 'append' && form.chatId ? { kind: 'append', chatId: form.chatId } : { kind: 'new-chat' },
    timeZone: form.timeZone,
    notifyIf: form.notifyIf.trim(),
    enabled: form.enabled,
  }
}

/** The form for a saved routine, or for a draft (a proposal card, a suggestion, a guide). */
export function routineEditorForm(source: { routine?: D.Routine | null; draft?: D.RoutineDraft | null; fallbackCompanion: string; now?: number }): RoutineEditorForm {
  const r = source.routine
  const d = source.draft
  const zone = r ? r.timeZone : (d?.timeZone ?? null)
  const schedule = r?.schedule ?? d?.schedule
  const destination = r?.destination ?? d?.destination ?? { kind: 'new-chat' as const }
  const skillId = r?.skillId ?? d?.skillId ?? ''
  return {
    name: r?.name ?? d?.name ?? '',
    companionId: r ? (r.needsCompanion ? '' : r.owner) : (d?.companionId ?? source.fallbackCompanion),
    task: skillId ? 'skill' : 'prompt',
    prompt: r?.prompt ?? d?.prompt ?? '',
    skillId,
    timing: schedule ? timingFromSchedule(schedule, zone, source.now) : defaultTiming(source.now, zone),
    timeZone: zone,
    destination: destination.kind,
    chatId: destination.kind === 'append' ? destination.chatId : '',
    enabled: r?.enabled ?? true,
    notifyIf: r?.notifyIf ?? d?.notifyIf ?? '',
  }
}

/** The editor's sentence (SK-07): "Every weekday at 8:00 AM, Ava runs /weekly-review." */
export function routineSentence(parts: { when: string; who: string; skillName: string | null; prompt: string }): string {
  const what = parts.skillName ? `runs /${parts.skillName}` : parts.prompt.trim() ? 'does this' : 'does…'
  return `${parts.when}, ${parts.who} ${what}.`
}

/** A schedule in words, with the zone when it is not the system's. */
export function describeTiming(schedule: RoutineSchedule, zone: string | null, locale?: string): string {
  let text: string
  if (schedule.kind === 'interval' && !('hours' in schedule)) {
    text = intervalLabel(schedule.minutes)
    if (schedule.between) text += t('settings.routines.betweenAnd', { value: minuteLabel(schedule.between.start, locale), value2: minuteLabel(schedule.between.end, locale) })
    if (schedule.days?.length) {
      const days = describeDays(schedule.days)
      text += days === t('settings.routines.everyDay') ? '' : days === t('settings.routines.weekdays') ? t('settings.routines.onWeekdays') : days === t('settings.routines.weekends') ? t('settings.routines.onWeekends') : t('settings.routines.onDays', { days })
    }
  } else if (schedule.kind === 'cron') {
    text = t('settings.routines.custom', { expr: schedule.expr })
  } else if (schedule.kind === 'once') {
    text = t('settings.routines.once', { value: new Date(schedule.at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', ...(zone ? { timeZone: zone } : {}) }) })
  } else {
    text = describeSchedule(schedule, locale)
  }
  return zone && zone !== localTimeZone() ? `${text} (${timeZoneLabel(zone)})` : text
}

/** One run time for the preview and the detail page, read in the routine's zone: "Mon 2 Nov, 08:00". */
export function formatRunTime(at: number, zone: string | null, locale?: string): string {
  try {
    return new Date(at).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) })
  } catch {
    return new Date(at).toLocaleString(locale)
  }
}

// ---- run records ----

export const RUN_RECORD_LABEL: Record<D.RoutineRunStatus, string> = {
  get running() { return t('settings.routines.running') },
  get ok() { return t('settings.routines.done') },
  get error() { return t('settings.routines.failed') },
  get 'needs-input'() { return t('settings.routines.needsYou') },
  get stopped() { return t('settings.routines.stopped') },
}

export const RUN_TRIGGER_LABEL: Record<D.RoutineTrigger, string> = {
  get schedule() { return t('settings.routines.onSchedule') },
  get manual() { return t('settings.routines.runNow') },
  get 'catch-up'() { return t('settings.routines.caughtUpAfterAtelier') },
}

/** The StatusDot a run record shows; unread finished runs are marked. */
export function runRecordDot(run: Pick<D.RoutineRun, 'status' | 'read'>): RunStatus {
  if (run.status === 'running') return 'working'
  if (run.status === 'needs-input') return 'needs-input'
  if (run.status === 'error') return 'error'
  if (!run.read) return 'unread'
  return run.status === 'ok' ? 'success' : 'idle'
}

/** Routines split for the page: the live list, and finished one-off tasks under Past (SK-10). */
export function splitPast<T extends Pick<D.Routine, 'schedule' | 'lastRunAt' | 'nextRunAt'>>(routines: readonly T[]): { current: T[]; past: T[] } {
  const current: T[] = []
  const past: T[] = []
  for (const r of routines) (isPastRoutine(r) ? past : current).push(r)
  return { current, past }
}
