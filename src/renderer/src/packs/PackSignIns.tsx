/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A pack's sign-ins on its page (docs/apps.md › Apps for organisations):
// what each signs in to, where its token goes, who is signed in, and Sign in
// or Sign out. Apex runs the sign-in in a tab and keeps the tokens in main;
// this page only ever learns the name of who signed in.
import { useState, type ReactElement } from 'react'
import type { PackSummary } from '@shared/packs'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Badge, Button, useToast } from '../ui'

export function PackSignIns({ pack }: { pack: PackSummary }): ReactElement | null {
  const t = useT()
  if (pack.signIns.length === 0) return null
  return (
    <section className="pk-block" aria-label={t('packs.signIns.title')}>
      <h4 className="pk-block__title">{t('packs.signIns.title')}</h4>
      <p className="pk-muted pk-small">{t('packs.signIns.body')}</p>
      <ul className="pk-things">
        {pack.signIns.map((s) => (
          <SignInRow key={s.id} packId={pack.id} signIn={s} enabled={pack.enabled} />
        ))}
      </ul>
    </section>
  )
}

function SignInRow({ packId, signIn, enabled }: { packId: string; signIn: PackSummary['signIns'][number]; enabled: boolean }): ReactElement {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const act = async (): Promise<void> => {
    setBusy(true)
    try {
      if (signIn.signedIn) {
        await call('packs', 'signOut', packId, signIn.id)
        toast.show({ message: t('packs.signIns.signedOutToast', { name: signIn.name }) })
      } else await call('packs', 'signIn', packId, signIn.id)
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="pk-thing">
      <span className="pk-thing__text">
        <span>{signIn.name}</span>
        <span className="pk-thing__kind">
          {t('packs.signIns.goesTo', { issuer: signIn.issuer, hosts: signIn.hosts.join(', ') })}
          {signIn.managed ? ` · ${t('packs.signIns.managed')}` : ''}
        </span>
      </span>
      <span className="pk-actions">
        <Badge tone={signIn.signedIn ? 'success' : 'neutral'}>
          {signIn.signedIn ? (signIn.user ? t('packs.signIns.signedInAs', { user: signIn.user }) : t('packs.signIns.signedIn')) : t('packs.signIns.signedOut')}
        </Badge>
        <Button size="sm" variant={signIn.signedIn ? 'ghost' : 'primary'} disabled={!enabled} loading={busy} onClick={() => void act()}>
          {signIn.signedIn ? t('packs.signIns.signOut') : t('packs.signIns.signIn')}
        </Button>
      </span>
    </li>
  )
}
