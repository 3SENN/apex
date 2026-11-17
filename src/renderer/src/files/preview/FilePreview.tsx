/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { AudioLines, FileArchive, FileQuestion, FileText, FileX, Image as ImageIcon, Scissors, TriangleAlert, Video } from 'lucide-react'
import type { FilePreviewable, ViewerDoc } from '@shared/files'
import { kindLabelKey, parseFrontmatter } from '@shared/fileKinds'
import { t } from '@shared/i18n/core'
import { formatBytes } from '../../api'
import { Markdown } from '../../chat/Markdown'
import '../../chat/chat.css'
import { EmptyState, ErrorState, Spinner, cx } from '../../ui'
import '../files.css'
import { CodeView } from './CodeView'
import { HtmlView } from './HtmlView'
import { PdfView } from './PdfView'
import { SheetView } from './SheetView'

// The shared file renderers (OV-32), used by the viewer page, quick look,
// the chat files modal (CH-28) and the workspace surfaces. One switch on what the file
// can show as; each kind has its own state for a missing, failed, empty or
// still-being-written file.

export interface FilePreviewProps {
  doc: ViewerDoc
  /** Tighter, shorter renderers for quick look and the chat files modal. */
  compact?: boolean
  /** Shown on a failed load. */
  onRetry?(): void | Promise<unknown>
  /** HTML previews offer to open the file as an artifact. */
  onOpenArtifact?(): void
}

function placeholderIcon(kind: FilePreviewable): ReactElement {
  switch (kind) {
    case 'image':
    case 'svg':
      return <ImageIcon aria-hidden />
    case 'audio':
      return <AudioLines aria-hidden />
    case 'video':
      return <Video aria-hidden />
    case 'binary':
      return <FileArchive aria-hidden />
    case 'empty':
      return <FileText aria-hidden />
    default:
      return <FileQuestion aria-hidden />
  }
}

/** Binary, empty and unknown files: what it is, with no attempt to draw it. */
export function FilePlaceholder({ doc, message }: { doc: Pick<ViewerDoc, 'name' | 'size' | 'previewable'>; message?: string }): ReactElement {
  return (
    <div className="fv-placeholder" role="note">
      <span className="fv-placeholder__icon">{placeholderIcon(doc.previewable)}</span>
      <span className="fv-placeholder__name">{doc.name}</span>
      <span className="fv-placeholder__meta">
        {t(kindLabelKey(doc.previewable))}
        {doc.previewable !== 'empty' && ` · ${formatBytes(doc.size)}`}
      </span>
      <span>{message ?? (doc.previewable === 'empty' ? t('files.viewer.empty') : t('files.viewer.placeholder'))}</span>
    </div>
  )
}

/** A skill's or memory file's front matter, shown as a small header above the body. */
export function FrontmatterHeader({ data }: { data: Record<string, string> }): ReactElement {
  return (
    <dl className="fv-front" aria-label={t('files.viewer.frontmatter')}>
      <span className="fv-front__title" aria-hidden>
        {t('files.viewer.frontmatter')}
      </span>
      {Object.entries(data).map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt>{key}</dt>
          <dd>{value || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function ImageView({ doc }: { doc: ViewerDoc }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (failed || !doc.url) return <FilePlaceholder doc={doc} message={t('files.viewer.image.failed')} />
  // SVG draws as an <img>, so its scripts and links never run (OV-32).
  return (
    <div className="fv-image">
      <img src={doc.url} alt={doc.name} draggable={false} onError={() => setFailed(true)} />
    </div>
  )
}

function MediaView({ doc }: { doc: ViewerDoc }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (failed || !doc.url) return <FilePlaceholder doc={doc} message={t('files.viewer.media.failed')} />
  return (
    <div className="fv-media">
      {doc.previewable === 'video' ? (
        <video src={doc.url} controls preload="metadata" aria-label={doc.name} onError={() => setFailed(true)} />
      ) : (
        <audio src={doc.url} controls preload="metadata" aria-label={doc.name} onError={() => setFailed(true)} />
      )}
    </div>
  )
}

function Body({ doc, onOpenArtifact }: FilePreviewProps): ReactElement {
  const text = doc.text ?? ''
  switch (doc.previewable) {
    case 'markdown': {
      const { body } = parseFrontmatter(text)
      return (
        <>
          {doc.frontmatter && Object.keys(doc.frontmatter).length > 0 && <FrontmatterHeader data={doc.frontmatter} />}
          <Markdown className="fv-md" text={body} />
        </>
      )
    }
    case 'code':
      return <CodeView text={text} name={doc.name} label={doc.name} />
    case 'text':
      return (
        <pre className="fv-text" tabIndex={0} aria-label={doc.name}>
          {text}
        </pre>
      )
    case 'html':
      return <HtmlView text={text} name={doc.name} onOpenArtifact={doc.artifactable ? onOpenArtifact : undefined} />
    case 'image':
    case 'svg':
      return <ImageView doc={doc} />
    case 'pdf':
      return <PdfView token={doc.token} name={doc.name} />
    case 'audio':
    case 'video':
      return <MediaView doc={doc} />
    case 'sheet':
      return doc.sheet ? <SheetView sheet={doc.sheet} name={doc.name} /> : <FilePlaceholder doc={doc} />
    case 'empty':
    case 'binary':
    case 'unknown':
      return <FilePlaceholder doc={doc} />
  }
}

/** One file, drawn by what it is; the state notices sit above the body. */
export function FilePreview({ doc, compact = false, onRetry, onOpenArtifact }: FilePreviewProps): ReactElement {
  if (doc.state === 'missing') {
    return (
      <div className={cx('fv-preview', compact && 'fv-preview--compact')}>
        <EmptyState compact={compact} icon={<FileX />} title={t('files.viewer.missing')} description={doc.error ?? t('files.viewer.missing.description')} />
      </div>
    )
  }
  if (doc.state === 'error') {
    return (
      <div className={cx('fv-preview', compact && 'fv-preview--compact')}>
        <ErrorState compact={compact} title={doc.libraryId ? t('files.viewer.failed') : t('files.viewer.loadFailed')} message={doc.error} onRetry={onRetry} retryLabel={t('files.action.retry')} />
      </div>
    )
  }
  return (
    <div className={cx('fv-preview', compact && 'fv-preview--compact')} aria-busy={doc.state === 'writing'}>
      {doc.state === 'writing' && (
        <p className="fv-notice fv-notice--writing" role="status">
          <Spinner size={14} />
          <span>{t('files.viewer.writing')}</span>
        </p>
      )}
      {doc.truncated && (
        <p className="fv-notice" role="note">
          <Scissors aria-hidden />
          <span>{t('files.viewer.truncated')}</span>
        </p>
      )}
      <Body doc={doc} onOpenArtifact={onOpenArtifact} />
    </div>
  )
}

/** A failed save keeps the edits; this is the notice with Retry above the editor. */
export function SaveFailedNotice({ reason, onRetry }: { reason: string; onRetry(): void }): ReactElement {
  return (
    <p className="fv-notice fv-notice--error" role="alert">
      <TriangleAlert aria-hidden />
      <span>{t('files.viewer.saveFailed', { reason })}</span>
      <button type="button" className="fv-notice__action sp-link" onClick={onRetry}>
        {t('files.action.retry')}
      </button>
    </p>
  )
}
