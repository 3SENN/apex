/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The fields of a skill (SK-03): its /name, what it's for, who it belongs
// to, the instructions and the steps. The editor page and Save as skill
// share them; built-in skills show them read-only.
import { useId, type ReactElement, type RefObject } from 'react'
import { SHARED_OWNER } from '@shared/chats'
import { useT } from '../i18n/useT'
import { Select } from '../ui'
import { Field, TextArea, TextInput } from '../settings/kit'
import { skillNameInput, type SkillForm, type SkillFormField } from '../companion-card/logic/skills'
import { StepsField } from './StepsField'

export interface SkillFormFieldsProps {
  form: SkillForm
  onChange(form: SkillForm): void
  errors: Partial<Record<SkillFormField, string>>
  companions: ReadonlyArray<{ id: string; name: string }>
  readOnly?: boolean
  nameRef?: RefObject<HTMLInputElement | null>
}

export function SkillFormFields({ form, onChange, errors, companions, readOnly = false, nameRef }: SkillFormFieldsProps): ReactElement {
  const t = useT()
  const ids = { name: useId(), description: useId(), owner: useId(), instructions: useId() }
  const set = (patch: Partial<SkillForm>): void => onChange({ ...form, ...patch })
  const owners = [{ value: SHARED_OWNER, label: t('skills.editor.ownerShared') }, ...companions.map((c) => ({ value: c.id, label: c.name }))]
  // A skill whose companion is gone keeps its owner until you pick another.
  if (!owners.some((o) => o.value === form.owner)) owners.push({ value: form.owner, label: form.owner })
  return (
    <div className="sk-fields">
      <div className="sk-fields__row">
        <Field label={t('skills.editor.name')} htmlFor={ids.name} error={errors.name} hint={form.name ? t('skills.editor.nameHint', { name: form.name }) : undefined}>
          <span className="sk-name">
            <span className="sk-name__slash" aria-hidden>
              /
            </span>
            <TextInput
              id={ids.name}
              ref={nameRef}
              className="sp-mono"
              value={form.name}
              placeholder={t('skills.editor.namePlaceholder')}
              readOnly={readOnly}
              invalid={Boolean(errors.name)}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => set({ name: skillNameInput(e.target.value) })}
            />
          </span>
        </Field>
        <Field label={t('skills.editor.owner')} htmlFor={ids.owner}>
          <Select id={ids.owner} value={form.owner} options={owners} disabled={readOnly} onChange={(owner) => set({ owner })} fullWidth />
        </Field>
      </div>
      <Field label={t('skills.editor.description')} htmlFor={ids.description} error={errors.description} hint={t('skills.editor.descriptionHint', { count: form.description.trim().length })}>
        <TextArea id={ids.description} value={form.description} rows={2} readOnly={readOnly} invalid={Boolean(errors.description)} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label={t('skills.editor.instructions')} htmlFor={ids.instructions} error={errors.instructions} hint={t('skills.editor.instructionsHint')}>
        <TextArea id={ids.instructions} code value={form.instructions} rows={10} readOnly={readOnly} invalid={Boolean(errors.instructions)} maxLength={50_000} onChange={(e) => set({ instructions: e.target.value })} />
      </Field>
      <StepsField steps={form.steps} readOnly={readOnly} onChange={(steps) => set({ steps })} />
    </div>
  )
}
