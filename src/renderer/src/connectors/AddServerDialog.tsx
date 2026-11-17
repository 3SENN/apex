/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { Eye, EyeOff, ImagePlus, Plus, Trash2 } from 'lucide-react'
import type { ConnectorInputV2 } from '@shared/connectors'
import type { Connector } from '@shared/services'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Field, Notice, TextArea, TextInput } from '../settings/kit'
import { Button, Dialog, IconButton, SegmentedControl, Spinner, Switch } from '../ui'
import { ConnectorLogo } from './ConnectorLogo'
import {
  draftExecution,
  draftFromConnector,
  emptyDraft,
  envRow,
  logoProblem,
  looksSecret,
  splitCommandLine,
  toInput,
  validateDraft,
  type DraftAuth,
  type DraftErrors,
  type ServerDraft,
  type ServerMode,
} from './logic/addForm'
import type { FieldError } from './logic/schemaForm'

// SK-15: the add custom server dialog. The connector-add-dialog overlay
// surface hosts it over the window; ConnectorEditor hosts it inline when
// the overlay isn't there. A local server it saves never starts here: the
// caller asks for approval of its exact command (OV-09).

export interface AddServerResult {
  /** Saved connectors, in order. */
  saved: { id: string; name: string; local: boolean }[]
}

export interface AddServerDialogProps {
  open: boolean
  connectorId?: string
  mode?: ServerMode
  onClose(): void
  onSaved(result: AddServerResult): void
}

interface ParsedServers {
  inputs: ConnectorInputV2[]
  errors: { index: number; field: string; message: string }[]
  include: boolean[]
}

