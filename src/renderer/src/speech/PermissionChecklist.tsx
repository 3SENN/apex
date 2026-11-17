/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The one-time setup checklist (ST-17): microphone, speech recognition and
// Screen Recording, in order. The first step not done is open, with why it is
// needed and one button: Allow asks the OS the first time; after a refusal it
// opens the right Privacy pane. The owner polls, so steps tick themselves.
// Whether Apex has asked for Screen Recording comes from main (macOS can't say).
import { useState, type ReactElement } from 'react'
import { Check, CircleDashed, Lock, TriangleAlert } from 'lucide-react'
import { t, type MessageKey } from '@shared/i18n/core'
import type { PermissionKind, SpeechPermissions } from '@shared/speech'
import { Button, cx } from '../ui'
import { checklistSteps, currentStep, type ChecklistStep } from './logic'

const TITLE: Record<PermissionKind, MessageKey> = {
  microphone: 'speech.permission.microphone',
  speech: 'speech.permission.speech',
  screen: 'speech.permission.screen',
}

const WHY: Record<PermissionKind, MessageKey> = {
  microphone: 'speech.permission.microphoneWhy',
  speech: 'speech.permission.speechWhy',
  screen: 'speech.permission.screenWhy',
}

export interface PermissionChecklistProps {
  permissions: SpeechPermissions
  requesting: PermissionKind | null
  request(kind: PermissionKind): Promise<SpeechPermissions | null>
  openSettings(kind: PermissionKind): void
  /** Whether Apex has asked macOS for Screen Recording (main remembers; useScreenAccess). */
  screenAsked: boolean
  /** Offered once the microphone and speech are allowed: carry on without Screen Recording. */
  onSkipScreen?(): void
}

export function PermissionChecklist({ permissions, requesting, request, openSettings, screenAsked, onSkipScreen }: PermissionChecklistProps): ReactElement {
  const [waiting, setWaiting] = useState<PermissionKind | null>(null)
  const steps = checklistSteps(permissions, screenAsked)
  const open = currentStep(steps)
  const done = steps.filter((s) => s.state === 'done').length

  async function act(step: ChecklistStep): Promise<void> {
    if (step.state === 'ask') {
      await request(step.kind)
      return
    }
    if (step.state === 'denied') {
      openSettings(step.kind)
      setWaiting(step.kind)
    }
  }

  return (
    <div className="sk-checklist">
      <div className="sk-checklist__head">
        <p className="sk-checklist__intro">{t('speech.setup.intro')}</p>
        <span className="sk-checklist__progress" aria-live="polite">
          {t('speech.setup.progress', { done, total: steps.length })}
        </span>
      </div>
      <ol className="sk-steps">
        {steps.map((step) => {
          const current = step === open
          return (
            <li key={step.kind} className={cx('sk-step', `sk-step--${step.state}`, current && 'sk-step--current')} aria-current={current ? 'step' : undefined}>
              <span className="sk-step__mark" aria-hidden>
                {step.state === 'done' ? <Check /> : step.state === 'restricted' ? <Lock /> : step.state === 'denied' && current ? <TriangleAlert /> : <CircleDashed />}
              </span>
              <div className="sk-step__body">
                <span className="sk-step__title">
                  {t(TITLE[step.kind])}
                  {step.state === 'done' && <span className="sk-visually-hidden">, {t('speech.permission.granted')}</span>}
                </span>
                {current && (
                  <>
                    <span className="sk-step__why">{step.state === 'restricted' ? t('speech.permission.restricted') : t(WHY[step.kind])}</span>
                    {step.state !== 'restricted' && (
                      <div className="sk-step__actions">
                        <Button variant="primary" size="sm" loading={requesting === step.kind} onClick={() => void act(step)}>
                          {step.state === 'ask' ? t('speech.permission.grant') : t('speech.permission.openSettings')}
                        </Button>
                        {waiting === step.kind && step.state === 'denied' && <span className="sk-step__waiting">{t('speech.setup.waiting')}</span>}
                      </div>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {onSkipScreen && open?.kind === 'screen' && (
        <div className="sk-checklist__foot">
          <Button variant="ghost" size="sm" onClick={onSkipScreen}>
            {t('speech.setup.notNow')}
          </Button>
          <span className="sk-checklist__hint">{t('speech.setup.notNowHint')}</span>
        </div>
      )}
    </div>
  )
}
