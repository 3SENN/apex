/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The version history side panel (OV-33), mounted in the file
// viewer: lists a file's versions (newest first, the current one marked,
// each labelled saved, restored, deleted or moved with its time), previews
// the one picked and restores it. Loading, none, and error with Retry.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { History, RotateCcw, X } from 'lucide-react'
import type { ViewerTarget } from '@shared/files'
import { sameFileRef, type FileRef, type FileVersion } from '@shared/workspace'
import { call, errorText, formatBytes } from '../api'
import { useT } from '../i18n/useT'
import { useEvent, useResource } from '../settings/data'
import { Button, EmptyState, ErrorState, IconButton, RelativeTime, SkeletonRows, SkeletonText, formatAbsolute, toast, useRovingFocus } from '../ui'
import './workspace.css'

export interface VersionHistoryPanelProps {
  fileRef: FileRef
  onRestore(): void
  /** Shows a close button when given. */
  onClose?(): void
}

export function VersionHistoryPanel({ fileRef, onRestore, onClose }: VersionHistoryPanelProps): ReactElement {
  const t = useT()
  const key = JSON.stringify(fileRef)
  const versions = useResource(() => call('versions', 'list', fileRef), key)
  useEvent('versions', (e) => {
    if (sameFileRef(e.ref, fileRef)) void versions.reload()
  })
  const [picked, setPicked] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ id: string; text: string | null; error: string | null } | null>(null)
  const [restoring, setRestoring] = useState(false)
  const list = useRef<HTMLUListElement>(null)
  const onListKey = useRovingFocus(list, {
    orientation: 'vertical',
    onMove: (el) => {
      if (el.dataset.version) setPicked(el.dataset.version)
    },
  })

  const items = versions.data ?? []
  const selected = items.find((v) => v.id === picked) ?? items[0] ?? null

  // A different file starts over.
  useEffect(() => {
    setPicked(null)
    setPreview(null)
  }, [key])

  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!selected) return
    let live = true
    setPreview({ id: selected.id, text: null, error: null })
    Promise.resolve(call('versions', 'read', fileRef, selected.id))
      .then((text) => live && setPreview({ id: selected.id, text, error: null }))
      .catch((err: unknown) => live && setPreview({ id: selected.id, text: null, error: errorText(err) }))
    return () => {
      live = false
    }
  }, [selected?.id, key, attempt])

  const restore = async (version: FileVersion): Promise<void> => {
    setRestoring(true)
    try {
      await call('versions', 'restore', fileRef, version.id)
      toast.show({ message: t('workspace.versions.restored', { time: formatAbsolute(version.at) }), tone: 'success' })
      setPicked(null)
      await versions.reload()
      onRestore()
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setRestoring(false)
    }
  }

  let body: ReactElement
  if (versions.loading && !versions.data) body = <SkeletonRows rows={5} label={t('workspace.versions.title')} />
  else if (versions.error && !versions.data) body = <ErrorState compact title={t('workspace.versions.error')} message={versions.error} onRetry={() => versions.reload()} />
  else if (items.length === 0) body = <EmptyState compact icon={<History />} title={t('workspace.versions.emptyTitle')} description={t('workspace.versions.emptyText')} />
  else
    body = (
      <>
        <ul ref={list} className="ws-versions__list" role="listbox" aria-label={t('workspace.versions.list')} onKeyDown={onListKey}>
          {items.map((v) => (
            <li key={v.id} role="presentation">
              <button
                type="button"
                role="option"
                className="ws-version"
                data-version={v.id}
                aria-selected={selected?.id === v.id}
                tabIndex={selected?.id === v.id ? 0 : -1}
                onClick={() => setPicked(v.id)}
              >
                <span className="ws-version__when">
                  <RelativeTime value={v.at} className="ws-version__time" />
                  <span className="ws-version__label">
                    {t(`workspace.versions.label.${v.label}`)} · {formatBytes(v.size)}
                  </span>
                </span>
                {v.current && <span className="ws-pill">{t('workspace.versions.current')}</span>}
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <section className="ws-versions__preview" aria-label={t('workspace.versions.preview', { time: formatAbsolute(selected.at) })}>
            {preview?.id === selected.id && preview.error ? (
              <ErrorState compact title={t('workspace.versions.previewError')} message={preview.error} onRetry={() => setAttempt((n) => n + 1)} />
            ) : preview?.id === selected.id && preview.text !== null ? (
              <pre tabIndex={0}>{preview.text}</pre>
            ) : (
              <div className="ws-versions__loading">
                <SkeletonText lines={6} />
              </div>
            )}
            {!selected.current && (
              <div className="ws-versions__actions">
                <Button fullWidth icon={<RotateCcw />} loading={restoring} onClick={() => void restore(selected)}>
                  {t('workspace.versions.restore')}
                </Button>
              </div>
            )}
          </section>
        )}
      </>
    )

  return (
    <aside className="ws-versions" aria-label={t('workspace.versions.title')}>
      <div className="ws-versions__head">
        <h2>{t('workspace.versions.title')}</h2>
        {onClose && <IconButton size="sm" label={t('workspace.versions.close')} icon={<X />} onClick={onClose} />}
      </div>
      {body}
    </aside>
  )
}

/**
 * For the file viewer: the panel for whatever the viewer shows. Local files map
 * through the folder grants (versions.refFor); a target with no history
 * shows the "no earlier versions" state.
 */
export function ViewerVersionHistory({ target, onRestore, onClose }: { target: ViewerTarget; onRestore(): void; onClose?(): void }): ReactElement {
  const t = useT()
  const key = JSON.stringify(target)
  const ref = useResource(() => call('versions', 'refFor', target), key)
  if (ref.data)
    return <VersionHistoryPanel fileRef={ref.data} onRestore={onRestore} onClose={onClose} />
  return (
    <aside className="ws-versions" aria-label={t('workspace.versions.title')}>
      <div className="ws-versions__head">
        <h2>{t('workspace.versions.title')}</h2>
        {onClose && <IconButton size="sm" label={t('workspace.versions.close')} icon={<X />} onClick={onClose} />}
      </div>
      {ref.loading ? (
        <SkeletonRows rows={4} label={t('workspace.versions.title')} />
      ) : ref.error ? (
        <ErrorState compact title={t('workspace.versions.error')} message={ref.error} onRetry={() => ref.reload()} />
      ) : (
        <EmptyState compact icon={<History />} title={t('workspace.versions.emptyTitle')} description={t('workspace.versions.emptyText')} />
      )}
    </aside>
  )
}
