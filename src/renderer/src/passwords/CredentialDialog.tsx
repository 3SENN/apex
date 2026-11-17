/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Add or edit a saved sign-in, with a strength meter and Generate. Editing
// leaves the password field empty: the saved one is kept unless you type or
// generate a new one, so the dialog never has to reveal it.
import { useEffect, useId, useState, type FormEvent, type ReactElement } from 'react'
import { Eye, EyeOff, WandSparkles } from 'lucide-react'
import { STRENGTH_KEY, siteInput, siteOfOrigin, strengthBars, type CredentialView, type PasswordStrength } from '@shared/passwords'
import { call, errorText } from '../api'
import { Field, TextInput } from '../settings/kit'
import { Button, Dialog, IconButton } from '../ui'
import { useT } from '../i18n/useT'

export function StrengthMeter({ password }: { password: string }): ReactElement | null {
  const t = useT()
  const [strength, setStrength] = useState<PasswordStrength | null>(null)
  useEffect(() => {
    if (!password) {
      setStrength(null)
      return
    }
    let live = true
    void call('passwords', 'strength', password).then((s) => live && setStrength(s), () => live && setStrength(null))
    return () => {
      live = false
    }
  }, [password])
  if (!strength) return null
  const bars = strengthBars(strength)
  return (
    <div className="pw-strength" data-level={strength} aria-live="polite">
      <span className="pw-strength__bars" aria-hidden>
        {[1, 2, 3].map((n) => (
          <i key={n} className="pw-strength__bar" data-on={n <= bars} />
        ))}
      </span>
      <span>
        {t('passwords.strength.label')}: {t(STRENGTH_KEY[strength])}
      </span>
    </div>
  )
}

export interface CredentialDialogProps {
  open: boolean
  /** null adds a new sign-in. */
  editing: CredentialView | null
  /** Prefills the site when adding from a ?site= filter. */
  site?: string | null
  onClose(): void
  onSaved(view: CredentialView, added: boolean): void
}

export function CredentialDialog({ open, editing, site, onClose, onSaved }: CredentialDialogProps): ReactElement {
  const t = useT()
  const ids = useId()
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setUrl(editing ? editing.origin : site ? `https://${site}` : '')
    setUsername(editing?.username ?? '')
    setPassword('')
    setShown(false)
    setError(null)
    setBusy(false)
  }, [open, editing?.id])

  const generate = async (): Promise<void> => {
    try {
      setPassword(await call('passwords', 'generate'))
      setShown(true)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (busy) return
    if (!editing && !url.trim()) return setError(t('passwords.edit.needSite'))
    if (!editing && !password) return setError(t('passwords.edit.needPassword'))
    setBusy(true)
    setError(null)
    try {
      const saved = editing
        ? await call('passwords', 'update', editing.id, { username, ...(password ? { password } : {}) })
        : await call('passwords', 'create', { url: siteInput(url), username, password })
      onSaved(saved, !editing)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={editing ? t('passwords.edit.titleEdit') : t('passwords.edit.titleAdd')}
      description={editing ? siteOfOrigin(editing.origin) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('passwords.edit.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t('passwords.edit.save')}
          </Button>
        </>
      }
    >
      <form className="pw-form" onSubmit={(e) => void submit(e)} noValidate>
        {!editing && (
          <Field label={t('passwords.edit.site')} hint={t('passwords.edit.siteHint')} htmlFor={`${ids}-url`}>
            <TextInput id={`${ids}-url`} value={url} placeholder={t('passwords.edit.sitePlaceholder')} autoComplete="off" spellCheck={false} data-autofocus onChange={(e) => setUrl(e.target.value)} />
          </Field>
        )}
        <Field label={t('passwords.edit.username')} htmlFor={`${ids}-user`}>
          <TextInput id={`${ids}-user`} value={username} autoComplete="off" spellCheck={false} data-autofocus={editing ? true : undefined} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label={t('passwords.edit.password')} htmlFor={`${ids}-pw`}>
          <div className="pw-secret-field">
            <TextInput
              id={`${ids}-pw`}
              type={shown ? 'text' : 'password'}
              value={password}
              placeholder={editing ? t('passwords.edit.passwordKeep') : undefined}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => setPassword(e.target.value)}
            />
            <IconButton size="sm" variant="subtle" label={shown ? t('passwords.edit.hideValue') : t('passwords.edit.show')} pressed={shown} icon={shown ? <EyeOff /> : <Eye />} onClick={() => setShown(!shown)} />
            <Button size="sm" icon={<WandSparkles />} onClick={() => void generate()}>
              {t('passwords.edit.generate')}
            </Button>
          </div>
          <StrengthMeter password={password} />
        </Field>
        {error && (
          <p className="pw-form__error" role="alert">
            {error}
          </p>
        )}
        {/* Enter in any field saves. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
