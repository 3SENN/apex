/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { t } from '@shared/i18n/core'
import { errorText } from '../api'
import { TextInput } from '../settings/kit'
import { Button, Dialog } from '../ui'
import './files.css'

// Rename a file (OV-32). The name without its extension is selected,
// Enter saves, Esc cancels, and a refused name (taken, or with a slash)
// keeps the dialog open with main's reason under the field.

export interface RenameDialogProps {
  /** The current name; null while closed. */
  name: string | null
  onClose(): void
  onRename(next: string): Promise<unknown>
}

export function RenameDialog({ name, onClose, onRename }: RenameDialogProps): ReactElement {
  const [value, setValue] = useState(name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const id = useId()

  useEffect(() => {
    if (name === null) return
    setValue(name)
    setError(null)
    setBusy(false)
    // Select the base name, so typing replaces it and keeps the extension.
    requestAnimationFrame(() => {
      const el = field.current
      if (!el) return
      el.focus()
      const dot = name.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : name.length)
    })
  }, [name])

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    const next = value.trim()
    if (!name || !next || next === name) {
      onClose()
      return
    }
    if (/[\\/\0]/.test(next) || next === '.' || next === '..') {
      setError(t('files.error.badName'))
      return
    }
    setBusy(true)
    try {
      await onRename(next)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={name !== null}
      onClose={onClose}
      size="sm"
      title={t('files.rename.title')}
      initialFocus={field}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('files.action.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t('files.action.save')}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)}>
        <label className="ui-sr-only" htmlFor={id}>
          {t('files.rename.label')}
        </label>
        <TextInput
          ref={field}
          id={id}
          value={value}
          maxLength={255}
          invalid={error !== null}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          style={{ width: '100%' }}
        />
        {error && (
          <p id={`${id}-error`} className="fv-rename__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
