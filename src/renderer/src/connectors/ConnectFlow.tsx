/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { ArrowUpRight, Eye, EyeOff } from 'lucide-react'
import type { ConnectorV2, DirectoryEntry } from '@shared/connectors'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Field, Notice, TextInput } from '../settings/kit'
import { Button, Dialog, IconButton, Spinner } from '../ui'
import { ConnectorLogo } from './ConnectorLogo'
import { GoogleSetupSteps } from './GoogleSetup'

// Connecting a directory entry (SK-13, CH-41): one-click sign-in
// where the service offers it, a token where it doesn't (or when sign-in
// can't register Apex), and the fields some services need. The page's
// dialog and the chat's connect card share this form.

export type ConnectPhase = { phase: 'idle' } | { phase: 'connecting' } | { phase: 'failed'; message: string } | { phase: 'done'; connector: ConnectorV2 }

/** The entry's fields that the form asks for (Google's client ID and secret included). */
function fieldsOf(entry: DirectoryEntry): NonNullable<DirectoryEntry['fields']> {
  return entry.fields ?? []
}

export function useConnectFlow(entry: DirectoryEntry | null): { state: ConnectPhase; connect(opts: { token?: string; fields?: Record<string, string> }): Promise<ConnectorV2 | null>; reset(): void } {
  const [state, setState] = useState<ConnectPhase>({ phase: 'idle' })
  const busy = useRef(false)
  const connect = async (opts: { token?: string; fields?: Record<string, string> }): Promise<ConnectorV2 | null> => {
    if (!entry || busy.current) return null
    busy.current = true
    setState({ phase: 'connecting' })
    try {
      const connector = await call('connectors', 'connectDirectory', entry.id, opts)
      setState({ phase: 'done', connector })
      return connector
    } catch (err) {
      setState({ phase: 'failed', message: errorText(err) })
      return null
    } finally {
      busy.current = false
    }
  }
  return { state, connect, reset: () => setState({ phase: 'idle' }) }
}

export interface ConnectFormProps {
  entry: DirectoryEntry
  flow: ReturnType<typeof useConnectFlow>
  onConnected(connector: ConnectorV2): void
  /** The chat card's tighter layout. */
  compact?: boolean
  autoFocus?: boolean
}

