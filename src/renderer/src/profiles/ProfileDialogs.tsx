/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { ProfileHue } from '@shared/profile'
import { profileDeleteBlock, type Profile, type ProfileDeletionSummary } from '@shared/profiles'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, Dialog, Spinner } from '../ui'
import { TextInput } from '../settings/kit'
import { HueSwatches, ProfileBadge } from './HueSwatches'
import { deleteArmed, deleteBlockMessage, deletionRows, freshHue, nameMessage, type Message } from './logic'
import './profiles.css'

// The create and delete profile dialogs (ST-38, ST-39). The overlay surfaces
// profile-create and profile-delete host them over the window; the Profiles
// page opens those surfaces.

function useProfiles(): Profile[] | null {
  const [items, setItems] = useState<Profile[] | null>(null)
  useEffect(() => {
    let live = true
    call('profiles', 'list').then(
      (list) => live && setItems(list),
      () => live && setItems([]),
    )
    return () => {
      live = false
    }
  }, [])
  return items
}

export function CreateProfileDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(profile: Profile): void }): ReactElement {
  const t = useT()
  const text = (m: Message): string => t(m.key, m.vars)
  const profiles = useProfiles()
  const nameId = useId()
  const hueId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [hue, setHue] = useState<ProfileHue | null>(null)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = hue ?? freshHue(profiles ?? [])
  const problem = nameMessage(name, profiles ?? [])

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    setTouched(true)
    if (problem || busy) {
      input.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      onCreated(await call('profiles', 'create', { name: name.trim(), hue: chosen }))
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={t('profiles.create.title')}
      description={t('profiles.create.lede')}
      size="sm"
      initialFocus={input}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('profiles.create.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={profiles === null} onClick={() => void submit()}>
            {t('profiles.create.submit')}
          </Button>
        </>
      }
    >
      <form className="pf-dialog" onSubmit={(e) => void submit(e)} noValidate>
        <div className="sp-field">
          <label className="sp-field__label" htmlFor={nameId}>
            {t('profiles.create.name')}
          </label>
          <TextInput
            ref={input}
            id={nameId}
            value={name}
            maxLength={60}
            placeholder={t('profiles.create.namePlaceholder')}
            invalid={touched && problem !== null}
            aria-invalid={touched && problem !== null}
            aria-describedby={touched && problem ? `${nameId}-error` : undefined}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name && setTouched(true)}
          />
          {touched && problem && (
            <p id={`${nameId}-error`} className="pf-dialog__error" role="alert">
              {text(problem)}
            </p>
          )}
        </div>
        <div className="sp-field">
          <span className="sp-field__label" id={`${hueId}-label`}>
            {t('profiles.create.colour')}
          </span>
          <div className="pf-current pf-current--flush">
            <ProfileBadge name={name || '?'} hue={chosen} size={36} />
            <HueSwatches id={hueId} label={t('profiles.create.colour')} value={chosen} onChange={setHue} disabled={busy} />
          </div>
        </div>
        {error && (
          <p className="pf-dialog__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

export function DeleteProfileDialog({ open, profileId, onClose, onDeleted }: { open: boolean; profileId: string; onClose(): void; onDeleted(profile: Profile): void }): ReactElement {
  const t = useT()
  const text = (m: Message): string => t(m.key, m.vars)
  const profiles = useProfiles()
  const [summary, setSummary] = useState<ProfileDeletionSummary | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmId = useId()
  const input = useRef<HTMLInputElement>(null)
  const profile = profiles?.find((p) => p.id === profileId) ?? null
  const block = profiles && profile ? profileDeleteBlock(profile.id, profiles) : null

  useEffect(() => {
    let live = true
    call('profiles', 'deletionSummary', profileId).then(
      (s) => live && setSummary(s),
      (err: unknown) => live && setError(errorText(err)),
    )
    return () => {
      live = false
    }
  }, [profileId])

  const armed = profile !== null && !block && deleteArmed(typed, profile.name)
  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (!armed || !profile || busy) return
    setBusy(true)
    setError(null)
    try {
      await call('profiles', 'remove', profile.id, typed)
      onDeleted(profile)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const name = profile?.name ?? ''
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={t('profiles.delete.title', { name })}
      size="sm"
      role="alertdialog"
      initialFocus={input}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('profiles.delete.cancel')}
          </Button>
          <Button variant="danger" loading={busy} disabled={!armed} onClick={() => void submit()}>
            {busy ? t('profiles.delete.working') : t('profiles.delete.submit')}
          </Button>
        </>
      }
    >
      <form className="pf-dialog" onSubmit={(e) => void submit(e)} noValidate>
        {profiles !== null && !profile ? (
          <p className="pf-dialog__error" role="alert">
            {t('profiles.error.missing')}
          </p>
        ) : block ? (
          <p className="pf-dialog__reason" role="status">
            {text(deleteBlockMessage(block))}
          </p>
        ) : (
          <>
            <p className="pf-dialog__note">{t('profiles.delete.lede')}</p>
            {summary ? (
              <ul className="pf-dialog__list">
                {deletionRows(summary).map((row) => (
                  <li key={row.key}>{text(row)}</li>
                ))}
              </ul>
            ) : (
              !error && (
                <p className="pf-dialog__note" role="status">
                  <Spinner size={12} /> {t('profiles.delete.loading')}
                </p>
              )
            )}
            <p className="pf-dialog__note">{t('profiles.delete.shared')}</p>
            <div className="sp-field">
              <label className="sp-field__label" htmlFor={confirmId}>
                {t('profiles.delete.confirm', { name })}
              </label>
              <TextInput ref={input} id={confirmId} value={typed} autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setTyped(e.target.value)} />
            </div>
          </>
        )}
        {error && (
          <p className="pf-dialog__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
