/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// propose_pack's card (docs/packs.md › Companions as builders): the draft's
// name, the companion's note and what it asks for; Review and install opens
// the review on the Packs page. Nothing waits on it, and the companion can't
// install it: only this button leads there.
import type { ReactElement } from 'react'
import { Package } from 'lucide-react'
import { packsPageUrl } from '@shared/packs'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { PermissionList } from '../../packs/PermissionList'
import { Button, toast } from '../../ui'
import type { LogCardProps } from './registry'
import '../../packs/packs.css'

export function PackProposedCard({ item }: LogCardProps<'pack-proposed'>): ReactElement {
  const t = useT()
  const open = (review: boolean): void => {
    // A fresh address each time, so Review opens the review again after it was closed.
    void call('pages', 'open', `${packsPageUrl({ draft: item.packId, review })}&at=${Date.now()}`).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
  }
  // What it is, in the person's words: an app, a world, or a pack of other things.
  const label = item.permissions.some((l) => l.kind === 'apps') ? t('packs.card.labelApp') : item.permissions.some((l) => l.kind === 'worlds') ? t('packs.card.labelWorld') : t('packs.card.label')
  return (
    <section className="pk-chat-card" role="group" aria-label={`${label}: ${item.name}`}>
      <div className="pk-chat-card__head">
        <Package aria-hidden="true" />
        <span className="pk-chat-card__eyebrow">{label}</span>
        <span className="pk-chat-card__title">
          {item.name} <span className="pk-muted pk-small">{item.version}</span>
        </span>
      </div>
      {item.note && <p className="pk-muted pk-small">{item.note}</p>}
      <PermissionList lines={item.permissions} label={t('packs.detail.permissions')} />
      <div className="pk-actions">
        <Button size="sm" variant="primary" onClick={() => open(true)}>
          {t('packs.card.review')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => open(false)}>
          {t('packs.card.drafts')}
        </Button>
      </div>
      <p className="pk-foot">{t('packs.card.hint')}</p>
    </section>
  )
}
