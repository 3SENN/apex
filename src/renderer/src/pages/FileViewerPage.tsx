/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://file?src=…[&edit=1] (OV-32): one file Apex holds, drawn by the
// shared renderers. Text kinds can be edited (straight away with &edit=1);
// the header exports, opens HTML, SVG and Markdown as a sandboxed artifact,
// renames, deletes (to the Trash) and shows the file in Finder. Missing,
// refused, failed and still-being-written files have their own states, and
// the document's token ends with this tab.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Ellipsis, FileLock2, FileX, Pencil, Share, Sparkles } from 'lucide-react'
import { fileViewerUrl, parseFileViewerUrl, type ViewerDoc } from '@shared/files'
import { kindLabelKey } from '@shared/fileKinds'
import { apex, call, errorText, formatBytes } from '../api'
import { FilePreview, RenameDialog, SaveFailedNotice, useViewerDoc } from '../files'
import '../files/files.css'
import { ViewerVersionHistory } from '../workspace/VersionHistoryPanel'
import { t } from '../i18n/useT'
import { Badge, Button, EmptyState, ErrorState, IconButton, SkeletonText, menuSeparator, showMenu, useConfirm, useToast } from '../ui'

const SOURCE_KEY = {
  library: 'files.viewer.source.library',
  'companion-file': 'files.viewer.source.companion',
  memory: 'files.viewer.source.memory',
  skill: 'files.viewer.source.skill',
  meeting: 'files.viewer.source.meeting',
  'chat-file': 'files.viewer.source.chat',
  attachment: 'files.viewer.source.attachment',
  local: 'files.viewer.source.local',
} as const

export interface FileViewerPageProps {
  url: string
  tabId: string
}

export function FileViewerPage({ url, tabId }: FileViewerPageProps): ReactElement {
  const parsed = useMemo(() => parseFileViewerUrl(url), [url])
  if (!parsed) {
    return (
      <div className="fv-page">
        <div className="fv-page__body fv-page__state">
          <EmptyState icon={<FileLock2 />} title={t('files.viewer.refused')} description={t('files.error.invalidPath')} />
        </div>
      </div>
    )
  }
  return <Viewer key={url} target={parsed.target} startEditing={parsed.edit} tabId={tabId} />
}

