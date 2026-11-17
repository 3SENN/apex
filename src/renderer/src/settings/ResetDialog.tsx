/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reset Atelier (ST-55): lists every registered reset step, an off-by-default
// box that adds the `secrets` steps (the saved key, later the password
// vault), and a phrase to type before the button wakes up. A real run
// relaunches Atelier into the welcome flow, so success never comes back here.
import { useEffect, useId, useState, type ReactElement } from 'react'
import { call } from '../api'
import { useT } from '../i18n/useT'
import { Button, CheckRow, Dialog, SkeletonRows, useAsyncAction } from '../ui'
import { useResource } from './data'
import { resetPhraseMatches, resetPlan } from './logic/storage'
import { TextInput } from './kit'
import './settingsPages.css'

export function ResetDialog({ open, onClose }: { open: boolean; onClose(): void }): ReactElement {
  const t = useT()
  const phraseId = useId()
  const steps = useResource(async () => (open ? call('reset', 'steps') : []), open)
  const [secrets, setSecrets] = useState(false)
  const [typed, setTyped] = useState('')
  const phrase = t('settings.reset.phraseValue')
  useEffect(() => {
    if (!open) {
      setSecrets(false)
      setTyped('')
    }
  }, [open])

  const run = useAsyncAction(async () => {
    await call('reset', 'run', { secrets, dryRun: false })
  })
  const ready = resetPhraseMatches(typed, phrase) && steps.data !== null && !run.busy
  const plan = steps.data ? resetPlan(steps.data, secrets) : null
  const [before, after] = t('settings.reset.phrase', { phrase: '\u0000' }).split('\u0000')

  return (
    <Dialog
      open={open}
      onClose={() => !run.busy && onClose()}
      role="alertdialog"
      size="md"
      title={t('settings.reset.title')}
      description={t('settings.reset.message')}
      footer={
        <>
          <Button variant="ghost" disabled={run.busy} onClick={onClose} data-autofocus>
            {t('settings.reset.cancel')}
          </Button>
          <Button variant="danger" loading={run.busy} disabled={!ready} onClick={() => void run.run()}>
            {t('settings.reset.button')}
          </Button>
        </>
      }
    >
      <div className="sp-reset">
        {plan === null ? (
          steps.error ? (
            <p className="sp-field__error" role="alert">
              {steps.error}{' '}
              <button type="button" className="sp-link" onClick={() => void steps.reload()}>
                {t('settings.retry')}
              </button>
            </p>
          ) : (
            <SkeletonRows rows={3} label={t('settings.reset.loadingSteps')} />
          )
        ) : (
          <ul className="sp-reset__steps">
            {plan.map((step) => (
              <li key={step.id} className={step.secrets ? 'sp-reset__step sp-reset__step--secret' : 'sp-reset__step'}>
                {step.label}
              </li>
            ))}
          </ul>
        )}
        <div className="sp-reset__secrets">
          <CheckRow label={t('settings.reset.secrets')} checked={secrets} disabled={run.busy} onChange={setSecrets} />
          <p className="sp-field__hint">{t('settings.reset.secrets.description')}</p>
        </div>
        <label className="sp-reset__phrase" htmlFor={phraseId}>
          <span>
            {before}
            <strong className="sp-mono">{phrase}</strong>
            {after}
          </span>
          <TextInput
            id={phraseId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            disabled={run.busy}
            onChange={(e) => setTyped(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) {
                e.preventDefault()
                void run.run()
              }
            }}
          />
        </label>
        {run.error && (
          <p className="sp-field__error" role="alert">
            {t('settings.reset.failed', { error: run.error })}
          </p>
        )}
      </div>
    </Dialog>
  )
}
