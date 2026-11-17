/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useMemo, useState, type ClipboardEvent, type KeyboardEvent, type ReactElement } from 'react'
import { Braces, CircleCheck, CircleX, ListChecks, X } from 'lucide-react'
import { humanizeToolName } from '@shared/connectors'
import type { LogItem } from '../agentLog'
import { atelier, errorText } from '../api'
import type { RequestCardProps } from '../chat/requestCards'
import type { LogCardProps } from '../chat/cards/registry'
import { useT } from '../i18n/useT'
import { Field, TextArea, TextInput } from '../settings/kit'
import { Button, SegmentedControl, Select, Switch, cx, formatShortcut, isMac } from '../ui'
import { ConnectorLogo } from './ConnectorLogo'
import { useConnector } from './status'
import {
  buildFormModel,
  editSummary,
  inputFromValues,
  isEmail,
  localZone,
  parseRawInput,
  splitEmails,
  timeZones,
  valuesFromInput,
  type DateTimeValue,
  type FieldError,
  type FieldValue,
  type FormField,
  type FormValues,
} from './logic/schemaForm'

// CH-40: a locally run connector's call, held for you in the request tray.
// Its input shows as a form built from the tool's schema (or as JSON), your
// edits are summed up, and the confirm button says what the tool does.
// Declining can carry a short note back to the companion as the tool result.

export type ConnectorApprovalItem = Extract<LogItem, { kind: 'connector-approval' }>
type Json = Record<string, unknown>

