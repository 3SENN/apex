/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The workspace step (ON-18): what your profile asks for, at a glance and
// before any of it is set. Your card on top; under it a mini sidebar (tap a
// row to show or hide it; Chats always stays), your week as tiles (a routine
// for each thing you do on a rhythm; tap to leave one out), and the apps to
// connect next as their icons. "Set it up" applies the rows and the routines
// left on; "Keep Apex as it is" changes nothing (your profile stays for your
// companions either way). Without a profile the step moves straight on.
import { useEffect, useState, type ReactElement } from 'react'
import { Check, Sparkles } from 'lucide-react'
import type { DirectoryEntry } from '@shared/connectors'
import type { RoutineSchedule } from '@shared/routines'
import { DESTINATIONS, type Destination } from '@shared/url'
import type { UserProfile, WorkspacePlan } from '@shared/userProfile'
import { call, errorText } from '../../api'
import { YouCard } from '../../about/YouCard'
import { DESTINATION_INFO } from '../../components/sidebar/Destinations'
import { Button, toast } from '../../ui'
import { useSiteIcons } from './Connectors'
import { BackButton, type StepProps } from './WelcomeFlow'
import { StepFrame, StepScene, initial } from './StepFrame'
import { useT } from '../../i18n/useT'
import '../../about/about.css'

/** A routine tile's two lines: when in the week, and the time. */
function tileWhen(schedule: RoutineSchedule, t: ReturnType<typeof useT>): { day: string; time: string } {
  if (schedule.kind !== 'daily') return { day: '', time: '' }
  const [h = 0, m = 0] = schedule.time.split(':').map(Number)
  const time = new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const days = [...new Set(schedule.days)].sort()
  if (days.length === 0 || days.length === 7) return { day: t('firstRun.workspace.daily'), time }
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return { day: t('firstRun.workspace.weekdays'), time }
  // 7 January 2024 was a Sunday: day 0.
  const day = days.map((d) => new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'short' })).join(' · ')
  return { day, time }
}

export function WorkspaceStep({ setup, settings, next, back, ready, save }: StepProps): ReactElement {
  const t = useT()
  const [plan, setPlan] = useState<WorkspacePlan | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [rows, setRows] = useState<Record<Destination, boolean> | null>(null)
  const [routines, setRoutines] = useState<Set<string>>(new Set())
  const [apps, setApps] = useState<DirectoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const icons = useSiteIcons(apps.map((a) => a.site))
  // Talked through again from Settings › You after setup: the rest of setup is done, so on to the end.
  const proceed = (): void => {
    if (setup.finishedAt !== null) void save({ step: 'launch' })
    else next()
  }

  useEffect(() => {
    let live = true
    void Promise.all([call('onboarding', 'plan').catch(() => null), call('onboarding', 'profile').catch(() => null), call('connectors', 'directory').catch(() => [] as DirectoryEntry[])]).then(([p, you, directory]) => {
      if (!live) return
      ready()
      // No profile (setup skipped the questions): nothing to review.
      if (!p || !you) return proceed()
      setPlan(p)
      setProfile(you)
      setRows(p.destinations)
      setRoutines(new Set(p.routines.map((r) => r.id)))
      setApps(p.connectors.flatMap((id) => directory.filter((e) => e.id === id)))
    })
    return () => {
      live = false
    }
  }, [])

  const apply = async (): Promise<void> => {
    if (!rows) return
    setBusy(true)
    setError(null)
    try {
      const made = await call('onboarding', 'applyPlan', { destinations: rows, routines: [...routines] })
      toast.show({ message: made.routines > 0 ? t('firstRun.workspace.appliedRoutines', { count: made.routines }) : t('firstRun.workspace.applied'), tone: 'success' })
      proceed()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  if (!plan || !rows || !profile) {
    return (
      <>
        <StepScene tiles={[]} />
        <StepFrame title={t('firstRun.workspace.title')} busy actions={null}>
          <div className="wlx__thinking" role="status">
            <span className="wlx__dots-think" aria-hidden="true"><i /><i /><i /></span>
          </div>
        </StepFrame>
      </>
    )
  }

  const toggleRow = (d: Destination): void => setRows((r) => (r && d !== 'chats' ? { ...r, [d]: !r[d] } : r))
  const toggleRoutine = (id: string): void =>
    setRoutines((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <>
      <StepScene tiles={[]} />
      <StepFrame
        title={t('firstRun.workspace.title')}
        subtitle={t('firstRun.workspace.subtitle')}
        cardClassName="wlx__card wlx__workspace"
        busy={busy}
        back={<BackButton onBack={back} />}
        actions={
          <>
            <Button variant="ghost" disabled={busy} onClick={proceed}>
              {t('firstRun.workspace.keep')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void apply()}>
              {t('firstRun.workspace.apply')}
            </Button>
          </>
        }
      >
        <YouCard profile={profile} name={settings.userName || null} avatar={settings.userAvatar} />
        <div className="yw-board">
          <div className="yw-board__col">
            <h2 className="yw-board__label">{t('firstRun.workspace.sidebar')}</h2>
            <div className="yw-mini" role="group" aria-label={t('firstRun.workspace.sidebar')}>
              {DESTINATIONS.map((d) => {
                const Icon = DESTINATION_INFO[d].icon
                return (
                  <button key={d} type="button" className="yw-mini__row" aria-pressed={rows[d]} disabled={d === 'chats'} onClick={() => toggleRow(d)}>
                    <Icon aria-hidden />
                    <span>{DESTINATION_INFO[d].label}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="yw-board__col">
            {plan.routines.length > 0 && (
              <>
                <h2 className="yw-board__label">{t('firstRun.workspace.week')}</h2>
                <div className="yw-tiles">
                  {plan.routines.map((r) => {
                    const when = tileWhen(r.draft.schedule, t)
                    const on = routines.has(r.id)
                    return (
                      <button key={r.id} type="button" className="yw-tile" aria-pressed={on} onClick={() => toggleRoutine(r.id)}>
                        <span className="yw-tile__when">
                          <span className="yw-tile__day">{when.day}</span>
                          <span className="yw-tile__time">{when.time}</span>
                        </span>
                        <span className="yw-tile__name">{r.draft.name}</span>
                        {on && <Check className="yw-tile__check" aria-hidden />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
            {apps.length > 0 && (
              <>
                <h2 className="yw-board__label">{t('firstRun.workspace.apps')}</h2>
                <div className="yw-apps">
                  {apps.map((a) => (
                    <span key={a.id} className="yw-app">
                      <span className="yw-app__icon">{icons[a.site] ? <img src={icons[a.site]!} alt="" /> : initial(a.name)}</span>
                      {a.name}
                    </span>
                  ))}
                </div>
              </>
            )}
            {plan.skills.length > 0 && (
              <p className="yw-skills">
                <Sparkles aria-hidden width={13} height={13} /> {plan.skills.map((s) => `/${s}`).join('  ')}
              </p>
            )}
          </div>
        </div>
        {error && <p className="co-field__error" role="alert">{error}</p>}
      </StepFrame>
    </>
  )
}