function Viewer({ target, startEditing, tabId }: { target: NonNullable<ReturnType<typeof parseFileViewerUrl>>['target']; startEditing: boolean; tabId: string }): ReactElement {
  const handle = useViewerDoc(target, tabId)
  const { doc } = handle
  const confirm = useConfirm()
  const toast = useToast()
  const [draft, setDraft] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  // The file's saved versions beside the viewer.
  const [versions, setVersions] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const autoEdit = useRef(startEditing)

  const editing = draft !== null
  const dirty = editing && draft !== (doc?.text ?? '')

  // &edit=1: straight into edit mode once the document is in (only once).
  useEffect(() => {
    if (!autoEdit.current || !doc) return
    autoEdit.current = false
    if (doc.editable) setDraft(doc.text ?? '')
  }, [doc])

  useEffect(() => {
    if (editing) editor.current?.focus()
  }, [editing])

  const fail = (err: unknown): void => void toast.show({ tone: 'error', message: errorText(err) })

  const save = async (): Promise<void> => {
    if (!doc || draft === null) return
    setSaving(true)
    try {
      const next = await call('viewer', 'save', doc.token, draft)
      handle.setDoc(next)
      setDraft(null)
      setSaveError(null)
      toast.show({ tone: 'success', message: t('files.toast.saved') })
    } catch (err) {
      // The edits stay in the editor; Retry sends them again.
      setSaveError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const cancelEdit = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: t('files.viewer.discard.title'), message: t('files.viewer.discard.message'), confirmLabel: t('files.viewer.discard.confirm'), destructive: true }))) return
    setDraft(null)
    setSaveError(null)
  }

  const remove = async (current: ViewerDoc): Promise<void> => {
    if (dirty || !(await confirm({ title: t('files.delete.title', { name: current.name }), message: t('files.delete.message'), confirmLabel: t('files.delete.confirm'), destructive: true }))) return
    try {
      await call('viewer', 'remove', current.token)
      toast.show({ message: t('files.toast.deleted', { name: current.name }) })
      // The file is gone, so its viewer tab goes too.
      await apex.tabs.close(tabId)
    } catch (err) {
      fail(err)
    }
  }

  const exportCopy = async (current: ViewerDoc): Promise<void> => {
    try {
      const path = await call('viewer', 'export', current.token)
      if (path) toast.show({ tone: 'success', message: t('files.toast.exported') })
    } catch (err) {
      fail(err)
    }
  }

  const openArtifact = (current: ViewerDoc): void => void call('viewer', 'openArtifact', current.token).catch(fail)

  const more = async (anchor: HTMLElement, current: ViewerDoc): Promise<void> => {
    const picked = await showMenu(
      [
        { id: 'reveal', label: t('files.action.reveal'), enabled: current.revealable },
        { id: 'rename', label: t('files.action.rename'), enabled: current.renamable && !editing },
        { id: 'versions', label: t('workspace.versions.title'), enabled: !editing },
        menuSeparator(),
        { id: 'delete', label: t('files.action.delete'), enabled: current.deletable && !editing, danger: true },
      ],
      anchor,
    )
    if (picked === 'reveal') void call('viewer', 'reveal', current.token).catch(fail)
    else if (picked === 'rename') setRenaming(current.name)
    else if (picked === 'versions') setVersions(true)
    else if (picked === 'delete') void remove(current)
  }

  // ⌘S saves and Esc leaves edit mode while editing.
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        void cancelEdit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  let body: ReactElement
  if (handle.loading && !doc) {
    body = (
      <div aria-busy="true" aria-label={t('files.viewer.loading')}>
        <SkeletonText lines={8} />
      </div>
    )
  } else if (!doc) {
    body = (
      <div className="fv-page__state">
        {handle.refused ? (
          <EmptyState icon={<FileLock2 />} title={t('files.viewer.refused')} description={handle.error ?? undefined} />
        ) : (
          <ErrorState title={t('files.viewer.loadFailed')} message={handle.error ?? undefined} onRetry={handle.reload} retryLabel={t('files.action.retry')} />
        )}
      </div>
    )
  } else if (editing) {
    body = (
      <>
        {saveError && <SaveFailedNotice reason={saveError} onRetry={() => void save()} />}
        <label className="ui-sr-only" htmlFor="fv-editor">
          {t('files.viewer.editor', { name: doc.name })}
        </label>
        <textarea id="fv-editor" ref={editor} className="fv-editor" value={draft ?? ''} spellCheck={doc.previewable === 'markdown' || doc.previewable === 'text'} onChange={(e) => setDraft(e.target.value)} />
      </>
    )
  } else if (doc.state === 'missing') {
    body = (
      <div className="fv-page__state">
        <EmptyState icon={<FileX />} title={t('files.viewer.missing')} description={doc.error ?? t('files.viewer.missing.description')} />
      </div>
    )
  } else {
    body = <FilePreview doc={doc} onRetry={handle.reload} onOpenArtifact={() => openArtifact(doc)} />
  }

  return (
    <div className="fv-page">
      <header className="fv-page__header">
        <div className="fv-page__title">
          <h1 className="fv-page__name" title={doc?.name}>
            {doc?.name ?? t('files.viewer.loading')}
          </h1>
          {doc && (
            <span className="fv-page__sub">
              <span>{t(SOURCE_KEY[doc.source])}</span>
              {doc.state !== 'missing' && (
                <>
                  <span aria-hidden>·</span>
                  <span>{t(kindLabelKey(doc.previewable))}</span>
                  <span aria-hidden>·</span>
                  <span>{formatBytes(doc.size)}</span>
                </>
              )}
              {editing && dirty && <Badge tone="accent">{t('files.viewer.unsaved')}</Badge>}
              {!doc.editable && doc.state === 'ready' && doc.text !== undefined && !editing && <Badge>{t('files.viewer.readOnly')}</Badge>}
            </span>
          )}
        </div>
        {doc && (
          <div className="fv-page__actions">
            {editing ? (
              <>
                <Button variant="secondary" onClick={() => void cancelEdit()}>
                  {t('files.action.cancel')}
                </Button>
                <Button variant="primary" loading={saving} onClick={() => void save()}>
                  {t('files.action.save')}
                </Button>
              </>
            ) : (
              <>
                {doc.editable && (
                  <Button variant="secondary" icon={<Pencil />} onClick={() => setDraft(doc.text ?? '')}>
                    {t('files.action.edit')}
                  </Button>
                )}
                {doc.artifactable && (
                  <Button variant="secondary" icon={<Sparkles />} onClick={() => openArtifact(doc)}>
                    {t('files.action.openArtifact')}
                  </Button>
                )}
                {doc.exportable && <IconButton label={t('files.action.export')} icon={<Share />} onClick={() => void exportCopy(doc)} />}
                <IconButton label={t('files.action.more')} aria-haspopup="menu" icon={<Ellipsis />} onClick={(e) => void more(e.currentTarget, doc)} />
              </>
            )}
          </div>
        )}
      </header>
      <div className={versions ? 'fv-page__split' : undefined}>
        <main className="fv-page__body" aria-label={doc?.name ?? t('files.viewer.loading')}>
          {body}
        </main>
        {versions && <ViewerVersionHistory target={target} onRestore={handle.reload} onClose={() => setVersions(false)} />}
      </div>
      <RenameDialog
        name={renaming}
        onClose={() => setRenaming(null)}
        onRename={async (name) => {
          if (!doc) return
          const next = await call('viewer', 'rename', doc.token, name)
          handle.setDoc(next)
          // A path-addressed file moved: point this tab at its new path, so a reload still finds it.
          if ((target.kind === 'companion-file' || target.kind === 'memory') && next.name !== doc.name) {
            const parts = target.path.split('/')
            parts[parts.length - 1] = next.name
            void apex.nav.go(tabId, fileViewerUrl({ ...target, path: parts.join('/') }, { name: next.name }))
          }
        }}
      />
    </div>
  )
}