/** The fields and buttons that connect one directory entry. */
export function ConnectForm({ entry, flow, onConnected, compact = false, autoFocus = false }: ConnectFormProps): ReactElement {
  const t = useT()
  const id = useId()
  const [useToken, setUseToken] = useState(entry.auth === 'token')
  const [token, setToken] = useState('')
  const [reveal, setReveal] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState<string | null>(null)
  const { state } = flow
  const connecting = state.phase === 'connecting'
  const needsToken = useToken && entry.auth !== 'none'

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    for (const f of fieldsOf(entry)) {
      if (f.key === 'clientSecret' || (needsToken && (f.key === 'clientId' || f.key === 'clientSecret'))) continue
      if (!fields[f.key]?.trim()) {
        setMissing(f.key)
        document.getElementById(`${id}-${f.key}`)?.focus()
        return
      }
    }
    if (needsToken && !token.trim()) {
      setMissing('token')
      document.getElementById(`${id}-token`)?.focus()
      return
    }
    setMissing(null)
    const connector = await flow.connect({ ...(needsToken ? { token: token.trim() } : {}), ...(Object.keys(fields).length ? { fields } : {}) })
    if (connector) onConnected(connector)
  }

  const label = entry.auth === 'none' ? t('connectors.connect.addPublic', { name: entry.name }) : needsToken ? t('connectors.connect.add') : t('connectors.connect.signIn')
  return (
    <form className={compact ? 'cx-connect cx-connect--compact' : 'cx-connect'} onSubmit={(e) => void submit(e)} aria-busy={connecting}>
      {fieldsOf(entry)
        .filter((f) => !(needsToken && (f.key === 'clientId' || f.key === 'clientSecret')))
        .map((f, i) => (
          <Field key={f.key} label={f.label} htmlFor={`${id}-${f.key}`} error={missing === f.key ? t('connectors.error.fieldMissing', { field: f.label }) : null}>
            <TextInput
              id={`${id}-${f.key}`}
              value={fields[f.key] ?? ''}
              placeholder={f.placeholder}
              autoFocus={autoFocus && i === 0}
              type={f.key === 'clientSecret' ? 'password' : 'text'}
              spellCheck={false}
              autoComplete="off"
              invalid={missing === f.key}
              disabled={connecting}
              onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </Field>
        ))}
      {needsToken && (
        <Field label={t('connectors.connect.token')} hint={t('connectors.connect.tokenHint', { name: entry.name })} htmlFor={`${id}-token`} error={missing === 'token' ? t('connectors.error.tokenNeeded') : null}>
          <span className="cx-secret">
            <TextInput
              id={`${id}-token`}
              type={reveal ? 'text' : 'password'}
              value={token}
              autoFocus={autoFocus && fieldsOf(entry).length === 0}
              spellCheck={false}
              autoComplete="off"
              invalid={missing === 'token'}
              disabled={connecting}
              onChange={(e) => setToken(e.target.value)}
            />
            <IconButton size="sm" label={reveal ? t('connectors.connect.hide') : t('connectors.connect.reveal')} icon={reveal ? <EyeOff /> : <Eye />} onClick={() => setReveal((v) => !v)} />
          </span>
        </Field>
      )}
      {entry.auth === 'none' && !compact && <p className="cx-muted">{t('connectors.connect.publicNote')}</p>}
      {entry.auth === 'oauth' && !useToken && !compact && <p className="cx-muted">{t('connectors.connect.signInNote')}</p>}
      {connecting && (
        <p className="cx-connect__status" role="status">
          <Spinner size={14} /> {entry.auth === 'oauth' && !useToken ? t('connectors.connect.waiting', { name: entry.name }) : t('connectors.connect.connecting')}
        </p>
      )}
      {state.phase === 'failed' && (
        <Notice tone="error">
          <strong>{t('connectors.connect.failed', { name: entry.name })}</strong> {state.message}
        </Notice>
      )}
      <div className="cx-connect__actions">
        {entry.auth === 'oauth' && !connecting && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setUseToken((v) => !v)} aria-pressed={useToken}>
            {useToken ? t('connectors.connect.signIn') : t('connectors.connect.tokenInstead')}
          </Button>
        )}
        <Button type="submit" variant="primary" size={compact ? 'sm' : 'md'} loading={connecting}>
          {state.phase === 'failed' ? t('connectors.connect.retry') : label}
        </Button>
      </div>
    </form>
  )
}

export interface ConnectDialogProps {
  entry: DirectoryEntry | null
  onClose(): void
  onConnected(connector: ConnectorV2): void
}

/** The page's connect dialog: what the service offers, its docs, then the form (with Google's steps first). */
export function ConnectDialog({ entry, onClose, onConnected }: ConnectDialogProps): ReactElement | null {
  const t = useT()
  const flow = useConnectFlow(entry)
  if (!entry) return null
  const google = entry.setup === 'google'
  return (
    <Dialog
      open
      onClose={onClose}
      size={google ? 'lg' : 'md'}
      title={
        <span className="cx-dialog-title">
          <ConnectorLogo name={entry.name} site={entry.site} category={entry.category} size="sm" />
          {google ? t('connectors.google.title', { name: entry.name }) : t('connectors.connect.title', { name: entry.name })}
        </span>
      }
      description={entry.description}
      dismissible={flow.state.phase !== 'connecting'}
    >
      {google && <GoogleSetupSteps />}
      <ConnectForm
        key={entry.id}
        entry={entry}
        flow={flow}
        autoFocus
        onConnected={(c) => {
          onConnected(c)
        }}
      />
      <p className="cx-docs-link">
        <button type="button" className="cx-link" onClick={() => void apex.tabs.create(entry.docsUrl)}>
          {t('connectors.connect.docs')} <ArrowUpRight size={13} aria-hidden />
        </button>
      </p>
    </Dialog>
  )
}
