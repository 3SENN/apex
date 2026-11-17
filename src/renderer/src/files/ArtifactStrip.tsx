/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { FileSearch, FolderOpen, ShieldCheck } from 'lucide-react'
import { artifactIdOf } from '@shared/files'
import type { TabInfo } from '@shared/ipc'
import { t } from '@shared/i18n/core'
import { call, errorText } from '../api'
import { useLiveResource } from '../settings/data'
import { IconButton, toast } from '../ui'
import { openViewer } from './open'
import './files.css'

// The artifact tab's header strip: while an apex-artifact:// tab is
// active the toolbar shows that it is a sandboxed artifact, its file name,
// Open file (the viewer) and Show in Finder. The artifact itself has no
// preload and can't reach Apex, so the strip lives in the chrome.

const fail = (err: unknown): void => void toast.show({ tone: 'error', message: errorText(err) })

function Strip({ fileId, fallbackName }: { fileId: string; fallbackName: string }): ReactElement {
  const files = useLiveResource(() => call('files', 'list'), 'library-files', (e) => e.items)
  const file = files.data?.find((f) => f.id === fileId) ?? null
  const name = file?.name ?? fallbackName
  return (
    <div className="fv-artifact-strip" role="group" aria-label={t('files.artifact.label')}>
      <span className="fv-artifact-strip__label" title={t('files.artifact.sandboxed')}>
        <ShieldCheck aria-hidden />
        {t('files.artifact.label')}
      </span>
      <span className="fv-artifact-strip__name" title={name}>
        {name}
      </span>
      <span className="ui-sr-only">{t('files.artifact.sandboxed')}</span>
      <IconButton size="sm" label={t('files.artifact.openFile')} icon={<FileSearch />} onClick={() => void openViewer({ kind: 'library', id: fileId }, { name, newTab: true }).catch(fail)} />
      <IconButton size="sm" label={t('files.action.reveal')} icon={<FolderOpen />} disabled={!file} onClick={() => void call('files', 'reveal', fileId).catch(fail)} />
    </div>
  )
}

/** Draws nothing unless the active tab is an artifact. */
export function ArtifactStrip({ tab }: { tab: TabInfo | null }): ReactElement | null {
  const id = tab ? artifactIdOf(tab.url) : null
  if (!tab || !id) return null
  return <Strip fileId={id} fallbackName={tab.title || t('files.artifact.label')} />
}