export function AddServerDialog({ open, connectorId, mode = 'remote', onClose, onSaved }: AddServerDialogProps): ReactElement | null {
  const t = useT()
  const id = useId()
  const [draft, setDraft] = useState<ServerDraft>(() => emptyDraft(mode))
  const [loading, setLoading] = useState(Boolean(connectorId))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedServers | null>(null)
  const [revealSecret, setRevealSecret] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const editing = Boolean(connectorId)

  useEffect(() => {
    if (!connectorId) return
    let live = true
    call('connectors', 'list').then(
      (list: Connector[]) => {
        if (!live) return
        const c = list.find((x) => x.id === connectorId)
        if (c) {
          const d = draftFromConnector(c)
          setDraft({ ...d, logo: undefined })
          setAdvanced(d.auth !== 'none' || Boolean(d.headerName))
        } else setFailure(t('connectors.detail.gone'))
        setLoading(false)
      },
      (err: unknown) => {
        if (live) {
          setFailure(errorText(err))
          setLoading(false)
        }
      },
    )
    return () => {
      live = false
    }
  }, [connectorId])

  const update = (patch: Partial<ServerDraft>): void => {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (tried) setErrors(validateDraft(next))
  }
  const err = (key: string): string | null => {
    const e: FieldError | undefined = errors[key]
    return e ? t(e.key, e.vars) : null
  }

  const pickLogo = (file: File | undefined): void => {
    if (!file) return
    const problem = logoProblem(file)
    if (problem) {
      setErrors((prev) => ({ ...prev, logo: { key: problem } }))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const logo = reader.result
        setErrors(({ logo: _drop, ...rest }) => rest)
        setDraft((d) => ({ ...d, logo }))
      }
    }
    reader.readAsDataURL(file)
  }

  const checkJson = async (): Promise<ParsedServers | null> => {
    if (!draft.json.trim()) {
      setErrors({ json: { key: 'connectors.config.noServers' } })
      return null
    }
    try {
      const result = await call('connectors', 'parseConfig', draft.json)
      const next = { ...result, include: result.inputs.map(() => true) }
      setParsed(next)
      setErrors({})
      return next
    } catch (e) {
      setFailure(errorText(e))
      return null
    }
  }

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (saving) return
    setTried(true)
    setFailure(null)
    if (draft.mode === 'json') {
      const servers = parsed ?? (await checkJson())
      if (!servers) return
      const chosen = servers.inputs.filter((_, i) => servers.include[i])
      if (chosen.length === 0) return
      setSaving(true)
      const saved: AddServerResult['saved'] = []
      try {
        for (const input of chosen) {
          const c = await call('connectors', 'save', input)
          saved.push({ id: c.id, name: c.displayName, local: c.transport.kind === 'local' })
        }
        onSaved({ saved })
      } catch (e2) {
        setFailure(errorText(e2))
        if (saved.length) onSaved({ saved })
      } finally {
        setSaving(false)
      }
      return
    }
    const found = validateDraft(draft)
    setErrors(found)
    const first = Object.keys(found)[0]
    if (first) {
      document.getElementById(`${id}-${first.replace(/\./g, '-')}`)?.focus()
      return
    }
    setSaving(true)
    try {
      const c = await call('connectors', 'save', toInput(draft))
      onSaved({ saved: [{ id: c.id, name: c.displayName, local: c.transport.kind === 'local' }] })
    } catch (e2) {
      setFailure(errorText(e2))
    } finally {
      setSaving(false)
    }
  }

  const fid = (key: string): string => `${id}-${key.replace(/\./g, '-')}`
  const execution = draftExecution(draft)
  const modes = [
    { value: 'remote' as const, label: t('connectors.add.modeRemote') },
    { value: 'local' as const, label: t('connectors.add.modeLocal') },
    ...(editing ? [] : [{ value: 'json' as const, label: t('connectors.add.modeJson') }]),
  ]
  const chosenCount = parsed ? parsed.include.filter(Boolean).length : 0
  const saveLabel =
    draft.mode === 'json'
      ? parsed
        ? chosenCount === 1
          ? t('connectors.add.importOne')
          : t('connectors.add.import', { count: chosenCount })
        : t('connectors.add.jsonCheck')
      : editing
        ? t('connectors.add.saveEdit')
        : t('connectors.add.save')

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? t('connectors.add.editTitle', { name: draft.displayName || t('connectors.add.namePlaceholder') }) : t('connectors.add.title')}
      description={editing ? undefined : t('connectors.add.lede')}
      dismissible={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('connectors.add.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={`${id}-form`} loading={saving} disabled={loading || (draft.mode === 'json' && parsed !== null && chosenCount === 0)}>
            {saveLabel}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="cx-muted" role="status">
          <Spinner size={14} /> {t('connectors.detail.loading')}
        </p>
      ) : (
        <form id={`${id}-form`} className="cx-add" onSubmit={(e) => void submit(e)} noValidate>
          <SegmentedControl
            label={t('connectors.add.transport')}
            value={draft.mode}
            options={modes}
            onChange={(m) => {
              update({ mode: m })
              setParsed(null)
              setErrors({})
              setTried(false)
            }}
            fullWidth
          />
          {draft.mode !== 'json' && (
            <div className="cx-add__identity">
              <Field label={t('connectors.add.name')} htmlFor={fid('displayName')} error={err('displayName')}>
                <TextInput
                  id={fid('displayName')}
                  value={draft.displayName}
                  maxLength={64}
                  placeholder={t('connectors.add.namePlaceholder')}
                  invalid={Boolean(errors.displayName)}
                  autoFocus
                  onChange={(e) => update({ displayName: e.target.value })}
                />
              </Field>
              <Field label={t('connectors.add.logo')} hint={t('connectors.add.logoHint')} error={err('logo')}>
                <span className="cx-add__logo">
                  <ConnectorLogo name={draft.displayName} logo={draft.logo ?? null} local={draft.mode === 'local'} size="md" />
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon"
                    hidden
                    onChange={(e) => {
                      pickLogo(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                  <Button type="button" variant="secondary" size="sm" icon={<ImagePlus />} onClick={() => fileRef.current?.click()}>
                    {t('connectors.add.logoChoose')}
                  </Button>
                  {draft.logo && (
                    <IconButton size="sm" label={t('connectors.add.logoRemove')} icon={<Trash2 />} onClick={() => update({ logo: null })} />
                  )}
                </span>
              </Field>
            </div>
          )}

          {draft.mode === 'remote' && (
            <Field label={t('connectors.add.url')} hint={t('connectors.add.urlHint')} htmlFor={fid('url')} error={err('url')}>
              <TextInput
                id={fid('url')}
                type="url"
                inputMode="url"
                value={draft.url}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                autoComplete="off"
                invalid={Boolean(errors.url)}
                className="sp-mono"
                onChange={(e) => update({ url: e.target.value })}
              />
            </Field>
          )}

          {draft.mode === 'local' && <LocalFields draft={draft} update={update} err={err} fid={fid} errors={errors} />}

          {draft.mode === 'json' && (
            <>
              <Field label={t('connectors.add.json')} hint={t('connectors.add.jsonHint')} htmlFor={fid('json')} error={err('json')}>
                <TextArea
                  id={fid('json')}
                  code
                  rows={9}
                  value={draft.json}
                  spellCheck={false}
                  autoFocus
                  invalid={Boolean(errors.json)}
                  placeholder={'{\n  "mcpServers": {\n    "notes": { "command": "npx", "args": ["-y", "notes-mcp"] }\n  }\n}'}
                  onChange={(e) => {
                    update({ json: e.target.value })
                    setParsed(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void checkJson()
                    }
                  }}
                />
              </Field>
              {parsed && (
                <div className="cx-add__parsed" role="status">
                  {parsed.errors.length > 0 && (
                    <Notice tone="error">
                      <ul className="cx-list">
                        {parsed.errors.map((e, i) => (
                          <li key={i}>{t('connectors.add.jsonError', { index: e.index + 1, field: e.field, message: e.message })}</li>
                        ))}
                      </ul>
                    </Notice>
                  )}
                  {parsed.inputs.length > 0 && (
                    <>
                      <p className="cx-muted">{parsed.inputs.length === 1 ? t('connectors.add.jsonFoundOne') : t('connectors.add.jsonFound', { count: parsed.inputs.length })}</p>
                      <ul className="cx-add__servers">
                        {parsed.inputs.map((input, i) => (
                          <li key={i}>
                            <Switch
                              size="sm"
                              checked={parsed.include[i] ?? false}
                              label={t('connectors.add.jsonInclude', { name: input.displayName ?? input.name })}
                              description={input.transport.kind === 'local' ? `${input.transport.command} ${input.transport.args.join(' ')}`.trim() : input.transport.url}
                              onChange={(on) => setParsed({ ...parsed, include: parsed.include.map((v, j) => (j === i ? on : v)) })}
                            />
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {draft.mode === 'remote' && (
            <details className="cx-add__advanced" open={advanced} onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
              <summary>{t('connectors.add.advanced')}</summary>
              <div className="cx-add__advanced-body">
                <SegmentedControl<DraftAuth>
                  label={t('connectors.add.auth')}
                  size="sm"
                  value={draft.auth}
                  options={[
                    { value: 'none', label: t('connectors.auth.none') },
                    { value: 'bearer', label: t('connectors.auth.bearer') },
                    { value: 'api-key', label: t('connectors.auth.api-key') },
                  ]}
                  onChange={(auth) => update({ auth })}
                />
                {draft.auth !== 'none' && (
                  <Field label={t('connectors.add.secret')} hint={draft.hasSecret && !draft.removeSecret ? t('connectors.add.secretKept') : undefined} htmlFor={fid('secret')} error={err('secret')}>
                    <span className="cx-secret">
                      <TextInput
                        id={fid('secret')}
                        type={revealSecret ? 'text' : 'password'}
                        value={draft.secret}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={draft.hasSecret && !draft.removeSecret ? '••••••••' : undefined}
                        invalid={Boolean(errors.secret)}
                        onChange={(e) => update({ secret: e.target.value })}
                      />
                      <IconButton size="sm" label={revealSecret ? t('connectors.connect.hide') : t('connectors.connect.reveal')} icon={revealSecret ? <EyeOff /> : <Eye />} onClick={() => setRevealSecret((v) => !v)} />
                    </span>
                  </Field>
                )}
                {draft.hasSecret && (
                  <Switch size="sm" checked={draft.removeSecret} label={t('connectors.add.secretRemove')} onChange={(on) => update({ removeSecret: on })} />
                )}
                <Field label={t('connectors.add.headerName')} hint={t('connectors.add.headerHint')} htmlFor={fid('headerName')} error={err('headerName')}>
                  <TextInput
                    id={fid('headerName')}
                    value={draft.headerName}
                    placeholder={draft.auth === 'api-key' ? 'X-API-Key' : 'Authorization'}
                    spellCheck={false}
                    autoComplete="off"
                    className="sp-mono"
                    invalid={Boolean(errors.headerName)}
                    onChange={(e) => update({ headerName: e.target.value })}
                  />
                </Field>
              </div>
            </details>
          )}

          {execution && (
            <p className="cx-muted cx-add__runs">
              {execution === 'server' ? t('connectors.add.runsServer') : t('connectors.add.runsLocal')}
              {draft.mode === 'local' && ` ${t('connectors.add.localNote')}`}
            </p>
          )}
          {tried && Object.keys(errors).length > 0 && draft.mode !== 'json' && (
            <p className="cx-error" role="alert">
              {t('connectors.add.fixFields')}
            </p>
          )}
          {failure && <Notice tone="error">{failure}</Notice>}
        </form>
      )}
    </Dialog>
  )
}

interface LocalFieldsProps {
  draft: ServerDraft
  update(patch: Partial<ServerDraft>): void
  err(key: string): string | null
  fid(key: string): string
  errors: DraftErrors
}

/** The command, its arguments, the environment variables and the working folder. */
function LocalFields({ draft, update, err, fid, errors }: LocalFieldsProps): ReactElement {
  const t = useT()
  const canSplit = draft.args.length === 0 && /\s/.test(draft.command.trim())
  const split = (): void => {
    const parts = splitCommandLine(draft.command)
    update({ command: parts.command, args: parts.args })
  }
  const setArg = (i: number, value: string): void => update({ args: draft.args.map((a, j) => (j === i ? value : a)) })
  const setEnv = (i: number, patch: Partial<ServerDraft['env'][number]>): void => update({ env: draft.env.map((e, j) => (j === i ? { ...e, ...patch } : e)) })
  return (
    <>
      <Field label={t('connectors.add.command')} hint={t('connectors.add.commandHint')} htmlFor={fid('command')} error={err('command')}>
        <span className="cx-row">
          <TextInput
            id={fid('command')}
            value={draft.command}
            placeholder="npx"
            spellCheck={false}
            autoComplete="off"
            className="sp-mono"
            invalid={Boolean(errors.command)}
            onChange={(e) => update({ command: e.target.value })}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text')
              if (draft.args.length === 0 && !draft.command && /\s/.test(text.trim())) {
                e.preventDefault()
                const parts = splitCommandLine(text.trim())
                update({ command: parts.command, args: parts.args })
              }
            }}
          />
          {canSplit && (
            <Button type="button" size="sm" variant="secondary" onClick={split}>
              {t('connectors.add.splitArgs')}
            </Button>
          )}
        </span>
      </Field>

      <fieldset className="cx-add__group">
        <legend>{t('connectors.add.args')}</legend>
        {err('args') && <p className="cx-error">{err('args')}</p>}
        {draft.args.map((arg, i) => (
          <span key={i} className="cx-row">
            <TextInput
              id={fid(`args.${i}`)}
              aria-label={t('connectors.add.argN', { n: i + 1 })}
              value={arg}
              spellCheck={false}
              autoComplete="off"
              className="sp-mono"
              invalid={Boolean(errors[`args.${i}`])}
              onChange={(e) => setArg(i, e.target.value)}
            />
            <IconButton size="sm" label={t('connectors.add.removeArg', { n: i + 1 })} icon={<Trash2 />} onClick={() => update({ args: draft.args.filter((_, j) => j !== i) })} />
            {err(`args.${i}`) && <span className="cx-error">{err(`args.${i}`)}</span>}
          </span>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon={<Plus />}
          onClick={() => {
            update({ args: [...draft.args, ''] })
            requestAnimationFrame(() => document.getElementById(fid(`args.${draft.args.length}`))?.focus())
          }}
        >
          {t('connectors.add.addArg')}
        </Button>
      </fieldset>

      <fieldset className="cx-add__group">
        <legend>{t('connectors.add.env')}</legend>
        {draft.env.map((env, i) => {
          const label = env.name.trim() || t('connectors.add.envName')
          const hidden = env.secret && !env.revealed
          return (
            <div key={env.rowId} className="cx-env">
              <TextInput
                id={fid(`env.${i}.name`)}
                aria-label={t('connectors.add.envName')}
                placeholder="API_KEY"
                value={env.name}
                spellCheck={false}
                autoComplete="off"
                className="sp-mono"
                invalid={Boolean(errors[`env.${i}.name`])}
                onChange={(e) => {
                  const name = e.target.value
                  setEnv(i, { name, ...(env.saved || env.value ? {} : { secret: looksSecret(name) }) })
                }}
              />
              <TextInput
                id={fid(`env.${i}.value`)}
                aria-label={`${t('connectors.add.envValue')} (${label})`}
                type={hidden ? 'password' : 'text'}
                value={env.value}
                placeholder={env.saved ? t('connectors.add.envKept') : t('connectors.add.envValue')}
                spellCheck={false}
                autoComplete="off"
                className="sp-mono"
                invalid={Boolean(errors[`env.${i}.value`])}
                onChange={(e) => setEnv(i, { value: e.target.value })}
              />
              <Switch size="sm" checked={env.secret} label={t('connectors.add.envSecret')} onChange={(on) => setEnv(i, { secret: on, revealed: false })} />
              {env.secret && (
                <IconButton
                  size="sm"
                  label={env.revealed ? t('connectors.add.envHide', { name: label }) : t('connectors.add.envReveal', { name: label })}
                  icon={env.revealed ? <EyeOff /> : <Eye />}
                  onClick={() => setEnv(i, { revealed: !env.revealed })}
                />
              )}
              <IconButton size="sm" label={t('connectors.add.removeEnv', { name: label })} icon={<Trash2 />} onClick={() => update({ env: draft.env.filter((_, j) => j !== i) })} />
              {(err(`env.${i}.name`) || err(`env.${i}.value`)) && <p className="cx-error cx-env__error">{err(`env.${i}.name`) ?? err(`env.${i}.value`)}</p>}
            </div>
          )
        })}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon={<Plus />}
          onClick={() => {
            update({ env: [...draft.env, envRow()] })
            requestAnimationFrame(() => document.getElementById(fid(`env.${draft.env.length}.name`))?.focus())
          }}
        >
          {t('connectors.add.addEnv')}
        </Button>
      </fieldset>

      <Field label={t('connectors.add.cwd')} hint={t('connectors.add.cwdHint')} htmlFor={fid('cwd')} error={err('cwd')}>
        <TextInput id={fid('cwd')} value={draft.cwd} placeholder="/Users/you/servers/notes" spellCheck={false} autoComplete="off" className="sp-mono" invalid={Boolean(errors.cwd)} onChange={(e) => update({ cwd: e.target.value })} />
      </Field>
    </>
  )
}