export function ConnectorApprovalCard({ request, chatId, done }: RequestCardProps): ReactElement {
  const t = useT()
  const id = useId()
  const item = request.data as ConnectorApprovalItem
  const connector = useConnector(item.connectorId)
  const model = useMemo(() => buildFormModel(item.inputSchema), [item.inputSchema])
  const original = useMemo<Json>(() => (typeof item.input === 'object' && item.input !== null && !Array.isArray(item.input) ? (item.input as Json) : {}), [item.input])
  const zone = useMemo(() => localZone(), [])
  const [base, setBase] = useState(() => ({ input: original, initial: valuesFromInput(model, original, zone) }))
  const [values, setValues] = useState<FormValues>(base.initial)
  const [view, setView] = useState<'form' | 'json'>(model.usable ? 'form' : 'json')
  const [raw, setRaw] = useState(() => JSON.stringify(original, null, 2))
  const [tried, setTried] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [showEdits, setShowEdits] = useState(false)

  const action = item.actionLabel || humanizeToolName(item.tool)
  const formResult = useMemo(() => inputFromValues(model, values, base.input, base.initial), [model, values, base])
  const rawResult = useMemo(() => parseRawInput(raw), [raw])
  const current: Json | null = view === 'form' ? formResult.input : rawResult.ok ? rawResult.value : null
  const fieldErrors = view === 'form' ? formResult.errors : {}
  const valid = view === 'form' ? Object.keys(formResult.errors).length === 0 : rawResult.ok
  const edits = useMemo(() => (current ? editSummary(original, current) : []), [original, current])
  const message = (e: FieldError | undefined): string | null => (e ? t(e.key, e.vars) : null)

  const switchView = (next: 'form' | 'json'): void => {
    if (next === view) return
    if (next === 'json') {
      setRaw(JSON.stringify(current ?? formResult.input, null, 2))
    } else if (rawResult.ok) {
      const initial = valuesFromInput(model, rawResult.value, zone)
      setBase({ input: rawResult.value, initial })
      setValues(initial)
    } else {
      setTried(true)
      return
    }
    setView(next)
  }

  const answer = async (response: { allowed: true; input: unknown } | { allowed: false; message?: string }): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await atelier.agent.approveConnector(chatId, item.id, response)
      done(response)
    } catch (err) {
      setFailure(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const confirm = (): void => {
    setTried(true)
    if (!valid || !current || busy) {
      if (view === 'form') document.querySelector<HTMLElement>(`[data-cx-form="${id}"] [aria-invalid="true"]`)?.focus()
      return
    }
    void answer({ allowed: true, input: current })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !declining) {
      e.preventDefault()
      confirm()
    }
  }

  const setValue = (key: string, value: FieldValue): void => setValues((v) => ({ ...v, [key]: value }))

  return (
    <div className="cx-approval" role="group" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown} data-cx-form={id}>
      <div className="cx-approval__head">
        <ConnectorLogo name={item.connectorName} logo={connector?.logo ?? null} local size="sm" />
        <div className="cx-approval__titles">
          <p id={`${id}-title`} className="cx-approval__title">
            {t('connectors.approval.heading', { connector: item.connectorName, action: action.charAt(0).toLowerCase() + action.slice(1) })}
          </p>
          <p className="cx-muted cx-approval__tool">{t('connectors.approval.tool', { tool: item.tool })}</p>
        </div>
        {model.usable && (
          <SegmentedControl
            size="sm"
            label={t('connectors.approval.view')}
            value={view}
            options={[
              { value: 'form' as const, label: t('connectors.approval.viewForm'), icon: <ListChecks size={13} /> },
              { value: 'json' as const, label: t('connectors.approval.viewJson'), icon: <Braces size={13} /> },
            ]}
            onChange={switchView}
          />
        )}
      </div>

      {!declining && (
        <div className="cx-approval__body">
          {view === 'form' ? (
            <div className="cx-approval__fields">
              {model.fields.map((field) => (
                <FormFieldInput
                  key={field.key}
                  id={`${id}-${field.key}`}
                  field={field}
                  value={values[field.key] ?? ''}
                  error={tried || values[field.key] !== base.initial[field.key] ? message(fieldErrors[field.key]) : null}
                  onChange={(v) => setValue(field.key, v)}
                  disabled={busy}
                />
              ))}
            </div>
          ) : (
            <Field label={t('connectors.approval.rawLabel')} htmlFor={`${id}-raw`} hint={model.usable ? undefined : t('connectors.approval.noSchema')} error={!rawResult.ok ? message(rawResult.error) : null}>
              <TextArea id={`${id}-raw`} code rows={8} value={raw} spellCheck={false} invalid={!rawResult.ok} disabled={busy} onChange={(e) => setRaw(e.target.value)} />
            </Field>
          )}
          {edits.length > 0 && (
            <div className="cx-edits">
              <button type="button" className="cx-link" aria-expanded={showEdits} onClick={() => setShowEdits((v) => !v)}>
                {edits.length === 1 ? t('connectors.approval.editsOne') : t('connectors.approval.edits', { count: edits.length })}
              </button>
              {showEdits && (
                <ul className="cx-edits__list">
                  {edits.map((e) => (
                    <li key={e.key}>
                      <strong>{model.fields.find((f) => f.key === e.key)?.label ?? e.key}</strong>{' '}
                      {e.change === 'removed' ? (
                        <span className="cx-muted">{t('connectors.approval.removed')}</span>
                      ) : e.change === 'added' ? (
                        <>
                          <span className="cx-muted">{t('connectors.approval.added')}:</span> {e.after}
                        </>
                      ) : (
                        <>
                          <del>{e.before}</del> → <ins>{e.after}</ins>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {declining && (
        <Field label={t('connectors.approval.declineNote')} htmlFor={`${id}-note`}>
          <TextArea
            id={`${id}-note`}
            rows={2}
            maxLength={500}
            value={note}
            autoFocus
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void answer({ allowed: false, ...(note.trim() ? { message: note.trim() } : {}) })
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                setDeclining(false)
              }
            }}
          />
        </Field>
      )}

      {failure && (
        <p className="cx-error" role="alert">
          {failure}
        </p>
      )}

      <div className="cx-approval__actions">
        {declining ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDeclining(false)} disabled={busy}>
              {t('connectors.approval.declineBack')}
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void answer({ allowed: false, ...(note.trim() ? { message: note.trim() } : {}) })}>
              {t('connectors.approval.declineSend')}
            </Button>
          </>
        ) : (
          <>
            <span className="cx-muted cx-approval__hint">{t('connectors.approval.confirmHint', { key: formatShortcut('CmdOrCtrl+Enter', isMac) })}</span>
            <Button size="sm" variant="secondary" onClick={() => setDeclining(true)} disabled={busy}>
              {t('connectors.approval.decline')}
            </Button>
            <Button size="sm" variant="primary" loading={busy} disabled={tried && !valid} onClick={confirm}>
              {action}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

interface FieldInputProps {
  id: string
  field: FormField
  value: FieldValue
  error: string | null
  disabled: boolean
  onChange(value: FieldValue): void
}

function FormFieldInput({ id, field, value, error, disabled, onChange }: FieldInputProps): ReactElement {
  const t = useT()
  const label = field.required ? `${field.label} *` : field.label
  const hint = field.description || undefined
  const text = typeof value === 'string' ? value : ''
  switch (field.kind) {
    case 'boolean':
      return <Switch size="sm" checked={value === true} label={field.label} description={hint} disabled={disabled} onChange={onChange} />
    case 'emails':
      return (
        <Field label={label} hint={hint} error={error} htmlFor={id}>
          <EmailChips id={id} value={Array.isArray(value) ? value : []} invalid={Boolean(error)} disabled={disabled} onChange={onChange} />
        </Field>
      )
    case 'enum':
      return (
        <Field label={label} hint={hint} error={error} htmlFor={id}>
          <Select
            id={id}
            size="sm"
            value={text}
            disabled={disabled}
            options={[...(field.required ? [] : [{ value: '', label: t('connectors.approval.unset') }]), ...(field.options ?? []).map((o) => ({ value: String(o), label: String(o) }))]}
            onChange={onChange}
          />
        </Field>
      )
    case 'datetime': {
      const dt = value as DateTimeValue
      return (
        <Field label={label} hint={hint} error={error} htmlFor={id}>
          <span className="cx-row cx-datetime">
            <TextInput id={id} type="datetime-local" value={dt.local} invalid={Boolean(error)} disabled={disabled} onChange={(e) => onChange({ ...dt, local: e.target.value })} />
            <Select size="sm" value={dt.zone} disabled={disabled} options={timeZones().map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} onChange={(zone) => onChange({ ...dt, zone })} aria-label={t('connectors.approval.zone')} />
          </span>
        </Field>
      )
    }
    case 'multiline':
    case 'json':
      return (
        <Field label={label} hint={hint} error={error} htmlFor={id}>
          <TextArea id={id} rows={field.kind === 'json' ? 4 : 5} code={field.kind === 'json'} value={text} maxLength={field.maxLength} invalid={Boolean(error)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        </Field>
      )
    default:
      return (
        <Field label={label} hint={hint} error={error} htmlFor={id}>
          <TextInput
            id={id}
            type={field.kind === 'email' ? 'email' : field.kind === 'date' ? 'date' : field.kind === 'time' ? 'time' : 'text'}
            inputMode={field.kind === 'number' ? 'decimal' : undefined}
            value={text}
            maxLength={field.maxLength}
            invalid={Boolean(error)}
            aria-invalid={Boolean(error)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      )
  }
}

/** Recipients as chips: Enter, comma or Tab adds, Backspace on an empty field removes the last, paste splits. */
function EmailChips({ id, value, invalid, disabled, onChange }: { id: string; value: string[]; invalid: boolean; disabled: boolean; onChange(next: string[]): void }): ReactElement {
  const t = useT()
  const [draft, setDraft] = useState('')
  const add = (text: string): boolean => {
    const parts = splitEmails(text)
    if (parts.length === 0) return false
    onChange([...value, ...parts.filter((p) => !value.includes(p))])
    setDraft('')
    return true
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && draft.trim())) && !e.metaKey && !e.ctrlKey) {
      if (add(draft)) e.preventDefault()
      else if (e.key !== 'Tab' && e.key !== 'Enter') e.preventDefault()
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData('text')
    if (/[,;\n]|\s\S+@/.test(text)) {
      e.preventDefault()
      add(`${draft} ${text}`)
    }
  }
  return (
    <div className={cx('cx-chips', invalid && 'cx-chips--invalid')} onClick={() => document.getElementById(id)?.focus()}>
      <ul className="cx-chips__list">
        {value.map((address, i) => {
          const ok = isEmail(address)
          return (
            <li key={`${address}-${i}`} className={cx('cx-chip', !ok && 'cx-chip--bad')} title={ok ? address : t('connectors.approval.chipInvalid', { address })}>
              <span>{address}</span>
              <button type="button" className="cx-chip__x" aria-label={t('connectors.approval.chipRemove', { address })} disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <X size={11} aria-hidden />
              </button>
            </li>
          )
        })}
      </ul>
      <input
        id={id}
        className="cx-chips__input"
        type="email"
        multiple
        value={draft}
        disabled={disabled}
        aria-invalid={invalid}
        aria-label={t('connectors.approval.chipAdd')}
        placeholder={value.length === 0 ? 'name@example.com' : ''}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => add(draft)}
      />
    </div>
  )
}

/** The log's record of an answered approval; a waiting one shows only in the tray. */
export function ConnectorApprovalLogCard({ item }: LogCardProps<'connector-approval'>): ReactElement | null {
  const t = useT()
  if (item.outcome === null) return null
  const action = item.actionLabel || humanizeToolName(item.tool)
  const confirmed = item.outcome === 'confirmed'
  return (
    <p className={cx('cx-approval-log', !confirmed && 'cx-approval-log--declined')}>
      {confirmed ? <CircleCheck size={14} aria-hidden /> : <CircleX size={14} aria-hidden />}
      <span>
        {confirmed ? (item.edited ? t('connectors.approval.confirmedEdited', { action }) : t('connectors.approval.confirmed', { action })) : t('connectors.approval.declined', { action })}
        <span className="cx-muted"> · {item.connectorName}</span>
      </span>
    </p>
  )
}
