/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The app preview card, mounted by the `app-built` log card:
// a still of the draft rendered inside the app's own sandbox, with Save
// (the draft becomes the version that runs) and Try it (the draft in its
// own sandboxed tab). It follows the app live, so a save from Workspace ›
// Apps or a newer build shows here too.
import { useState, type ReactElement } from 'react'
import { AppWindow, Check, ExternalLink, ImageOff } from 'lucide-react'
import type { AppSummary, AppVersion } from '@shared/apps'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { useEvent, useResource } from '../settings/data'
import { Badge, Button, ErrorState, Skeleton, toast } from '../ui'
import { goWorkspace } from '../workspace/open'
import { AppGlyph } from './AppGlyph'
import './platform.css'

export interface AppPreviewCardProps {
  appId: string
  versionId: string
  chatId: string
  requestId: string
}

type AppDetail = AppSummary & { versions: AppVersion[] }

export function AppPreviewCard({ appId, versionId }: AppPreviewCardProps): ReactElement {
  const app = useResource<AppDetail>(() => call('apps', 'get', appId), appId, { keep: true })
  const [gone, setGone] = useState(false)
  const [saving, setSaving] = useState(false)
  useEvent('apps', (e) => {
    const present = e.items.some((a) => a.id === appId)
    setGone(!present)
    if (present) void app.reload()
  })

  if (gone || (app.error && !app.data)) {
    return (
      <div className="pl-card" role="group" aria-label={t('platform.apps.card.label')}>
        <ErrorState compact title={t('platform.apps.card.goneTitle')} message={gone ? t('platform.apps.card.goneDetail') : app.error} onRetry={gone ? undefined : app.reload} />
      </div>
    )
  }
  if (!app.data) {
    return (
      <div className="pl-card" aria-busy="true" aria-label={t('platform.apps.card.loading')}>
        <Skeleton height={40} />
        <Skeleton height={180} />
      </div>
    )
  }

  const data = app.data
  const version = data.versions.find((v) => v.id === versionId) ?? null
  const isCurrent = data.currentVersionId === versionId
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await call('apps', 'saveDraft', appId, versionId)
      toast.show({ tone: 'success', message: t('platform.apps.card.saved', { name: data.name }), action: { label: t('platform.apps.card.seeInApps'), onAction: () => goWorkspace('apps', appId) } })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setSaving(false)
    }
  }
  const open = (): void => {
    Promise.resolve(call('apps', 'open', appId, isCurrent ? undefined : versionId)).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
  }

  return (
    <div className="pl-card" role="group" aria-label={t('platform.apps.card.labelNamed', { name: data.name })}>
      <div className="pl-card__head">
        <AppGlyph id={data.id} name={data.name} size="sm" />
        <div className="pl-card__titles">
          <p className="pl-card__title">{data.name}</p>
          {data.description && <p className="pl-card__sub">{data.description}</p>}
        </div>
        {version && (isCurrent ? <Badge tone="success">{t('platform.apps.label.saved')}</Badge> : <Badge tone="warning">{t('platform.apps.label.draft')}</Badge>)}
      </div>
      {version ? (
        <>
          <AppStill appId={appId} versionId={versionId} name={data.name} onOpen={open} />
          <p className="pl-card__sub">{isCurrent ? t('platform.apps.card.savedNote') : t('platform.apps.card.draftNote')}</p>
          <div className="pl-card__actions">
            {isCurrent ? (
              <Button variant="primary" size="sm" icon={<AppWindow />} onClick={open}>
                {t('platform.apps.open')}
              </Button>
            ) : (
              <>
                <Button variant="primary" size="sm" icon={<Check />} loading={saving} onClick={() => void save()}>
                  {t('platform.apps.card.save')}
                </Button>
                <Button size="sm" icon={<ExternalLink />} onClick={open}>
                  {t('platform.apps.card.tryIt')}
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <p className="pl-card__sub">{t('platform.apps.card.versionGone')}</p>
      )}
    </div>
  )
}

/** A still of one version, rendered off-screen in the app's sandbox; clicking it opens that version. */
export function AppStill({ appId, versionId, name, onOpen }: { appId: string; versionId: string; name: string; onOpen?(): void }): ReactElement {
  const still = useResource<string | null>(() => call('apps', 'preview', appId, versionId), `${appId}:${versionId}`)
  const body = still.loading ? (
    <Skeleton height="100%" width="100%" />
  ) : still.data ? (
    <img src={still.data} alt={t('platform.apps.stillAlt', { name })} draggable={false} />
  ) : (
    <span className="pl-preview__empty">
      <ImageOff aria-hidden />
      {t('platform.apps.noStill')}
    </span>
  )
  if (!onOpen) return <div className="pl-preview">{body}</div>
  return (
    <button type="button" className="pl-preview pl-preview--button" onClick={onOpen} aria-label={t('platform.apps.openNamed', { name })}>
      {body}
    </button>
  )
}
