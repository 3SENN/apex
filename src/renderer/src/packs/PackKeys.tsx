/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A pack's keys on its page (docs/apps.md › Keys): each secret the manifest
// asks for, the hosts Atelier sends it to, and whether it has a value. The value
// goes to main once and never comes back here: the field only ever writes.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { PackSummary } from '@shared/packs'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { TextInput } from '../settings/kit'
import { Badge, Button, useToast } from '../ui'

export function PackKeys({ pack, focusKey }: { pack: PackSummary; focusKey?: string | null }): ReactElement | null {
  const t = useT()
  if (pack.secrets.length === 0) return null
  return (
    <section className="pk-block" aria-label={t('packs.keys.title')}>
      <h4 className="pk-block__title">{t('packs.keys.title')}</h4>
      <p className="pk-muted pk-small">{t('packs.keys.intro')}</p>
      <ul className="pk-things">
        {pack.secrets.map((s) => (
          <KeyRow key={s.id} packId={pack.id} secret={s} enabled={pack.enabled} focus={focusKey === s.id} />
        ))}
      </ul>
    </section>
  )
}

function KeyRow({ packId, secret, enabled, focus }: { packId: string; secret: PackSummary['secrets'][number]; enabled: boolean; focus: boolean }): ReactElement {
  const t = useT()
  const toast = useToast()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // Opened from an app (atelier.secrets.request): straight to the field it asked for.
  useEffect(() => {
    if (!focus || !input.current) return
    input.current.scrollIntoView({ block: 'center' })
    input.current.focus()
  }, [focus])

  const act = async (what: 'save' | 'clear'): Promise<void> => {
    setBusy(what)
    try {
      if (what === 'save') {
        await call('packs', 'setSecret', packId, secret.id, value)
        setValue('')
        toast.show({ message: t('packs.keys.saved', { name: secret.name }) })
      } else {
        await call('packs', 'clearSecret', packId, secret.id)
        toast.show({ message: t('packs.keys.cleared', { name: secret.name }) })
      }
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const fieldId = `pk-key-${packId}-${secret.id}`
  return (
    <li className="pk-thing pk-key">
      <span className="pk-thing__text">
        <label htmlFor={fieldId}>{secret.name}</label>
        <span className="pk-thing__kind">{secret.description ? `${secret.description} ` : ''}{t('packs.keys.sentTo', { hosts: secret.hosts.join(', ') })}</span>
      </span>
      <Badge tone={secret.state === 'none' ? 'neutral' : 'success'}>{t(secret.state === 'set' ? 'packs.keys.stateSet' : secret.state === 'policy' ? 'packs.keys.stateManaged' : secret.state === 'env' ? 'packs.keys.stateEnv' : 'packs.keys.stateNone')}</Badge>
      {secret.state !== 'policy' && (
        <form
          className="pk-key__form"
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) void act('save')
          }}
        >
          <TextInput
            ref={input}
            id={fieldId}
            type="password"
            value={value}
            autoComplete="off"
            spellCheck={false}
            disabled={!enabled}
            placeholder={secret.state === 'set' ? t('packs.keys.replace') : t('packs.keys.paste')}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button size="sm" type="submit" variant="primary" disabled={!enabled || !value.trim()} loading={busy === 'save'}>
            {t('packs.keys.save')}
          </Button>
          {secret.state === 'set' && (
            <Button size="sm" variant="ghost" loading={busy === 'clear'} onClick={() => void act('clear')}>
              {t('packs.keys.clear')}
            </Button>
        )}
      </form>
      )}
    </li>
  )
}
