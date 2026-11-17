/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { CreditCard, Eye, EyeOff, KeyRound, MapPin, X } from 'lucide-react'
import type { OfferAction, SaveOfferProps } from '@shared/autofill'
import { call, errorText } from '../../../api'
import { useT, type MessageKey } from '../../../i18n/useT'
import { Button, IconButton } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'

// The save and update cards (OV-27, OV-29): a non-modal card at the tab's
// top right after a form was sent. The login card lets you correct the
// username and password (shown on request) before saving; the card and
// address cards list what would be kept. Return saves, Esc dismisses (the
// host reports it, and main counts a strike for cards), and "Never for this
// site" stops the offers. Main closes the card once it has answered.

const TITLE: Record<SaveOfferProps['kind'], Record<SaveOfferProps['mode'], MessageKey>> = {
  login: { save: 'autofill.save.title', update: 'autofill.update.title' },
  card: { save: 'autofill.save.cardTitle', update: 'autofill.save.cardTitle' },
  address: { save: 'autofill.save.addressTitle', update: 'autofill.save.addressTitle' },
}

const ICON = { login: KeyRound, card: CreditCard, address: MapPin } as const

export function SaveOffer({ props, close, anchorRect }: SurfaceComponentProps<SaveOfferProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const userId = useId()
  const passId = useId()
  const hintId = useId()
  const isLogin = props.kind === 'login'
  const initialUser = props.fields.find((f) => f.key === 'username')?.value ?? ''
  const initialPass = props.fields.find((f) => f.key === 'password')?.value ?? ''
  const [username, setUsername] = useState(initialUser)
  const [password, setPassword] = useState(initialPass)
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState<OfferAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const saveRef = useRef<HTMLButtonElement | null>(null)

  // Focus lands on the main action, so Return saves straight away.
  useEffect(() => {
    saveRef.current?.focus()
  }, [])

  const respond = async (action: OfferAction): Promise<void> => {
    if (busy) return
    setBusy(action)
    setError(null)
    try {
      const edited = isLogin && (action === 'save' || action === 'update') ? { username: username.trim(), password } : undefined
      await call('autofill', 'respondOffer', props.offerId, action, edited)
      close()
    } catch (err) {
      setError(errorText(err))
      setBusy(null)
    }
  }

  const primary: OfferAction = props.mode === 'update' ? 'update' : 'save'
  const canSave = !isLogin || password.length > 0
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (canSave) void respond(primary)
  }

  const Icon = ICON[props.kind]
  const rect = anchorRect ?? props.anchorRect
  const where = props.embeddingSite ? t('autofill.popup.crossSite', { site: props.siteLabel, embedding: props.embeddingSite }) : t('autofill.save.forSite', { site: props.siteLabel })
  return (
    <form className="afs" style={{ width: rect.width, minHeight: rect.height }} role="dialog" aria-labelledby={titleId} onSubmit={onSubmit}>
      <header className="afs__head">
        <span className="afs__icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        <div className="afs__heading">
          <h2 id={titleId} className="afs__title">
            {t(TITLE[props.kind][props.mode])}
          </h2>
          <p className="afs__site" title={where}>
            {where}
          </p>
        </div>
        <IconButton size="sm" variant="ghost" icon={<X size={14} />} label={t('autofill.save.close')} onClick={() => void respond('dismiss')} />
      </header>

      {isLogin ? (
        <div className="afs__fields">
          <label className="afs__field" htmlFor={userId}>
            <span className="afs__label">{t('autofill.save.username')}</span>
            <input id={userId} className="afs__input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} maxLength={512} />
          </label>
          <label className="afs__field" htmlFor={passId}>
            <span className="afs__label">{t('autofill.save.password')}</span>
            <span className="afs__secret">
              <input
                id={passId}
                className="afs__input afs__input--secret"
                type={shown ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!canSave}
                aria-describedby={!canSave ? hintId : undefined}
              />
              <IconButton
                size="sm"
                variant="ghost"
                className="afs__reveal"
                icon={shown ? <EyeOff size={14} /> : <Eye size={14} />}
                label={t(shown ? 'autofill.save.hide' : 'autofill.save.show')}
                aria-pressed={shown}
                onClick={() => setShown((v) => !v)}
              />
            </span>
          </label>
          {!canSave && (
            <p id={hintId} className="afs__hint">
              {t('autofill.save.passwordEmpty')}
            </p>
          )}
        </div>
      ) : (
        <dl className="afs__list">
          {props.fields.map((f) => (
            <div key={f.key} className="afs__row">
              <dt>{f.label}</dt>
              <dd title={f.masked ? undefined : f.value}>{f.masked ? '••••••••' : f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {props.kind === 'card' && <p className="afs__note">{t('autofill.save.cardNote')}</p>}
      {error && (
        <p className="afs__error" role="alert">
          {error}
        </p>
      )}

      <footer className="afs__actions">
        {props.kind === 'address' ? (
          <Button size="sm" variant="ghost" onClick={() => void respond('dismiss')} disabled={busy !== null}>
            {t('autofill.save.notNow')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void respond('never')} loading={busy === 'never'} disabled={busy !== null}>
            {t('autofill.save.never')}
          </Button>
        )}
        <Button ref={saveRef} size="sm" variant="primary" type="submit" loading={busy === primary} disabled={!canSave || (busy !== null && busy !== primary)}>
          {t(primary === 'update' ? 'autofill.save.update' : 'autofill.save.save')}
        </Button>
      </footer>
    </form>
  )
}
