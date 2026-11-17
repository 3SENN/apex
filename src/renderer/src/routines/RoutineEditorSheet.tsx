/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The routine editor sheet (SK-07): create or edit a routine over
// the page that opened it (atelier://routines/new, …/<id>/edit, proposal
// cards, suggestions and guides). It reads as one sentence: when, this
// companion, does that. Each missing field says what it needs, and a save
// over a newer version offers to load it instead (changed-elsewhere).
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { SHARED_OWNER } from '@shared/chats'
import { NOTIFY_IF_MAX, ROUTINE_CHANGED_ELSEWHERE, type Routine, type RoutineDraft } from '@shared/routines'
import type { Skill } from '@shared/skills'
import { call, errorText } from '../api'
import { DictateButton } from '../chat/dictation/DictateButton'
import { useT } from '../i18n/useT'
import { Button, ErrorState, SegmentedControl, Select, Sheet, SkeletonText, Switch, formatAbsolute, useConfirm, useToast } from '../ui'
import { useCompanions, useResource } from '../settings/data'
import { Field, Notice, TextArea, TextInput } from '../settings/kit'
import {
  describeTiming,
  formatRunTime,
  routineEditorErrors,
  routineEditorForm,
  routineEditorInput,
  routineSentence,
  timingToSchedule,
  type RoutineEditorField,
  type RoutineEditorForm,
} from '../settings/logic/routines'
import { TimeZonePicker } from './TimeZonePicker'
import { TimingField } from './TimingField'
import './routines.css'

export interface RoutineEditorSheetProps {
  draft?: RoutineDraft
  routineId?: string
  onClose(saved: Routine | null): void
}

type Load = { kind: 'loading' } | { kind: 'missing'; message: string } | { kind: 'ready'; routine: Routine | null }

