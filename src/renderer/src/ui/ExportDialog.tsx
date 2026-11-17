/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The export dialog (CH-36): copy as text, save as
// Markdown, HTML or PDF, print, a mail draft, and Show in Finder for what was
// saved, for chats, skills, transcripts and documents. Several ids save one
// file each into a folder you pick. The exporter service in main does the
// work; this dialog only chooses and reports.
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClipboardCopy, FileCode2, FileText, FileType2, FolderOpen, Mail, Printer, RotateCw, TriangleAlert } from 'lucide-react'
import type { ExportFormat, ExportKind } from '@shared/exportFormat'
import { call, errorText } from '../api'
import { copyText } from '../chat/actions'
import { exportActions, exportedName as fileName } from '../chat/logic/exportDialog'
import { useT } from '../i18n/useT'
import { Button, Dialog, SkeletonRows, Spinner, isMac } from './index'
import '../chat/chatTools.css'

export interface ExportDialogProps {
  kind: ExportKind
  ids: string[]
  title: string
  onClose(): void
}

type Busy = 'copy' | 'print' | 'mail' | ExportFormat | null
type Load = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; formats: ExportFormat[] }


const SAVE_ICON: Record<ExportFormat, ReactNode> = {
  text: <FileText size={16} aria-hidden="true" />,
  markdown: <FileText size={16} aria-hidden="true" />,
  html: <FileCode2 size={16} aria-hidden="true" />,
  pdf: <FileType2 size={16} aria-hidden="true" />,
}

export function ExportDialog({ kind, ids, title, onClose }: ExportDialogProps): ReactElement {
  const t = useT()
  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [busy, setBusy] = useState<Busy>(null)
  const [saved, setSaved] = useState<{ path: string; many: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const many = ids.length > 1

  const fetchFormats = useCallback(() => {
    setLoad({ phase: 'loading' })
    call('exporter', 'formats', kind).then(
      (formats) => setLoad({ phase: 'ready', formats }),
      (err: unknown) => setLoad({ phase: 'error', message: errorText(err) }),
    )
  }, [kind])

  useEffect(fetchFormats, [fetchFormats])

  const run = async (what: Exclude<Busy, null>, action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(what)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const id = ids[0] ?? ''
  const copy = (): Promise<void> =>
    run('copy', async () => {
      const text = await call('exporter', 'copyText', kind, id)
      if (!(await copyText(text))) throw new Error(t('chatTools.export.loadError'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  const save = (format: ExportFormat): Promise<void> =>
    run(format, async () => {
      const path = await call('exporter', 'save', kind, ids, format)
      if (path) setSaved({ path, many })
    })
  const print = (): Promise<void> => run('print', () => call('exporter', 'print', kind, id))
  const mail = (): Promise<void> => run('mail', () => call('exporter', 'mailDraft', kind, id))
  const reveal = (): void => {
    if (!saved) return
    call('exporter', 'reveal', saved.path).catch((err: unknown) => setError(errorText(err)))
  }

  let body: ReactNode
  if (load.phase === 'loading') {
    body = <SkeletonRows rows={4} />
  } else if (load.phase === 'error') {
    body = (
      <div className="cd-export__error" role="alert">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>{t('chatTools.export.loadError')}</span>
        <Button size="sm" variant="ghost" icon={<RotateCw size={13} />} onClick={fetchFormats}>{t('chatTools.export.retry')}</Button>
      </div>
    )
  } else {
    const actions = exportActions(load.formats, ids.length)
    body =
      actions.saves.length === 0 && !actions.copy ? (
        <p className="cd-export__hint">{t('chatTools.export.none')}</p>
      ) : (
        <div className="cd-export" role="group" aria-label={t('chatTools.export.title')}>
          {many && <p className="cd-export__hint">{t('chatTools.export.manyHint')}</p>}
          {actions.copy && (
            <Option icon={<ClipboardCopy size={16} aria-hidden="true" />} label={copied ? t('chatTools.export.copied') : t('chatTools.export.copy')} busy={busy === 'copy'} disabled={busy !== null} onClick={() => void copy()} autoFocus />
          )}
          {actions.saves.map((format, i) => (
            <Option key={format} icon={SAVE_ICON[format]} label={t(`chatTools.export.save.${format}`)} busy={busy === format} disabled={busy !== null} onClick={() => void save(format)} autoFocus={!actions.copy && i === 0} />
          ))}
          {(actions.print || actions.mail) && <div className="cd-export__rule" role="separator" />}
          {actions.print && <Option icon={<Printer size={16} aria-hidden="true" />} label={t('chatTools.export.print')} busy={busy === 'print'} disabled={busy !== null} onClick={() => void print()} />}
          {actions.mail && <Option icon={<Mail size={16} aria-hidden="true" />} label={t('chatTools.export.mail')} sub={t('chatTools.export.mailHint')} busy={busy === 'mail'} disabled={busy !== null} onClick={() => void mail()} />}
          {saved && (
            <div className="cd-export__done" role="status">
              <span>{t(saved.many ? 'chatTools.export.savedMany' : 'chatTools.export.saved', { name: fileName(saved.path) })}</span>
              <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={reveal}>{isMac ? t('chatTools.export.revealMac') : t('chatTools.export.reveal')}</Button>
            </div>
          )}
          {error && (
            <div className="cd-export__error" role="alert">
              <TriangleAlert size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={many ? t('chatTools.export.manyTitle', { count: ids.length }) : t('chatTools.export.title')}
      description={many ? undefined : title}
      footer={<Button variant="secondary" onClick={onClose}>{t('chatTools.export.close')}</Button>}
    >
      {body}
    </Dialog>
  )
}

function Option({ icon, label, sub, busy, disabled, onClick, autoFocus }: { icon: ReactNode; label: string; sub?: string; busy: boolean; disabled: boolean; onClick(): void; autoFocus?: boolean }): ReactElement {
  return (
    <button type="button" className="cd-export__option" disabled={disabled} aria-busy={busy || undefined} onClick={onClick} {...(autoFocus ? { 'data-autofocus': true } : {})}>
      {busy ? <Spinner size={16} /> : icon}
      <span className="cd-export__label">
        {label}
        {sub && (
          <>
            <br />
            <span className="cd-export__sub">{sub}</span>
          </>
        )}
      </span>
    </button>
  )
}

/** Opens the dialog from plain code (a menu click, a bulk action) in its own root; resolves when it closes. */
export function openExportDialog(props: Omit<ExportDialogProps, 'onClose'>): Promise<void> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    host.dataset.exportDialog = ''
    document.body.appendChild(host)
    const root = createRoot(host)
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      resolve()
      // Let the dialog's own exit run before its root goes.
      setTimeout(() => {
        root.unmount()
        host.remove()
      }, 200)
    }
    root.render(<ExportDialog {...props} onClose={close} />)
  })
}
