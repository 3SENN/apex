/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// One entry of a community index on Browse (docs/apps.md › The community
// index): its picture (fetched by main, so the page reaches no other site),
// washed in its colour while it loads or when it has none, what it is, who
// made it, its size, and Install or Update, which open the same review as
// every other way in.
import { useEffect, useState, type ReactElement } from 'react'
import type { PackIndexEntry } from '@shared/packs'
import { call } from '../api'
import { t } from '../i18n/useT'
import { Badge, Button } from '../ui'
import { formatBytes } from './logic'

export function BrowseCard({ entry, busy, onInstall, onOpen }: { entry: PackIndexEntry; busy: boolean; onInstall(): void; onOpen?: () => void }): ReactElement {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    if (!entry.hasImage) return
    let live = true
    void call('packs', 'browseImage', entry.indexUrl, entry.id)
      .then((data) => {
        if (live) setImage(data)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [entry.indexUrl, entry.id, entry.hasImage])

  const installed = entry.installedVersion !== null
  const newer = installed && entry.installedVersion !== entry.version
  const wash = entry.color ?? 'var(--accent)'
  return (
    <li className="pk-browse__card">
      <div className="pk-browse__art" style={{ background: `color-mix(in srgb, ${wash} 28%, var(--surface-2, transparent))` }} aria-hidden>
        {image && <img src={image} alt="" />}
      </div>
      <div className="pk-browse__body">
        <span className="pk-item__name">
          {entry.name}
          <span className="pk-muted pk-small">{entry.version}</span>
        </span>
        <span className="pk-browse__meta">
          <Badge tone={entry.kind === 'app' ? 'accent' : entry.kind === 'world' ? 'info' : 'neutral'}>{t(`packs.browse.kindLabel.${entry.kind}`)}</Badge>
          {entry.category && <span className="pk-muted pk-small">{t(`packs.browse.category.${entry.category}`)}</span>}
          {entry.size !== null && <span className="pk-muted pk-small">{formatBytes(entry.size)}</span>}
          {installed && <Badge tone={newer ? 'info' : 'success'}>{newer ? t('packs.browse.newer', { version: entry.installedVersion ?? '' }) : t('packs.browse.installed')}</Badge>}
        </span>
        <span className="pk-item__summary pk-browse__text">{entry.description}</span>
        {entry.author && <span className="pk-item__summary">{t('packs.browse.by', { author: entry.author })}</span>}
        <div className="pk-browse__actions">
          {installed && !newer ? (
            onOpen ? (
              <Button size="sm" variant="secondary" onClick={onOpen}>
                {t('packs.row.open')}
              </Button>
            ) : null
          ) : (
            <Button size="sm" variant="secondary" loading={busy} onClick={onInstall}>
              {newer ? t('packs.browse.update') : t('packs.browse.install')}
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}
