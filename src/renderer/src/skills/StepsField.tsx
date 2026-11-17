/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A skill's ordered steps (Workflows live inside Skills). Each
// step has a title and instructions; buttons move, remove and add them, so
// the order can be changed from the keyboard.
import type { ReactElement } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { Button, IconButton } from '../ui'
import { TextArea, TextInput } from '../settings/kit'
import { moveStep, newStepId, type SkillStepForm } from '../companion-card/logic/skills'

export interface StepsFieldProps {
  steps: SkillStepForm[]
  onChange(steps: SkillStepForm[]): void
  readOnly?: boolean
}

export function StepsField({ steps, onChange, readOnly = false }: StepsFieldProps): ReactElement {
  const t = useT()
  const patch = (index: number, change: Partial<SkillStepForm>): void => onChange(steps.map((s, i) => (i === index ? { ...s, ...change } : s)))
  return (
    <fieldset className="sk-steps">
      <legend className="sp-field__label">{t('skills.steps.title')}</legend>
      <p className="sp-field__hint">{t('skills.steps.hint')}</p>
      {steps.length === 0 && readOnly && <p className="sp-field__hint">{t('skills.steps.none')}</p>}
      <ol className="sk-steps__list">
        {steps.map((step, index) => {
          const n = index + 1
          return (
            <li key={step.id} className="sk-step">
              <span className="sk-step__number" aria-hidden>
                {n}
              </span>
              <div className="sk-step__fields">
                <TextInput
                  aria-label={t('skills.steps.stepTitle', { n })}
                  value={step.title}
                  placeholder={t('skills.steps.titlePlaceholder')}
                  readOnly={readOnly}
                  maxLength={200}
                  onChange={(e) => patch(index, { title: e.target.value })}
                />
                <TextArea
                  aria-label={t('skills.steps.stepBody', { n })}
                  value={step.instructions}
                  readOnly={readOnly}
                  rows={3}
                  maxLength={20_000}
                  onChange={(e) => patch(index, { instructions: e.target.value })}
                />
              </div>
              {!readOnly && (
                <div className="sk-step__actions">
                  <IconButton size="sm" label={t('skills.steps.up', { n })} icon={<ArrowUp />} disabled={index === 0} onClick={() => onChange(moveStep(steps, index, -1))} />
                  <IconButton size="sm" label={t('skills.steps.down', { n })} icon={<ArrowDown />} disabled={index === steps.length - 1} onClick={() => onChange(moveStep(steps, index, 1))} />
                  <IconButton size="sm" tone="danger" label={t('skills.steps.remove', { n })} icon={<X />} onClick={() => onChange(steps.filter((_, i) => i !== index))} />
                </div>
              )}
            </li>
          )
        })}
      </ol>
      {!readOnly && (
        <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => onChange([...steps, { id: newStepId(steps), title: '', instructions: '' }])}>
          {t('skills.steps.add')}
        </Button>
      )}
    </fieldset>
  )
}
