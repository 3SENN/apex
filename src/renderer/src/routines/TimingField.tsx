/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// When a routine runs (SK-08): daily at a time on every day, weekdays,
// weekends or chosen days; every 30 minutes to a day, optionally only
// between set hours and on set days; a five-field cron expression with its
// own check; or once at a date and time.
import { useId, type ReactElement } from 'react'
import { useT } from '../i18n/useT'
import { SegmentedControl, Select, Switch } from '../ui'
import { Field, TextInput } from '../settings/kit'
import { toggleDay } from '../companion-card/logic/schedule'
import { INTERVAL_CHOICES, dayPresetOf, hourLabel, intervalLabel, presetDays, type DayPreset, type TimingForm, type TimingKind } from '../settings/logic/routines'
import { formatWeekday } from '@shared/i18n/format'

// Monday first, as people read a week.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export interface TimingFieldProps {
  form: TimingForm
  onChange(form: TimingForm): void
  error?: string | null
  /** The cron check from main: null while checking or for other kinds. */
  cronCheck?: { ok: true } | { ok: false; error: string } | null
  locale?: string
}

function DayToggles({ days, onChange, label }: { days: number[]; onChange(days: number[]): void; label: string }): ReactElement {
  return (
    <div className="sp-days" role="group" aria-label={label}>
      {DAY_ORDER.map((d) => (
        <button key={d} type="button" className="sp-day" aria-pressed={days.includes(d)} aria-label={formatWeekday(d, 'long')} title={formatWeekday(d, 'long')} onClick={() => onChange(toggleDay(days, d))}>
          {formatWeekday(d, 'long').slice(0, 2)}
        </button>
      ))}
    </div>
  )
}

export function TimingField({ form, onChange, error, cronCheck = null, locale }: TimingFieldProps): ReactElement {
  const t = useT()
  const ids = { time: useId(), minutes: useId(), from: useId(), to: useId(), expr: useId(), date: useId(), onceTime: useId(), hint: useId() }
  const set = (patch: Partial<TimingForm>): void => onChange({ ...form, ...patch })
  const preset = dayPresetOf(form.days)
  const kinds: Array<{ value: TimingKind; label: string }> = [
    { value: 'daily', label: t('skills.timing.daily') },
    { value: 'interval', label: t('skills.timing.interval') },
    { value: 'cron', label: t('skills.timing.cron') },
    { value: 'once', label: t('skills.timing.once') },
  ]
  const presets: Array<{ value: DayPreset; label: string }> = [
    { value: 'every', label: t('skills.timing.every') },
    { value: 'weekdays', label: t('skills.timing.weekdays') },
    { value: 'weekends', label: t('skills.timing.weekends') },
    { value: 'custom', label: t('skills.timing.custom') },
  ]
  const hours = Array.from({ length: 25 }, (_, h) => h)
  return (
    <div className="rt-timing">
      <SegmentedControl label={t('skills.timing.kinds')} value={form.kind} options={kinds} onChange={(kind) => set({ kind })} />
      {form.kind === 'daily' && (
        <div className="rt-timing__body">
          <Field label={t('skills.timing.time')} htmlFor={ids.time}>
            <TextInput id={ids.time} type="time" className="sp-input--short" lang={locale} value={form.time} onChange={(e) => set({ time: e.target.value })} />
          </Field>
          <Field label={t('skills.timing.days')}>
            <div className="rt-timing__days">
              <SegmentedControl
                size="sm"
                label={t('skills.timing.days')}
                value={preset}
                options={presets}
                onChange={(next) => set({ days: next === 'custom' ? (preset === 'custom' ? form.days : [1, 3, 5]) : presetDays(next) })}
              />
              {preset === 'custom' && <DayToggles days={form.days} label={t('skills.timing.custom')} onChange={(days) => set({ days })} />}
            </div>
          </Field>
        </div>
      )}
      {form.kind === 'interval' && (
        <div className="rt-timing__body">
          <Field label={t('skills.timing.everyLabel')} htmlFor={ids.minutes}>
            <Select id={ids.minutes} value={String(form.minutes)} options={INTERVAL_CHOICES.map((m) => ({ value: String(m), label: intervalLabel(m) }))} onChange={(v) => set({ minutes: Number(v) })} />
          </Field>
          <Switch label={t('skills.timing.window')} checked={form.windowOn} onChange={(windowOn) => set({ windowOn })} />
          {form.windowOn && (
            <div className="sp-field__row">
              <Field label={t('skills.timing.from')} htmlFor={ids.from}>
                <Select id={ids.from} value={String(form.start)} options={hours.slice(0, 24).map((h) => ({ value: String(h), label: hourLabel(h, locale) }))} onChange={(v) => set({ start: Number(v) })} />
              </Field>
              <Field label={t('skills.timing.to')} htmlFor={ids.to}>
                <Select id={ids.to} value={String(form.end)} options={hours.slice(1).map((h) => ({ value: String(h), label: hourLabel(h, locale) }))} onChange={(v) => set({ end: Number(v) })} />
              </Field>
            </div>
          )}
          <Field label={t('skills.timing.intervalDays')}>
            <DayToggles days={form.intervalDays} label={t('skills.timing.intervalDays')} onChange={(intervalDays) => set({ intervalDays })} />
          </Field>
        </div>
      )}
      {form.kind === 'cron' && (
        <div className="rt-timing__body">
          <Field label={t('skills.timing.expr')} htmlFor={ids.expr} hint={t('skills.timing.exprHint')} error={cronCheck && !cronCheck.ok ? cronCheck.error : (error ?? null)}>
            <TextInput id={ids.expr} className="sp-mono" value={form.expr} spellCheck={false} autoCapitalize="off" invalid={Boolean(cronCheck && !cronCheck.ok)} onChange={(e) => set({ expr: e.target.value })} />
          </Field>
          {cronCheck?.ok && <p className="rt-ok" role="status">{t('skills.timing.exprOk')}</p>}
        </div>
      )}
      {form.kind === 'once' && (
        <div className="rt-timing__body sp-field__row">
          <Field label={t('skills.timing.date')} htmlFor={ids.date}>
            <TextInput id={ids.date} type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />
          </Field>
          <Field label={t('skills.timing.onceTime')} htmlFor={ids.onceTime}>
            <TextInput id={ids.onceTime} type="time" lang={locale} value={form.onceTime} onChange={(e) => set({ onceTime: e.target.value })} />
          </Field>
        </div>
      )}
      {error && form.kind !== 'cron' && (
        <p className="sp-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