export function RoutineEditorSheet({ draft, routineId, onClose }: RoutineEditorSheetProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const companions = useCompanions()
  const skills = useResource(() => call('skills', 'list'))
  const chats = useResource(() => call('chats', 'list', { limit: 100, routine: 'exclude' }))
  const locale = typeof navigator === 'undefined' ? undefined : navigator.language
  const [load, setLoad] = useState<Load>(routineId ? { kind: 'loading' } : { kind: 'ready', routine: null })
  const [form, setForm] = useState<RoutineEditorForm>(() => routineEditorForm({ draft: draft ?? null, fallbackCompanion: SHARED_OWNER }))
  const [base, setBase] = useState(form)
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<'changed' | 'deleted' | null>(null)
  const [preview, setPreview] = useState<number[] | null>(null)
  const [cron, setCron] = useState<{ ok: true } | { ok: false; error: string } | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const ids = { name: useId(), companion: useId(), prompt: useId(), skill: useId(), zone: useId(), chat: useId(), notifyIf: useId() }
  const routine = load.kind === 'ready' ? load.routine : null

  const fetchRoutine = async (): Promise<void> => {
    if (!routineId) return
    try {
      const r = await call('routines', 'get', routineId)
      const next = routineEditorForm({ routine: r, fallbackCompanion: SHARED_OWNER })
      setLoad({ kind: 'ready', routine: r })
      setForm(next)
      setBase(next)
      setConflict(null)
    } catch (err) {
      setLoad({ kind: 'missing', message: errorText(err) })
    }
  }
  useEffect(() => {
    void fetchRoutine()
  }, [routineId])

  const skillList: Skill[] = skills.data ?? []
  const companionList = companions.items ?? []
  const ctx = useMemo(
    () => ({ companionExists: (id: string) => companions.items === null || companionList.some((c) => c.id === id), skillExists: (id: string) => skillList.length === 0 || skillList.some((s) => s.id === id) }),
    [companions.items, companionList, skillList],
  )
  const errors: Partial<Record<RoutineEditorField, string>> = tried ? routineEditorErrors(form, ctx) : {}
  const timing = timingToSchedule(form.timing, form.timeZone)
  const schedule = 'schedule' in timing ? timing.schedule : null
  const scheduleKey = JSON.stringify([schedule, form.timeZone])

  // The next runs, and the cron check, from main (debounced while typing).
  useEffect(() => {
    if (!schedule) {
      setPreview(null)
      setCron(null)
      return
    }
    let live = true
    const timer = setTimeout(async () => {
      try {
        if (schedule.kind === 'cron') {
          const check = await call('routines', 'validateCron', schedule.expr)
          if (!live) return
          setCron(check)
          if (!check.ok) {
            setPreview(null)
            return
          }
        } else setCron(null)
        const runs = await call('routines', 'previewSchedule', schedule, form.timeZone, 5)
        if (live) setPreview(runs)
      } catch {
        if (live) setPreview(null)
      }
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [scheduleKey])

  const dirty = JSON.stringify(form) !== JSON.stringify(base)
  const close = async (): Promise<void> => {
    if (dirty) {
      const ok = await confirm({ title: t('skills.editorR.discardTitle'), message: t('skills.editorR.discardBody'), confirmLabel: t('skills.editor.discard'), cancelLabel: t('skills.editor.keep'), destructive: true })
      if (!ok) return
    }
    onClose(null)
  }
  const save = async (): Promise<void> => {
    setTried(true)
    const found = routineEditorErrors(form, ctx)
    if (Object.keys(found).length) {
      if (found.name) nameRef.current?.focus()
      return
    }
    if (cron && !cron.ok) return
    const input = routineEditorInput(form, { ...(routine ? { id: routine.id, revision: routine.revision } : {}) })
    if (!input) return
    setSaving(true)
    try {
      const saved = await call('routines', 'save', input)
      toast.show({ tone: 'success', message: routine ? t('skills.routines.saved', { name: saved.name }) : t('skills.routines.created', { name: saved.name }) })
      onClose(saved)
    } catch (err) {
      const message = errorText(err)
      if (message.includes(ROUTINE_CHANGED_ELSEWHERE)) setConflict('changed')
      else if (/was deleted|no longer exists/.test(message) && routine) setConflict('deleted')
      else toast.show({ tone: 'error', message })
    } finally {
      setSaving(false)
    }
  }

  const set = (patch: Partial<RoutineEditorForm>): void => setForm((f) => ({ ...f, ...patch }))
  const companionName = form.companionId === SHARED_OWNER ? t('skills.editorR.whoShared') : (companionList.find((c) => c.id === form.companionId)?.name ?? '…')
  const skillName = form.task === 'skill' ? (skillList.find((s) => s.id === form.skillId)?.name ?? null) : null
  const sentence = routineSentence({ when: schedule ? describeTiming(schedule, form.timeZone, locale) : '…', who: companionName, skillName, prompt: form.prompt })
  const chatOptions = [
    { value: '', label: t('skills.editorR.chatPick') },
    ...(chats.data ?? []).map((c) => ({ value: c.id, label: c.title || c.id })),
    ...(form.chatId && !(chats.data ?? []).some((c) => c.id === form.chatId) ? [{ value: form.chatId, label: form.chatId }] : []),
  ]
  const companionOptions = [
    ...(form.companionId === '' ? [{ value: '', label: t('skills.editorR.companionPick') }] : []),
    { value: SHARED_OWNER, label: t('skills.editorR.companionShared') },
    ...companionList.map((c) => ({ value: c.id, label: c.name })),
  ]
  const skillOptions = [{ value: '', label: t('skills.editorR.skillPick') }, ...skillList.map((s) => ({ value: s.id, label: `/${s.name}` }))]

  return (
    <Sheet
      open
      size="lg"
      onClose={() => void close()}
      title={routineId ? t('skills.editorR.editTitle') : t('skills.editorR.newTitle')}
      description={load.kind === 'ready' ? sentence : undefined}
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="ghost" onClick={() => void close()}>
            {t('skills.editorR.cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={load.kind !== 'ready' || conflict !== null} onClick={() => void save()}>
            {t('skills.editorR.save')}
          </Button>
        </>
      }
    >
      {load.kind === 'loading' && (
        <div role="status" aria-label={t('skills.editorR.loading')}>
          <SkeletonText lines={6} />
        </div>
      )}
      {load.kind === 'missing' && <ErrorState title={t('skills.editorR.missing')} message={load.message} onRetry={fetchRoutine} />}
      {load.kind === 'ready' && (
        <div className="rt-editor">
          {conflict === 'changed' && (
            <Notice tone="warning" action={<Button size="sm" variant="secondary" onClick={() => void fetchRoutine()}>{t('skills.editorR.loadLatest')}</Button>}>
              {t('skills.editorR.conflict')}
            </Notice>
          )}
          {conflict === 'deleted' && <Notice tone="error">{t('skills.editorR.deleted')}</Notice>}
          {routine?.needsCompanion && <Notice tone="warning">{t('skills.routines.needsCompanion')}</Notice>}
          <div className="rt-editor__row">
            <Field label={t('skills.editorR.name')} htmlFor={ids.name} error={errors.name}>
              <TextInput id={ids.name} ref={nameRef} value={form.name} maxLength={80} placeholder={t('skills.editorR.namePlaceholder')} invalid={Boolean(errors.name)} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label={t('skills.editorR.companion')} htmlFor={ids.companion} error={errors.companion}>
              <Select id={ids.companion} value={form.companionId} options={companionOptions} onChange={(companionId) => set({ companionId })} fullWidth />
            </Field>
          </div>

          <fieldset className="rt-editor__group">
            <legend className="sp-field__label">{t('skills.editorR.what')}</legend>
            <SegmentedControl
              size="sm"
              label={t('skills.editorR.what')}
              value={form.task}
              options={[
                { value: 'prompt', label: t('skills.editorR.whatPrompt') },
                { value: 'skill', label: t('skills.editorR.whatSkill') },
              ]}
              onChange={(task) => set({ task })}
            />
            {form.task === 'skill' && (
              <Field label={t('skills.editorR.skill')} htmlFor={ids.skill} error={errors.task}>
                <Select id={ids.skill} value={form.skillId} options={skillOptions} onChange={(skillId) => set({ skillId })} fullWidth />
              </Field>
            )}
            <Field label={form.task === 'skill' ? t('skills.editorR.skillExtra') : t('skills.editorR.prompt')} htmlFor={ids.prompt} error={form.task === 'prompt' ? errors.task : undefined}>
              <div className="rt-editor__prompt">
                <TextArea
                  id={ids.prompt}
                  rows={form.task === 'skill' ? 2 : 5}
                  value={form.prompt}
                  maxLength={20_000}
                  placeholder={form.task === 'prompt' ? t('skills.editorR.promptPlaceholder') : undefined}
                  invalid={form.task === 'prompt' && Boolean(errors.task)}
                  onChange={(e) => set({ prompt: e.target.value })}
                />
                <DictateButton label={t('skills.editorR.dictate')} onText={(text) => setForm((f) => ({ ...f, prompt: f.prompt.trim() ? `${f.prompt.trimEnd()} ${text}` : text }))} />
              </div>
            </Field>
          </fieldset>

          <fieldset className="rt-editor__group">
            <legend className="sp-field__label">{t('skills.editorR.when')}</legend>
            <TimingField form={form.timing} onChange={(timing) => set({ timing })} error={errors.timing} cronCheck={form.timing.kind === 'cron' ? cron : null} locale={locale} />
            <Field label={t('skills.editorR.zone')} htmlFor={ids.zone}>
              <TimeZonePicker id={ids.zone} value={form.timeZone} onChange={(timeZone) => set({ timeZone })} />
            </Field>
            <div className="rt-preview" aria-live="polite">
              <span className="sp-field__label">{t('skills.editorR.preview')}</span>
              {preview && preview.length === 0 && <p className="sp-field__hint">{t('skills.editorR.previewNone')}</p>}
              {preview && preview.length > 0 && (
                <ol className="rt-preview__list">
                  {preview.map((at) => (
                    <li key={at}>{formatRunTime(at, form.timeZone, locale)}</li>
                  ))}
                </ol>
              )}
            </div>
          </fieldset>

          <fieldset className="rt-editor__group">
            <legend className="sp-field__label">{t('skills.editorR.where')}</legend>
            <SegmentedControl
              size="sm"
              label={t('skills.editorR.where')}
              value={form.destination}
              options={[
                { value: 'new-chat', label: t('skills.editorR.newChat') },
                { value: 'append', label: t('skills.editorR.append') },
              ]}
              onChange={(destination) => set({ destination })}
            />
            {form.destination === 'append' && (
              <Field label={t('skills.editorR.chat')} htmlFor={ids.chat} hint={t('skills.editorR.chatHint')} error={errors.destination}>
                <Select id={ids.chat} value={form.chatId} options={chatOptions} onChange={(chatId) => set({ chatId })} fullWidth />
              </Field>
            )}
            <Field label={t('skills.editorR.notifyIf')} htmlFor={ids.notifyIf} hint={t('skills.editorR.notifyIfHint')}>
              <TextInput id={ids.notifyIf} value={form.notifyIf} maxLength={NOTIFY_IF_MAX} placeholder={t('skills.editorR.notifyIfPlaceholder')} onChange={(e) => set({ notifyIf: e.target.value })} />
            </Field>
          </fieldset>

          <Switch label={t('skills.editorR.active')} description={t('skills.editorR.activeHint')} checked={form.enabled} onChange={(enabled) => set({ enabled })} />
          {routine?.lastRunAt && <p className="sp-field__hint">{t('skills.routines.ran', { when: formatAbsolute(routine.lastRunAt) })}</p>}
        </div>
      )}
    </Sheet>
  )
}
