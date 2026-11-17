/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Settings › Activity memory page (ST-49 to ST-52), in the Your data
// group after Memory. Off by default; the switch, its status and pause, set
// hours with day chips and wrapping hours, overrides, what is never captured,
// retention, the suggestion switches, the inspector and Clear.
import { useCallback, useEffect, useId, useState, type ReactElement } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { SENSITIVE_CATEGORIES, normalizeSite } from '@shared/exclusions'
import { isFlagOn } from '@shared/flags'
import type { ActivitySettings } from '@shared/activity'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { ClearDialog } from '../../activity/ClearDialog'
import { Inspector } from '../../activity/Inspector'
import {
  DAY_ORDER,
  PAUSE_CHOICES,
  PAUSE_KEYS,
  RETENTION_CHOICES,
  dayLetter,
  hourLabel,
  statusLine,
  toggleDay,
  tomorrow,
  untilChoices,
  whenLabel,
  type PauseChoice,
} from '../../activity/logic'
import { useActivitySettings, useActivityStatus } from '../../activity/useActivity'
import '../../activity/activity.css'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, CheckRow, IconButton, Select, SkeletonRows, Switch, cx, useToast } from '../../ui'
import { Notice, PageError, PageHeader, Row, Section, SwitchRow, TextInput } from '../kit'

export interface ActivityMemoryPageProps {
  settings: SettingsView
  update(patch: SettingsPatch): void
  tabId: string
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)

