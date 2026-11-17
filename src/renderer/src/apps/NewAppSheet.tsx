/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The New app flow: describe the app, and Apex opens a chat with
// its own build brief so the companion builds it with build_app; the draft
// comes back as a preview card to save.
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Sparkles } from 'lucide-react'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { Field } from '../settings/kit'
import { Button, Sheet } from '../ui'
import '../settings/settings.css'
import './platform.css'

const IDEAS = ['platform.apps.new.idea1', 'platform.apps.new.idea2', 'platform.apps.new.idea3', 'platform.apps.new.idea4'] as const

export function NewAppSheet({ open, onClose }: { open: boolean; onClose(chatId: string | null): void }): ReactElement | null {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    setText('')
    setError(null)
    setBusy(false)
  }, [open])

  const start = async (): Promise<void> => {
    const description = text.trim()
    if (!description) {
      setError(t('platform.apps.new.empty'))
      field.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const chatId = await call('apps', 'startBuild', description)
      onClose(chatId)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => onClose(null)}
      title={t('platform.apps.new.title')}
      description={t('platform.apps.new.description')}
      initialFocus={field}
      footer={
        <>
          <Button onClick={() => onClose(null)}>{t('platform.common.cancel')}</Button>
          <Button variant="primary" icon={<Sparkles />} loading={busy} onClick={() => void start()}>
            {t('platform.apps.new.start')}
          </Button>
        </>
      }
    >
      <div className="pl-stack">
        <Field label={t('platform.apps.new.field')} hint={t('platform.apps.new.hint')} error={error} htmlFor={id}>
          <textarea
            id={id}
            ref={field}
            className="sp-textarea"
            rows={5}
            value={text}
            maxLength={10_000}
            aria-invalid={error !== null || undefined}
            placeholder={t('platform.apps.new.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void start()
              }
            }}
          />
        </Field>
        <div>
          <p className="pl-section-title">{t('platform.apps.new.ideas')}</p>
          <ul className="pl-ideas">
            {IDEAS.map((key) => (
              <li key={key}>
                <button type="button" className="pl-idea" onClick={() => setText(t(key))}>
                  {t(key)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Sheet>
  )
}
