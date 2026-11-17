/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Save as skill sheet (SK-02, SK-06). With a draft (the agent's
// skill-draft card) it shows that draft; with only a chat it asks
// `skills.draftFromChat` for one first. Either way nothing is saved until
// the person checks it and presses Save.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { WandSparkles } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import type { Skill, SkillDraft } from '@shared/skills'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, ErrorState, Sheet, SkeletonText, useConfirm, useToast } from '../ui'
import { useCompanions } from '../settings/data'
import { skillFormDirty, skillFormErrors, skillFormInput, skillNameInput, type SkillForm, type SkillFormField } from '../companion-card/logic/skills'
import { SkillFormFields } from './SkillFormFields'
import './skills.css'

export interface SaveAsSkillSheetProps {
  chatId?: string
  draft?: SkillDraft
  onClose(saved: Skill | null): void
}

type Phase = { kind: 'drafting' } | { kind: 'failed'; message: string } | { kind: 'ready' }

export function formFromDraft(draft: SkillDraft | null): SkillForm {
  return {
    name: skillNameInput(draft?.name ?? ''),
    description: draft?.description ?? '',
    instructions: draft?.instructions ?? '',
    steps: (draft?.steps ?? []).map((s) => ({ ...s })),
    owner: draft?.owner ?? SHARED_OWNER,
  }
}

export function SaveAsSkillSheet({ chatId, draft, onClose }: SaveAsSkillSheetProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const companions = useCompanions()
  const [phase, setPhase] = useState<Phase>(draft || !chatId ? { kind: 'ready' } : { kind: 'drafting' })
  const [form, setForm] = useState<SkillForm>(() => formFromDraft(draft ?? null))
  const [loaded, setLoaded] = useState<SkillForm>(form)
  const [errors, setErrors] = useState<Partial<Record<SkillFormField, string>>>({})
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const runDraft = useCallback(async (): Promise<void> => {
    if (!chatId) return
    setPhase({ kind: 'drafting' })
    try {
      const next = formFromDraft(await call('skills', 'draftFromChat', chatId))
      if (!alive.current) return
      setForm(next)
      setLoaded(next)
      setPhase({ kind: 'ready' })
    } catch (err) {
      if (alive.current) setPhase({ kind: 'failed', message: errorText(err) })
    }
  }, [chatId])
  useEffect(() => {
    if (!draft && chatId) void runDraft()
  }, [])

  const change = (next: SkillForm): void => {
    setForm(next)
    if (tried) setErrors(skillFormErrors(next))
  }
  const close = async (): Promise<void> => {
    if (phase.kind === 'ready' && skillFormDirty(form, loaded)) {
      const ok = await confirm({ title: t('skills.editor.discardTitle'), message: t('skills.editor.discardBody'), confirmLabel: t('skills.editor.discard'), cancelLabel: t('skills.editor.keep'), destructive: true })
      if (!ok) return
    }
    onClose(null)
  }
  const save = async (): Promise<void> => {
    setTried(true)
    const found = skillFormErrors(form)
    setErrors(found)
    if (Object.keys(found).length) {
      if (found.name) nameRef.current?.focus()
      return
    }
    setSaving(true)
    try {
      // The companion's change to one of its skills saves over that skill.
      const skill = await call('skills', 'save', skillFormInput(form, draft?.updates))
      toast.show({ tone: 'success', message: t(draft?.updates ? 'skills.editor.saved' : 'skills.page.created', { name: skill.name }) })
      onClose(skill)
    } catch (err) {
      const message = errorText(err)
      // A taken name belongs on the name field.
      if (/already exists|name/i.test(message)) {
        setErrors({ name: message })
        nameRef.current?.focus()
      } else toast.show({ tone: 'error', message })
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  return (
    <Sheet
      open
      onClose={() => void close()}
      size="lg"
      title={t('skills.saveAsSkill')}
      description={phase.kind === 'ready' ? t('skills.sheet.description') : undefined}
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="ghost" onClick={() => void close()}>
            {t('skills.sheet.cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={phase.kind !== 'ready'} onClick={() => void save()}>
            {t('skills.sheet.save')}
          </Button>
        </>
      }
    >
      {phase.kind === 'drafting' && (
        <div className="sk-drafting" role="status" aria-live="polite">
          <WandSparkles aria-hidden />
          <p>{t('skills.sheet.drafting')}</p>
          <SkeletonText lines={5} />
        </div>
      )}
      {phase.kind === 'failed' && (
        <ErrorState
          title={t('skills.sheet.draftFailed')}
          message={phase.message}
          onRetry={runDraft}
          retryLabel={t('skills.sheet.retry')}
          action={
            <Button variant="secondary" onClick={() => setPhase({ kind: 'ready' })}>
              {t('skills.sheet.writeOwn')}
            </Button>
          }
        />
      )}
      {phase.kind === 'ready' && <SkillFormFields form={form} onChange={change} errors={errors} companions={companions.items ?? []} nameRef={nameRef} />}
    </Sheet>
  )
}
