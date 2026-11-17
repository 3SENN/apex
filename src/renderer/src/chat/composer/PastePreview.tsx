/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { t } from '@shared/i18n/core'
import { call, errorText } from '../../api'
import { Button, Dialog, ErrorState, SkeletonText } from '../../ui'
import { lineCount } from '../logic/paste'

// The long-paste preview (CH-24): the chip's text, read-only at first, with
// Edit, Put back in the message, and Remove. It is the `paste-preview`
// overlay surface once the overlay host is up (it covers the page too), and
// an in-window dialog until then.

export type PasteResult = { action: 'put-back'; text: string } | { action: 'removed' } | { action: 'saved' }

export interface PasteBodyProps {
  chatId: string
  attachmentId: string
  onDone(result: PasteResult | null): void
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; text: string }

function usePasteText(chatId: string, attachmentId: string): [Load, () => void] {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setLoad({ kind: 'loading' })
    call('attachments', 'readText', chatId, attachmentId).then(
      (text) => live && setLoad({ kind: 'ready', text }),
      (err: unknown) => live && setLoad({ kind: 'error', message: errorText(err) }),
    )
    return () => {
      live = false
    }
  }, [chatId, attachmentId, attempt])
  return [load, () => setAttempt((n) => n + 1)]
}

/** The preview's content and buttons, shared by the dialog and the overlay surface. */
export function PasteBody({ chatId, attachmentId, onDone }: PasteBodyProps): ReactElement {
  const [load, retry] = usePasteText(chatId, attachmentId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'remove' | 'put-back' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])

  if (load.kind === 'loading') {
    return (
      <div className="cmp-paste" role="status" aria-busy="true">
        <SkeletonText lines={6} />
      </div>
    )
  }
  if (load.kind === 'error') {
    return <ErrorState compact title={t('composer.paste.loadFailed')} message={load.message} onRetry={retry} />
  }

  const text = editing ? draft : load.text
  const summary = t('composer.paste.summary', { lines: t('composer.paste.lines', { count: lineCount(text) }), chars: text.length })

  const save = async (): Promise<void> => {
    if (busy) return
    if (!draft.trim()) {
      setError(t('composer.paste.emptyEdit'))
      return
    }
    setBusy('save')
    setError(null)
    try {
      await call('attachments', 'updateText', chatId, attachmentId, draft)
      onDone({ action: 'saved' })
    } catch {
      // The edit stays in the field so nothing typed is lost.
      setError(t('composer.paste.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy('remove')
    try {
      await call('attachments', 'remove', chatId, attachmentId)
      onDone({ action: 'removed' })
    } catch (err) {
      setError(errorText(err))
      setBusy(null)
    }
  }

  return (
    <div className="cmp-paste">
      <p className="cmp-paste__summary">{summary}</p>
      {editing ? (
        <textarea
          ref={field}
          className="cmp-paste__text cmp-paste__text--edit"
          value={draft}
          aria-label={t('composer.paste.field')}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void save()
            }
          }}
        />
      ) : (
        <pre className="cmp-paste__text" tabIndex={0} aria-label={t('composer.paste.field')}>
          {load.text}
        </pre>
      )}
      {error && (
        <p className="cmp-paste__error" role="alert">
          {error}
        </p>
      )}
      <div className="cmp-paste__actions">
        {editing ? (
          <>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy !== null}>{t('composer.paste.cancel')}</Button>
            <Button variant="primary" loading={busy === 'save'} onClick={() => void save()}>{t('composer.paste.save')}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" className="cmp-paste__remove" loading={busy === 'remove'} onClick={() => void remove()}>{t('composer.paste.remove')}</Button>
            <span className="cmp-paste__spacer" />
            <Button
              onClick={() => {
                setDraft(load.text)
                setEditing(true)
              }}
            >
              {t('composer.paste.edit')}
            </Button>
            <Button variant="primary" onClick={() => onDone({ action: 'put-back', text: load.text })}>{t('composer.paste.putBack')}</Button>
          </>
        )}
      </div>
    </div>
  )
}

export interface PasteDialogProps {
  open: { chatId: string; attachmentId: string } | null
  onDone(result: PasteResult | null): void
}

/** The in-window fallback while the overlay host isn't available. */
export function PasteDialog({ open, onDone }: PasteDialogProps): ReactElement {
  const last = useRef(open)
  if (open) last.current = open
  const shown = open ?? last.current
  return (
    <Dialog open={open !== null} onClose={() => onDone(null)} title={t('composer.paste.title')} size="lg" className="cmp-paste-dialog">
      {shown && <PasteBody chatId={shown.chatId} attachmentId={shown.attachmentId} onDone={onDone} />}
    </Dialog>
  )
}
