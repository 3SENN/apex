/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RoutineSchedule } from '@shared/services'
import { t } from '@shared/i18n/core'
import { formatWeekday } from '@shared/i18n/format'

// Routine schedules as the card shows and edits them. Main validates again
// (validateSchedule in src/main/stores.ts); these mirror its rules so the
// form can explain a problem before saving.

export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5]
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export function dayLabel(day: number): string {
  return formatWeekday(day)
}

/** Hours for an interval schedule in either shape: the older `hours` or the newer `minutes`. */
function intervalHours(schedule: Extract<RoutineSchedule, { kind: 'interval' }>): number {
  return 'hours' in schedule ? schedule.hours : schedule.minutes / 60
}

function dayList(input: readonly number[]): number[] {
  return [...new Set(input)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b)
}

function describeDays(days: readonly number[], at: string): string {
  if (days.length === 0 || days.length === 7) return t('coCard.schedule.everyDay', { at })
  if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) return t('coCard.schedule.weekdays', { at })
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return t('coCard.schedule.weekends', { at })
  const names = days.map(dayLabel)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${list} ${at}`
}

/** "Every day at 08:30", "Weekdays at 09:00", "Mon and Thu at 18:00", "Every 6 hours", "Every 30 minutes". */
export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case 'interval': {
      const hours = intervalHours(schedule)
      if (hours < 1) return t('coCard.schedule.everyMinutes', { value: Math.round(hours * 60) })
      return hours === 1 ? t('coCard.schedule.everyHour') : t('coCard.schedule.everyHours', { value: Number.isInteger(hours) ? hours : hours.toFixed(1) })
    }
    case 'cron':
      return t('coCard.schedule.customSchedule', { expr: schedule.expr })
    case 'once':
      return t('coCard.schedule.once', { value: new Date(schedule.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) })
    case 'daily':
      return describeDays(dayList(schedule.days), `at ${schedule.time}`)
  }
}

export interface ScheduleForm {
  kind: 'daily' | 'interval'
  time: string
  /** Empty means every day. */
  days: number[]
  hours: number
}

export const DEFAULT_SCHEDULE_FORM: ScheduleForm = { kind: 'daily', time: '09:00', days: [], hours: 24 }

/** The card edits daily and interval schedules; a custom or one-off one opens as the default form. */
export function scheduleToForm(schedule: RoutineSchedule): ScheduleForm {
  if (schedule.kind === 'daily') return { ...DEFAULT_SCHEDULE_FORM, kind: 'daily', time: schedule.time, days: [...schedule.days] }
  if (schedule.kind === 'interval') return { ...DEFAULT_SCHEDULE_FORM, kind: 'interval', hours: Math.max(1, Math.round(intervalHours(schedule))) }
  return { ...DEFAULT_SCHEDULE_FORM }
}

/** The schedule a form describes, or a sentence saying what to fix. */
export function formToSchedule(form: ScheduleForm): { schedule: RoutineSchedule } | { error: string } {
  if (form.kind === 'interval') {
    const hours = Math.round(form.hours)
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return { error: t('coCard.schedule.chooseBetween1And') }
    return { schedule: { kind: 'interval', hours } }
  }
  if (!TIME.test(form.time)) return { error: t('coCard.schedule.useA24Hour') }
  const days = [...new Set(form.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b)
  return { schedule: { kind: 'daily', time: form.time, days: days.length === 7 ? [] : days } }
}

export function toggleDay(days: readonly number[], day: number): number[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b)
}
