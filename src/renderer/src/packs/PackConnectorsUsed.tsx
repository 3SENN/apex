/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The person's connectors a pack's apps use (docs/apps.md › Apps for
// organisations), on its page: whether each is connected here, with Connect…
// for one that isn't. The tools run as the person set them in Connectors.
import type { ReactElement } from 'react'
import { DIRECTORY_ID } from '@shared/connectors'
import type { PackSummary } from '@shared/packs'
import { call } from '../api'
import { useT } from '../i18n/useT'
import { Badge, Button } from '../ui'

export function PackConnectorsUsed({ pack }: { pack: PackSummary }): ReactElement | null {
  const t = useT()
  if (pack.connectorsUsed.length === 0) return null
  return (
    <section className="pk-block" aria-label={t('packs.connectorsUsed.title')}>
      <h4 className="pk-block__title">{t('packs.connectorsUsed.title')}</h4>
      <p className="pk-muted pk-small">{t('packs.connectorsUsed.body')}</p>
      <ul className="pk-things">
        {pack.connectorsUsed.map((c) => (
          <li key={c.ref} className="pk-thing">
            <span className="pk-thing__text">
              <span>{c.name ?? c.ref}</span>
            </span>
            <span className="pk-actions">
              <Badge tone={c.connected ? 'success' : 'neutral'}>{t(c.connected ? 'packs.connectorsUsed.connected' : 'packs.connectorsUsed.notConnected')}</Badge>
              <Button
                size="sm"
                variant={c.connected ? 'ghost' : 'secondary'}
                onClick={() => void call('pages', 'open', !c.connected && DIRECTORY_ID.test(c.ref) ? `apex://connectors?connect=${encodeURIComponent(c.ref)}&from=${encodeURIComponent(pack.name)}` : 'apex://connectors')}
              >
                {t(c.connected ? 'packs.connectorsUsed.manage' : 'packs.connectorsUsed.connect')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
