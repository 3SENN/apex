/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › You › About you (ON-18): your profile from the setup chat, at a
// glance (your card, your week, your apps) with Edit for the details. Each
// change saves at once and rewrites the About me note
// companions read. "Match my sidebar to this" sets the sidebar rows the
// profile asks for (after a confirmation; nothing is deleted, rows move under
// More); "Talk it through again" reopens the setup conversation (it ends at
// the workspace step when setup is done); "Forget all of this" removes the profile.
import { useEffect, useId, useState, type ReactElement } from 'react'
import { Pencil, X } from 'lucide-react'
import { INTERESTS, PROFILE_LIMITS, REPLY_STYLES, TECH_LEVELS, emptyProfile, type Interest, type ReplyStyle, type TechLevel, type UserProfile } from '@shared/userProfile'
import { call, errorText } from '../../api'
import { Button, IconButton, confirm, toast } from '../../ui'
import { Card, FilterChip, Notice, Row, Section, TextInput } from '../kit'
import { describeSchedule } from '../logic/routines'
import { YouCard } from '../../about/YouCard'
import { useT } from '../../i18n/useT'

export function AboutYouSection({ userName, avatar }: { userName: string; avatar: string | null }): ReactElement {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const workId = useId()
  const appId = useId()
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined)
  const [work, setWork] = useState('')
  const [app, setApp] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    call('onboarding', 'profile').then(
      (p) => {
        setProfile(p)
        setWork(p?.work ?? '')
      },
      () => setProfile(null),
    )
  }, [])
  // Nothing to glance at yet: the details are the way in.
  const showEditor = editing || profile === null

  const current = profile ?? emptyProfile(Date.now())
  const save = (patch: Partial<UserProfile>): void => {
    const next = { ...current, ...patch }
    setProfile(next)
    setError(null)
    call('onboarding', 'saveProfile', next).then(setProfile, (err: unknown) => setError(errorText(err)))
  }
  const toggle = <T,>(list: readonly T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])
  const addApp = (): void => {
    const name = app.trim().slice(0, PROFILE_LIMITS.phrase)
    if (!name || current.apps.some((a) => a.toLowerCase() === name.toLowerCase()) || current.apps.length >= PROFILE_LIMITS.apps) return
    save({ apps: [...current.apps, name] })
    setApp('')
  }

  const matchSidebar = async (): Promise<void> => {
    const ok = await confirm({ title: t('settings.you.about.matchTitle'), message: t('settings.you.about.matchMessage'), confirmLabel: t('settings.you.about.matchConfirm') })
    if (!ok) return
    try {
      const plan = await call('onboarding', 'plan')
      if (!plan) return
      await call('onboarding', 'applyPlan', { destinations: plan.destinations, routines: [] })
      toast.show({ message: t('settings.you.about.matched'), tone: 'success' })
    } catch (err) {
      setError(errorText(err))
    }
  }

  const talk = async (): Promise<void> => {
    try {
      await call('onboarding', 'goTo', 'questions')
      await call('pages', 'open', 'apex://welcome')
    } catch (err) {
      setError(errorText(err))
    }
  }

  const forget = async (): Promise<void> => {
    const ok = await confirm({ title: t('settings.you.about.forgetTitle'), message: t('settings.you.about.forgetMessage'), confirmLabel: t('settings.you.about.forgetConfirm'), destructive: true })
    if (!ok) return
    try {
      await call('onboarding', 'clearProfile')
      setProfile(null)
      setWork('')
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Section
      title={t('settings.you.about.title')}
      note={t('settings.you.about.note')}
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={() => void talk()}>{t('settings.you.about.talk')}</Button>
          {profile && !editing && <Button variant="ghost" size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>{t('settings.you.about.edit')}</Button>}
          {profile && editing && <Button variant="secondary" size="sm" onClick={() => void matchSidebar()}>{t('settings.you.about.match')}</Button>}
          {profile && editing && <Button variant="ghost" size="sm" onClick={() => void forget()}>{t('settings.you.about.forget')}</Button>}
          {profile && editing && <Button variant="primary" size="sm" onClick={() => setEditing(false)}>{t('settings.you.about.done')}</Button>}
        </>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {profile && !showEditor && (
        <div className="about-glance">
          <YouCard profile={profile} name={userName || null} avatar={avatar} />
          {(profile.habits.length > 0 || profile.apps.length > 0) && (
            <div className="about-glance__more">
              {profile.habits.map((h, i) => (
                <span key={`${h.what}-${i}`} className="about-glance__item">
                  <strong>{h.what}</strong> {describeSchedule({ kind: 'daily', time: h.time, days: h.days })}
                </span>
              ))}
              {profile.apps.map((a) => (
                <span key={a} className="about-glance__item about-glance__app">{a}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {showEditor && (
      <Card>
        <Row title={t('settings.you.about.work')} htmlFor={workId}>
          <TextInput
            id={workId}
            value={work}
            maxLength={PROFILE_LIMITS.text}
            placeholder={t('settings.you.about.workPlaceholder')}
            onChange={(e) => setWork(e.target.value)}
            onBlur={() => work.trim() !== (current.work ?? '') && save({ work: work.trim() || null })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </Row>
        <Row title={t('settings.you.about.handsOn')} stack>
          <div className="sp-chips" role="group" aria-label={t('settings.you.about.handsOn')}>
            {TECH_LEVELS.map((level: TechLevel) => (
              <FilterChip key={level} label={t(`settings.you.about.level.${level}`)} pressed={current.techLevel === level} onClick={() => save({ techLevel: current.techLevel === level ? null : level })} />
            ))}
          </div>
        </Row>
        <Row title={t('settings.you.about.interests')} stack>
          <div className="sp-chips" role="group" aria-label={t('settings.you.about.interests')}>
            {INTERESTS.map((i: Interest) => (
              <FilterChip key={i} label={t(`settings.you.about.interest.${i}`)} pressed={current.interests.includes(i)} onClick={() => save({ interests: toggle(current.interests, i) })} />
            ))}
          </div>
        </Row>
        <Row title={t('settings.you.about.habits')} description={current.habits.length === 0 ? t('settings.you.about.habitsEmpty') : undefined} stack>
          {current.habits.length > 0 && (
            <ul className="sp-about-list">
              {current.habits.map((h, i) => (
                <li key={`${h.what}-${i}`} className="sp-about-item">
                  <span>{h.what}</span>
                  <span className="sp-about-when">{describeSchedule({ kind: 'daily', time: h.time, days: h.days })}</span>
                  <IconButton size="sm" label={t('settings.you.about.remove', { name: h.what })} icon={<X />} onClick={() => save({ habits: current.habits.filter((_, j) => j !== i) })} />
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row title={t('settings.you.about.apps')} stack>
          <div className="sp-chips">
            {current.apps.map((a) => (
              <span key={a} className="sp-chip sp-chip--on sp-about-app">
                {a}
                <IconButton size="sm" label={t('settings.you.about.remove', { name: a })} icon={<X />} onClick={() => save({ apps: current.apps.filter((x) => x !== a) })} />
              </span>
            ))}
            <label className="ui-sr-only" htmlFor={appId}>{t('settings.you.about.addApp')}</label>
            <TextInput id={appId} className="sp-input--short" value={app} placeholder={t('settings.you.about.addApp')} maxLength={PROFILE_LIMITS.phrase} onChange={(e) => setApp(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addApp()} />
            <Button variant="secondary" size="sm" disabled={!app.trim()} onClick={addApp}>{t('settings.you.about.add')}</Button>
          </div>
        </Row>
        <Row title={t('settings.you.about.replies')} stack>
          <div className="sp-chips" role="group" aria-label={t('settings.you.about.replies')}>
            {REPLY_STYLES.map((style: ReplyStyle) => (
              <FilterChip key={style} label={t(`settings.you.about.reply.${style}`)} pressed={current.replyStyle === style} onClick={() => save({ replyStyle: current.replyStyle === style ? null : style })} />
            ))}
          </div>
        </Row>
      </Card>
      )}
    </Section>
  )
}