export default function ActivityMemoryPage({ settings: appSettings }: ActivityMemoryPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const ids = useId()
  const fail = useCallback((message: string) => toast.show({ tone: 'error', message }), [toast])
  const { settings, error, update, reload } = useActivitySettings(fail)
  const { status } = useActivityStatus()
  const [siteInput, setSiteInput] = useState('')
  const [siteError, setSiteError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [inspectorKey, setInspectorKey] = useState(0)
  const [busy, setBusy] = useState(false)
  // Re-render once a minute so "until 14:30" and the next change stay true.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  if (!settings) {
    return (
      <>
        <PageHeader title={t('memory.activity.title')} description={t('memory.activity.description')} />
        {error ? <PageError title={t('memory.activity.title')} message={error} onRetry={reload} /> : <SkeletonRows rows={5} label={t('memory.activity.title')} />}
      </>
    )
  }

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (err) {
      fail(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const pause = (choice: PauseChoice): void => void run(() => call('activity', 'pause', choice === 'today' ? 'today' : Date.now() + choice * 60_000))
  const resume = (): void => void run(() => call('activity', 'resume'))
  const schedule = settings.schedule
  const patchSchedule = (patch: Partial<ActivitySettings['schedule']>): void => void update({ schedule: { ...schedule, ...patch } })
  const sameHours = schedule.on && schedule.startHour === schedule.endHour
  const noDays = schedule.on && schedule.days.length === 0
  const override = settings.override.kind !== 'none' && settings.override.until > now ? settings.override : null
  const screenshots = isFlagOn(appSettings.flags ?? {}, 'activity-screenshots')

  const addSite = (): void => {
    const site = normalizeSite(siteInput)
    if (!site) {
      setSiteError(t('memory.activity.siteBad'))
      return
    }
    setSiteError(null)
    setSiteInput('')
    if (!settings.excluded.sites.includes(site)) void update({ excluded: { ...settings.excluded, sites: [...settings.excluded.sites, site].sort() } })
  }
  const toggleCategory = (category: (typeof SENSITIVE_CATEGORIES)[number], on: boolean): void => {
    const categories = on ? [...new Set([...settings.excluded.categories, category])] : settings.excluded.categories.filter((c) => c !== category)
    void update({ excluded: { ...settings.excluded, categories } })
  }
  const setRetention = (patch: Partial<ActivitySettings['retention']>): void => void update({ retention: { ...settings.retention, ...patch } })

  return (
    <>
      <PageHeader title={t('memory.activity.title')} description={t('memory.activity.description')} />

      {status?.state === 'paused' && status.pausedUntil !== null && (
        <Notice
          tone="info"
          action={
            <Button size="sm" variant="secondary" loading={busy} onClick={resume}>
              {t('memory.activity.resume')}
            </Button>
          }
        >
          {t('memory.activity.pausedBanner', { time: whenLabel(status.pausedUntil, now) })}
        </Notice>
      )}
      {settings.enabled && override?.kind === 'on-until' && (
        <Notice
          tone="info"
          action={
            <Button size="sm" variant="ghost" onClick={() => void run(() => call('activity', 'override', { kind: 'none' }))}>
              {t('memory.activity.clearOverride')}
            </Button>
          }
        >
          {t('memory.activity.overrideOn', { time: whenLabel(override.until, now) })}
        </Notice>
      )}

      {/* ── Capture (ST-49) ── */}
      <Section title={t('memory.activity.capture')} note={t('memory.activity.never')}>
        <div className="sp-card">
          <SwitchRow anchor="activity-enabled" checked={settings.enabled} onChange={(enabled) => void update({ enabled })} label={t('memory.activity.switch')} description={t('memory.activity.switchHint')} />
          {settings.enabled && status && (
            <Row
              title={
                <span className="am-status">
                  <span className={cx('am-status__dot', `am-status__dot--${status.state}`)} aria-hidden="true" />
                  {statusLine(status, now, t)}
                </span>
              }
              description={status.nextChange !== null && status.state !== 'paused' ? t('memory.activity.next', { time: whenLabel(status.nextChange, now) }) : t('memory.activity.onDevice')}
            >
              {status.state === 'paused' ? (
                <Button size="sm" onClick={resume} loading={busy}>
                  {t('memory.activity.resume')}
                </Button>
              ) : (
                <Select<string>
                  size="sm"
                  aria-label={t('memory.activity.pause')}
                  value="none"
                  options={[{ value: 'none', label: t('memory.activity.pause') }, ...PAUSE_CHOICES.map((c) => ({ value: String(c), label: t(PAUSE_KEYS[c]) }))]}
                  onChange={(v) => {
                    const choice = PAUSE_CHOICES.find((c) => String(c) === v)
                    if (choice !== undefined) pause(choice)
                  }}
                />
              )}
            </Row>
          )}
        </div>
      </Section>

      <Section title={t('memory.activity.hours')}>
        <div className="sp-card" data-settings-anchor="activity-hours">
          <SwitchRow checked={schedule.on} onChange={(on) => patchSchedule({ on })} label={t('memory.activity.hoursSwitch')} description={t('memory.activity.hoursHint')} />
          {schedule.on && (
            <>
              <Row title={t('memory.activity.days')} description={t('memory.activity.daysHint')}>
                <div className="am-days" role="group" aria-label={t('memory.activity.days')}>
                  {DAY_ORDER.map((day) => {
                    const on = schedule.days.includes(day)
                    return (
                      <button
                        key={day}
                        type="button"
                        className={cx('am-day', on && 'am-day--on')}
                        aria-pressed={on}
                        aria-label={t(`memory.activity.day${day}`)}
                        title={t(`memory.activity.day${day}`)}
                        onClick={() => patchSchedule({ days: toggleDay(schedule.days, day) })}
                      >
                        {dayLetter(day)}
                      </button>
                    )
                  })}
                </div>
              </Row>
              <Row title={t('memory.activity.time')} description={t('memory.activity.timeHint')}>
                <div className="am-hours">
                  <Select<string>
                    size="sm"
                    aria-label={t('memory.activity.from')}
                    value={String(schedule.startHour)}
                    options={HOURS.map((h) => ({ value: String(h), label: hourLabel(h) }))}
                    onChange={(v) => patchSchedule({ startHour: Number(v) })}
                  />
                  <span className="am-hours__to">{t('memory.activity.to')}</span>
                  <Select<string>
                    size="sm"
                    aria-label={t('memory.activity.to')}
                    value={String(schedule.endHour)}
                    options={HOURS.map((h) => ({ value: String(h), label: hourLabel(h) }))}
                    onChange={(v) => patchSchedule({ endHour: Number(v) })}
                  />
                </div>
              </Row>
              {(sameHours || noDays) && (
                <div className="am-warning" role="alert">
                  {sameHours ? t('memory.activity.sameHours') : t('memory.activity.noDays')}
                </div>
              )}
            </>
          )}
          {settings.enabled && (
            <Row title={t('memory.activity.override')} description={override ? (override.kind === 'on-until' ? t('memory.activity.overrideOn', { time: whenLabel(override.until, now) }) : t('memory.activity.overrideOff', { time: whenLabel(override.until, now) })) : undefined}>
              <div className="am-override">
                <Select<string>
                  size="sm"
                  aria-label={t('memory.activity.onUntil')}
                  value="none"
                  options={[
                    { value: 'none', label: t('memory.activity.onUntil') },
                    ...untilChoices(now).map((at) => ({ value: String(at), label: whenLabel(at, now) })),
                    { value: String(tomorrow(now)), label: t('memory.activity.onUntilTomorrow') },
                  ]}
                  onChange={(v) => v !== 'none' && void run(() => call('activity', 'override', { kind: 'on-until', until: Number(v) }))}
                />
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => call('activity', 'override', { kind: 'off-until-tomorrow' }))}>
                  {t('memory.activity.offTomorrow')}
                </Button>
                {override && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => call('activity', 'override', { kind: 'none' }))}>
                    {t('memory.activity.clearOverride')}
                  </Button>
                )}
              </div>
            </Row>
          )}
        </div>
      </Section>

      <Section title={t('memory.activity.excluded')} note={t('memory.activity.excludedHint')}>
        <div className="sp-card" data-settings-anchor="activity-excluded">
          <div className="am-categories" role="group" aria-label={t('memory.activity.excluded')}>
            {SENSITIVE_CATEGORIES.map((category) => (
              <CheckRow key={category} label={t(`memory.activity.cat.${category}`)} checked={settings.excluded.categories.includes(category)} onChange={(on) => toggleCategory(category, on)} />
            ))}
          </div>
          <div className="am-sites">
            <label className="sp-field__label" htmlFor={`${ids}-site`}>
              {t('memory.activity.sites')}
            </label>
            <form
              className="sp-field__row"
              onSubmit={(e) => {
                e.preventDefault()
                addSite()
              }}
            >
              <TextInput
                id={`${ids}-site`}
                className="sp-input--inline sp-mono"
                value={siteInput}
                placeholder={t('memory.activity.sitePlaceholder')}
                invalid={!!siteError}
                aria-describedby={siteError ? `${ids}-site-error` : undefined}
                onChange={(e) => {
                  setSiteInput(e.target.value)
                  setSiteError(null)
                }}
              />
              <Button type="submit" size="sm" icon={<Plus />} disabled={!siteInput.trim()}>
                {t('memory.activity.siteAdd')}
              </Button>
            </form>
            {siteError && (
              <p id={`${ids}-site-error`} className="sp-field__error" role="alert">
                {siteError}
              </p>
            )}
            {settings.excluded.sites.length === 0 ? (
              <p className="am-muted">{t('memory.activity.sitesEmpty')}</p>
            ) : (
              <ul className="am-site-list">
                {settings.excluded.sites.map((site) => (
                  <li key={site} className="am-site">
                    <span className="sp-mono">{site}</span>
                    <IconButton
                      size="sm"
                      label={t('memory.activity.siteRemove', { site })}
                      icon={<X />}
                      onClick={() => void update({ excluded: { ...settings.excluded, sites: settings.excluded.sites.filter((s) => s !== site) } })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      {/* ── Retention (ST-52) ── */}
      <Section title={t('memory.activity.retention')} note={t('memory.activity.retentionHint')}>
        <div className="sp-card" data-settings-anchor="activity-retention">
          <Row title={t('memory.activity.keepShots')} description={screenshots ? t('memory.activity.keepShotsHint') : t('memory.activity.thumbnailsOff')}>
            <Select<string>
              size="sm"
              aria-label={t('memory.activity.keepShots')}
              value={String(settings.retention.screenshotsDays)}
              options={RETENTION_CHOICES.screenshotsDays.map((d) => ({ value: String(d), label: t('memory.activity.days.n', { count: d }) }))}
              onChange={(v) => setRetention({ screenshotsDays: Number(v) })}
            />
          </Row>
          <Row title={t('memory.activity.keepCaptures')}>
            <Select<string>
              size="sm"
              aria-label={t('memory.activity.keepCaptures')}
              value={String(settings.retention.capturesDays)}
              options={RETENTION_CHOICES.capturesDays.map((d) => ({ value: String(d), label: t('memory.activity.days.n', { count: d }) }))}
              onChange={(v) => setRetention({ capturesDays: Number(v) })}
            />
          </Row>
          <Row title={t('memory.activity.keepNotes')} description={t('memory.activity.keepNotesHint')}>
            <Select<string>
              size="sm"
              aria-label={t('memory.activity.keepNotes')}
              value={settings.retention.notesDays === null ? 'forever' : String(settings.retention.notesDays)}
              options={RETENTION_CHOICES.notesDays.map((d) => (d === null ? { value: 'forever', label: t('memory.activity.forever') } : { value: String(d), label: t('memory.activity.days.n', { count: d }) }))}
              onChange={(v) => setRetention({ notesDays: v === 'forever' ? null : Number(v) })}
            />
          </Row>
        </div>
      </Section>

      <Section title={t('memory.activity.proactive')}>
        <div className="sp-card" data-settings-anchor="activity-proactive">
          <Switch checked={settings.proactive.insights} onChange={(insights) => void update({ proactive: { ...settings.proactive, insights } })} label={t('memory.activity.insights')} description={t('memory.activity.insightsHint')} />
          <Switch checked={settings.proactive.routines} onChange={(routines) => void update({ proactive: { ...settings.proactive, routines } })} label={t('memory.activity.routines')} description={t('memory.activity.routinesHint')} />
        </div>
      </Section>

      <Section title={t('memory.activity.inspector')} note={t('memory.activity.inspectorHint')}>
        <div data-settings-anchor="activity-inspector">
          <Inspector refreshKey={inspectorKey} />
        </div>
      </Section>

      {/* ── Clear (ST-51) ── */}
      <Section title={t('memory.activity.clear')}>
        <div className="sp-card" data-settings-anchor="activity-clear">
          <Row title={t('memory.activity.clearRow')} description={t('memory.activity.clearHint')}>
            <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setClearing(true)}>
              {t('memory.activity.clearButton')}
            </Button>
          </Row>
        </div>
      </Section>
      {clearing && <ClearDialog onClose={() => setClearing(false)} onCleared={() => setInspectorKey((k) => k + 1)} />}
    </>
  )
}
