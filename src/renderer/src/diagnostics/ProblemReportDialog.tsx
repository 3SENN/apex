/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'
import { Camera, ChevronRight, CircleCheck, FileText, FolderOpen, Mail, MessageSquare, Paperclip, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import { REPORT_FILES_MAX_BYTES, REPORT_IMAGE_MAX_BYTES, REPORT_MAX_BYTES, REPORT_MAX_FILES, type ReportResult } from '@shared/diagnostics'
import type { DiagnosticsSurfaceProps } from '@shared/overlay/diagnostics'
import { call, errorText } from '../api'
import { useT, type T } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { Button, IconButton, Kbd, Spinner, Switch, cx, isMac } from '../ui'
import { tabbables } from '../ui/layers'
import { trapFocusIndex } from '../ui/logic/keys'
import { addFiles, addImages, baseName, dataUrlSize, initialDraft, isDirty, isSaveAndEmailKey, saveBlock, toReportDraft, type AddProblem, type DraftImage, type DraftState } from './logic/draft'
import { ESTIMATE_DEBOUNCE_MS, estimateKey, formatSize, overLimit, shownEstimate, withImages, type EstimateStatus } from './logic/estimate'
import './diagnostics.css'

// The problem report (OV-30, OV-08's report kind): a whole-window modal in
// the dialog layer that blurs the sidebar and toolbar too. A description is
// required; pasted or dropped screenshots, picked files, this chat, a tab
// screenshot and crash dumps are each opt-in. ⌘↩ saves the bundle in
// Downloads and opens an email draft. Nothing is sent by Atelier itself.

export type ProblemReportProps = DiagnosticsSurfaceProps['problem-report']

type Phase = { kind: 'edit' } | { kind: 'confirm-discard' } | { kind: 'busy'; email: boolean } | { kind: 'error'; email: boolean; message: string } | { kind: 'done'; email: boolean; result: ReportResult }

let imageSeq = 0

function readImage(file: File): Promise<DraftImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      resolve({ id: `img-${++imageSeq}`, name: file.name || `screenshot-${imageSeq}.png`, dataUrl, bytes: dataUrlSize(dataUrl) })
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function problemText(t: T, p: AddProblem): string {
  if (p.kind === 'too-many-images') return t('diagnostics.report.tooManyImages', { count: 5 })
  if (p.kind === 'image-too-large') return t('diagnostics.report.imageTooLarge', { name: p.name, size: formatSize(REPORT_IMAGE_MAX_BYTES) })
  if (p.kind === 'too-many-files') return t('diagnostics.report.tooManyFiles', { count: REPORT_MAX_FILES })
  return t('diagnostics.report.filesTooLarge', { size: formatSize(REPORT_FILES_MAX_BYTES) })
}

export interface ProblemReportFormProps {
  context: ProblemReportProps
  /** Closes the dialog (after Done, Discard or Cancel on an empty form). */
  onClose(): void
  /** In the overlay the form traps Tab itself; the chrome fallback's Modal does it there. */
  trapFocus?: boolean
  exiting?: boolean
}

export function ProblemReportForm({ context, onClose, trapFocus = false, exiting = false }: ProblemReportFormProps): ReactElement {
  const t = useT()
  const titleId = useId()
  const descId = useId()
  const errorId = useId()
  const root = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState<DraftState>(() => initialDraft(context.preselectCrashDumps))
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' })
  const [notice, setNotice] = useState<string | null>(null)
  const [showRequired, setShowRequired] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [picking, setPicking] = useState(false)
  const [crashDumps, setCrashDumps] = useState(0)
  const [included, setIncluded] = useState(false)
  const [estimate, setEstimate] = useState<EstimateStatus>({ kind: 'idle' })
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    call('diagnostics', 'crashState')
      .then((s) => live && setCrashDumps(s.dumps))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const busy = phase.kind === 'busy'
  const imageBytes = draft.images.reduce((sum, i) => sum + i.bytes, 0)
  const crashAvailable = crashDumps > 0

  // The size, re-estimated 300 ms after the last change that affects it.
  const key = estimateKey(toReportDraft(draft, context, { withImages: false, crashAvailable }), imageBytes)
  const latest = useRef({ draft, context, imageBytes, crashAvailable })
  latest.current = { draft, context, imageBytes, crashAvailable }
  useEffect(() => {
    let live = true
    setEstimate((s) => ({ kind: 'busy', last: shownEstimate(s) }))
    const timer = setTimeout(() => {
      const now = latest.current
      call('diagnostics', 'estimate', toReportDraft(now.draft, now.context, { withImages: false, crashAvailable: now.crashAvailable }))
        .then((e) => live && setEstimate({ kind: 'ready', estimate: withImages(e, now.imageBytes) }))
        .catch(() => live && setEstimate({ kind: 'error' }))
    }, ESTIMATE_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key])

  const update = (patch: Partial<DraftState>): void => setDraft((d) => ({ ...d, ...patch }))

  const takeImages = useCallback(async (files: File[]): Promise<void> => {
    const read = await Promise.all(files.map((f) => readImage(f).catch(() => null)))
    setDraft((d) => {
      const { images, problems } = addImages(d.images, read.filter((x): x is DraftImage => x !== null))
      setNotice(problems.length ? problems.map((p) => problemText(t, p)).join(' ') : null)
      return { ...d, images }
    })
  }, [t])

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = [...e.clipboardData.files].filter((f) => IMAGE_TYPES.has(f.type))
    if (images.length === 0) return
    // Text pasted alongside an image (a copied web page) still goes in.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    void takeImages(images)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(false)
    if (busy) return
    const files = [...e.dataTransfer.files]
    const images = files.filter((f) => IMAGE_TYPES.has(f.type))
    if (images.length < files.length) setNotice(t('diagnostics.report.dropNotImage'))
    if (images.length) void takeImages(images)
  }

  const pick = async (): Promise<void> => {
    setPicking(true)
    try {
      const picked = await call('diagnostics', 'pickFiles')
      setDraft((d) => {
        const { files, problems } = addFiles(d.files, picked)
        setNotice(problems.length ? problems.map((p) => problemText(t, p)).join(' ') : null)
        return { ...d, files }
      })
    } catch (err) {
      setNotice(t('diagnostics.report.pickFailed', { error: errorText(err) }))
    } finally {
      setPicking(false)
    }
  }

  const tooLarge = overLimit(estimate)
  const save = async (email: boolean): Promise<void> => {
    if (busy) return
    const block = saveBlock(draft, tooLarge)
    if (block === 'description') {
      setShowRequired(true)
      textarea.current?.focus()
      return
    }
    if (block) return
    setPhase({ kind: 'busy', email })
    try {
      const result = await call('diagnostics', 'saveReport', toReportDraft(draft, context, { crashAvailable }), { email })
      setPhase({ kind: 'done', email, result })
    } catch (err) {
      setPhase({ kind: 'error', email, message: errorText(err) })
    }
  }

  const requestClose = (): void => {
    if (phase.kind === 'busy') return
    if (phase.kind === 'confirm-discard') return setPhase({ kind: 'edit' })
    if (phase.kind !== 'done' && isDirty(draft)) return setPhase({ kind: 'confirm-discard' })
    onClose()
  }

  // Esc and ⌘↩ work wherever focus is in the dialog.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      requestClose()
      return
    }
    if (isSaveAndEmailKey(e, isMac) && (phase.kind === 'edit' || phase.kind === 'error')) {
      e.preventDefault()
      void save(true)
      return
    }
    if (trapFocus && e.key === 'Tab') {
      const items = tabbables(root.current)
      if (!items.length) return
      const current = items.indexOf(document.activeElement as HTMLElement)
      const atEdge = current === -1 || (e.shiftKey ? current === 0 : current === items.length - 1)
      if (!atEdge) return
      e.preventDefault()
      items[trapFocusIndex(current, items.length, e.shiftKey)]?.focus()
    }
  }

  useLayoutEffect(() => {
    if (phase.kind === 'edit') textarea.current?.focus({ preventScroll: true })
    else root.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [phase.kind])

  const run = async (method: 'revealReport' | 'emailReport'): Promise<void> => {
    setActionError(null)
    try {
      await call('diagnostics', method)
    } catch (err) {
      setActionError(errorText(err))
    }
  }

  const shown = shownEstimate(estimate)
  const sizeLine = (): ReactElement => {
    if (tooLarge) {
      return (
        <p className="dg-size dg-size--error" role="alert">
          <TriangleAlert aria-hidden /> {t('diagnostics.report.tooLarge', { limit: formatSize(REPORT_MAX_BYTES) })}
        </p>
      )
    }
    if (estimate.kind === 'error') return <p className="dg-size">{t('diagnostics.report.sizeFailed')}</p>
    return (
      <p className="dg-size" aria-live="polite">
        {estimate.kind === 'busy' && <Spinner size={12} />}
        {shown ? t('diagnostics.report.size', { size: formatSize(shown.bytes) }) : t('diagnostics.report.sizeEstimating')}
      </p>
    )
  }

  if (phase.kind === 'done') {
    const { result, email } = phase
    return (
      <div ref={root} className={cx('dg-report', exiting && 'dg-report--exiting')} role={trapFocus ? 'dialog' : undefined} aria-modal={trapFocus || undefined} aria-labelledby={titleId} aria-describedby={descId} onKeyDown={onKeyDown}>
        <header className="dg-report__header">
          <span className="dg-report__done-mark" aria-hidden>
            <CircleCheck />
          </span>
          <h2 id={titleId} className="dg-report__title">
            {t('diagnostics.report.savedTitle')}
          </h2>
        </header>
        <div id={descId} className="dg-report__intro">
          <p>{t('diagnostics.report.savedBody', { name: baseName(result.path), size: formatSize(result.bytes) })}</p>
          <p>{email ? t('diagnostics.report.savedEmailBody') : t('diagnostics.report.savedNoEmailBody')}</p>
        </div>
        {actionError && (
          <p className="dg-inline-error" role="alert">
            {actionError}
          </p>
        )}
        <footer className="dg-report__footer">
          <Button variant="secondary" icon={<FolderOpen />} onClick={() => void run('revealReport')}>
            {isMac ? t('diagnostics.report.revealMac') : t('diagnostics.report.revealOther')}
          </Button>
          <Button variant="secondary" icon={<Mail />} onClick={() => void run('emailReport')}>
            {email ? t('diagnostics.report.emailAgain') : t('diagnostics.report.email')}
          </Button>
          <Button variant="primary" data-autofocus onClick={onClose}>
            {t('diagnostics.report.done')}
          </Button>
        </footer>
      </div>
    )
  }

  const confirming = phase.kind === 'confirm-discard'
  const block = saveBlock(draft, tooLarge)
  return (
    <div ref={root} className={cx('dg-report', exiting && 'dg-report--exiting')} role={trapFocus ? 'dialog' : undefined} aria-modal={trapFocus || undefined} aria-labelledby={titleId} aria-describedby={descId} aria-busy={busy || undefined} onKeyDown={onKeyDown}>
      <header className="dg-report__header">
        <h2 id={titleId} className="dg-report__title">
          {t('diagnostics.report.title')}
        </h2>
        <IconButton label={t('diagnostics.report.close')} tooltip={false} size="sm" icon={<X />} disabled={busy} onClick={requestClose} data-skip-autofocus />
      </header>
      <p id={descId} className="dg-report__intro">
        {t('diagnostics.report.intro')}
      </p>

      <fieldset className="dg-report__body" disabled={busy || confirming}>
        <label className="dg-visually-hidden" htmlFor={`${titleId}-text`}>
          {t('diagnostics.report.descriptionLabel')}
        </label>
        <textarea
          id={`${titleId}-text`}
          ref={textarea}
          className={cx('dg-report__text', showRequired && !draft.description.trim() && 'dg-report__text--invalid')}
          value={draft.description}
          placeholder={t('diagnostics.report.descriptionPlaceholder')}
          aria-required="true"
          aria-invalid={showRequired && !draft.description.trim() ? true : undefined}
          aria-describedby={showRequired && !draft.description.trim() ? errorId : undefined}
          maxLength={20_000}
          onChange={(e) => update({ description: e.target.value })}
          onPaste={onPaste}
        />
        {showRequired && !draft.description.trim() && (
          <p id={errorId} className="dg-field-error">
            {t('diagnostics.report.descriptionRequired')}
          </p>
        )}

        {draft.images.length > 0 && (
          <ul className="dg-thumbs" aria-label={t('diagnostics.report.images')}>
            {draft.images.map((image) => (
              <li key={image.id} className="dg-thumb">
                <img src={image.dataUrl} alt={image.name} />
                <IconButton
                  className="dg-thumb__remove"
                  label={t('diagnostics.report.remove', { name: image.name })}
                  tooltip={false}
                  size="sm"
                  icon={<X />}
                  onClick={() => update({ images: draft.images.filter((i) => i.id !== image.id) })}
                />
              </li>
            ))}
          </ul>
        )}

        <div
          className={cx('dg-drop', dragging && 'dg-drop--over')}
          onDragOver={(e) => {
            e.preventDefault()
            if (!dragging) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="dg-drop__text">
            <span className="dg-drop__title">{t('diagnostics.report.dropTitle')}</span>
            <span className="dg-drop__hint">{t('diagnostics.report.dropLimits', { files: REPORT_MAX_FILES, size: formatSize(REPORT_FILES_MAX_BYTES), imageSize: formatSize(REPORT_IMAGE_MAX_BYTES) })}</span>
          </div>
          <Button size="sm" variant="secondary" icon={<Paperclip />} loading={picking} onClick={() => void pick()}>
            {t('diagnostics.report.addFiles')}
          </Button>
        </div>
        {draft.files.length > 0 && (
          <ul className="dg-files">
            {draft.files.map((file) => (
              <li key={file.token} className="dg-file">
                <FileText aria-hidden />
                <span className="dg-file__name" title={file.name}>
                  {file.name}
                </span>
                <span className="dg-file__size">{formatSize(file.bytes)}</span>
                <IconButton label={t('diagnostics.report.remove', { name: file.name })} tooltip={false} size="sm" icon={<X />} onClick={() => update({ files: draft.files.filter((f) => f.token !== file.token) })} />
              </li>
            ))}
          </ul>
        )}
        {notice && (
          <p className="dg-notice" role="status">
            {notice}
          </p>
        )}

        {(context.chatId || context.tabId || crashAvailable) && (
          <div className="dg-switches">
            {context.chatId && (
              <div className="dg-switch">
                <MessageSquare aria-hidden className="dg-switch__icon" />
                <Switch
                  label={t('diagnostics.report.includeChat')}
                  description={context.chatTitle ? t('diagnostics.report.includeChatDetail', { title: context.chatTitle }) : undefined}
                  checked={draft.includeChat}
                  onChange={(includeChat) => update({ includeChat })}
                />
              </div>
            )}
            {context.tabId && (
              <div className="dg-switch">
                <Camera aria-hidden className="dg-switch__icon" />
                <Switch label={t('diagnostics.report.includeScreenshot')} description={t('diagnostics.report.includeScreenshotDetail')} checked={draft.includeScreenshot} onChange={(includeScreenshot) => update({ includeScreenshot })} />
              </div>
            )}
            {crashAvailable && (
              <div className="dg-switch">
                <TriangleAlert aria-hidden className="dg-switch__icon" />
                <Switch label={t('diagnostics.report.includeCrash')} description={t('diagnostics.report.includeCrashDetail', { count: crashDumps })} checked={draft.includeCrash} onChange={(includeCrash) => update({ includeCrash })} />
              </div>
            )}
          </div>
        )}

        <div className="dg-included">
          <p className="dg-included__note">
            <ShieldCheck aria-hidden /> {t('diagnostics.report.logsNote')}
          </p>
          <button type="button" className="dg-included__toggle" aria-expanded={included} aria-controls={`${titleId}-included`} onClick={() => setIncluded((v) => !v)}>
            <ChevronRight aria-hidden className={cx('dg-chevron', included && 'dg-chevron--open')} />
            {t('diagnostics.report.whatsIncluded')}
          </button>
          {included && (
            <ul id={`${titleId}-included`} className="dg-included__list">
              <li>{t('diagnostics.report.included.system')}</li>
              <li>{t('diagnostics.report.included.settings')}</li>
              <li>{t('diagnostics.report.included.logs')}</li>
              <li>{t('diagnostics.report.included.extras')}</li>
            </ul>
          )}
        </div>
        {sizeLine()}
      </fieldset>

      {phase.kind === 'error' && (
        <div className="dg-inline-error" role="alert">
          <TriangleAlert aria-hidden />
          <span>{t('diagnostics.report.failed', { error: phase.message })}</span>
          <Button size="sm" variant="secondary" onClick={() => void save(phase.email)}>
            {t('diagnostics.report.retry')}
          </Button>
        </div>
      )}

      {confirming ? (
        <footer className="dg-report__footer dg-report__footer--confirm" role="alertdialog" aria-label={t('diagnostics.report.discardTitle')}>
          <span className="dg-confirm__text">
            <strong>{t('diagnostics.report.discardTitle')}</strong> {t('diagnostics.report.discardBody')}
          </span>
          <Button variant="ghost" data-autofocus onClick={() => setPhase({ kind: 'edit' })}>
            {t('diagnostics.report.keepEditing')}
          </Button>
          <Button variant="danger" onClick={onClose}>
            {t('diagnostics.report.discard')}
          </Button>
        </footer>
      ) : (
        <footer className="dg-report__footer">
          <Button variant="ghost" disabled={busy} onClick={requestClose}>
            {t('diagnostics.report.cancel')}
          </Button>
          <Button variant="secondary" loading={busy && !phase.email} disabled={busy || block === 'too-large'} onClick={() => void save(false)}>
            {t('diagnostics.report.save')}
          </Button>
          <Button variant="primary" loading={busy && phase.email} disabled={busy || block === 'too-large'} onClick={() => void save(true)} className="dg-report__primary">
            {busy ? t('diagnostics.report.preparing') : t('diagnostics.report.saveAndEmail')}
            {!busy && <Kbd shortcut="CmdOrCtrl+Enter" className="dg-report__kbd" />}
          </Button>
        </footer>
      )}
    </div>
  )
}

/** The overlay surface: a full-window scrim with the form centred on it. */
export function ProblemReportDialog({ props, close, reportBounds, exiting }: SurfaceComponentProps<ProblemReportProps>): ReactElement {
  const wrap = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const r = wrap.current?.getBoundingClientRect()
    if (r) reportBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
  }, [])
  return (
    <div ref={wrap} className={cx('dg-modal', exiting && 'dg-modal--exiting')}>
      <div className="dg-modal__scrim" aria-hidden />
      <ProblemReportForm context={props} onClose={close} trapFocus exiting={exiting} />
    </div>
  )
}
