/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Password import (ST-41) and the guided import from the macOS
// Passwords app (ON-04), in one dialog. CSV: choose a file, check the
// guessed columns against a masked preview, import, read the report. The
// Passwords app flow adds three steps first (open the app, export, choose
// the file), imports straight away when the columns are recognized, and
// then offers to move the plaintext export to the Trash.
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ExternalLink, FileUp, Trash2 } from 'lucide-react'
import { importOutcome, mappingOptions, remap, type CsvPreview, type ImportReport, type MappingField } from '@shared/passwords'
import { call, errorText } from '../api'
import { Field, Notice } from '../settings/kit'
import { Button, Dialog, Select, Spinner } from '../ui'
import { useT, type MessageKey } from '../i18n/useT'

export type ImportSource = 'csv' | 'system'

type Stage = 'open' | 'export' | 'pick' | 'map' | 'report'

const FORMAT_KEY: Record<CsvPreview['format'], MessageKey> = {
  chrome: 'passwords.import.format.chrome',
  firefox: 'passwords.import.format.firefox',
  safari: 'passwords.import.format.safari',
  '1password': 'passwords.import.format.1password',
  bitwarden: 'passwords.import.format.bitwarden',
  unknown: 'passwords.import.format.unknown',
}

const FIELDS: Array<{ field: MappingField; label: MessageKey }> = [
  { field: 'url', label: 'passwords.import.mapUrl' },
  { field: 'username', label: 'passwords.import.mapUsername' },
  { field: 'password', label: 'passwords.import.mapPassword' },
]

export interface ImportDialogProps {
  open: boolean
  source: ImportSource
  onClose(): void
  /** After a confirmed import, with its counts. */
  onImported?(report: ImportReport): void
}

export function ImportDialog({ open, source, onClose, onImported }: ImportDialogProps): ReactElement {
  const t = useT()
  const ids = useId()
  const [stage, setStage] = useState<Stage>(source === 'system' ? 'open' : 'pick')
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trashed, setTrashed] = useState(false)
  // The token outlives renders so closing always cleans up the temp copy.
  const token = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    setStage(source === 'system' ? 'open' : 'pick')
    setPreview(null)
    setReport(null)
    setBusy(false)
    setError(null)
    setTrashed(false)
    token.current = null
  }, [open, source])

  const close = (): void => {
    if (token.current) void call('passwords', 'importCancel', token.current).catch(() => undefined)
    token.current = null
    onClose()
  }

  // Leaving the page mid-import still deletes the copy.
  useEffect(
    () => () => {
      if (token.current) void call('passwords', 'importCancel', token.current).catch(() => undefined)
    },
    [],
  )

  const confirm = async (p: CsvPreview): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await call('passwords', 'importConfirm', p.token, p.mapping)
      setReport(result)
      setStage('report')
      onImported?.(result)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (token.current) await call('passwords', 'importCancel', token.current)
      token.current = null
      const picked = source === 'system' ? await call('passwords', 'pickSystemExport') : await call('passwords', 'importPick')
      if (!picked) return
      token.current = picked.token
      setPreview(picked)
      // A recognized Passwords export imports at once; anything unclear goes through the mapping step.
      if (source === 'system' && picked.format !== 'unknown' && picked.importable > 0) {
        setBusy(false)
        await confirm(picked)
        return
      }
      setStage('map')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const changeColumn = async (field: MappingField, value: string): Promise<void> => {
    if (!preview) return
    const mapping = remap(preview.mapping, field, value)
    setPreview({ ...preview, mapping })
    try {
      setPreview(await call('passwords', 'importRemap', preview.token, mapping))
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const trash = async (): Promise<void> => {
    if (!token.current) return
    setBusy(true)
    try {
      await call('passwords', 'trashFile', token.current)
      token.current = null
      setTrashed(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const step = stage === 'open' ? 1 : stage === 'export' ? 2 : 3
  const title = source === 'system' ? t('passwords.system.title') : t('passwords.import.title')

  let body: ReactElement
  let footer: ReactElement
  if (stage === 'open') {
    body = (
      <SystemStep step={step} title={t('passwords.system.open.title')}>
        <p className="pw-form__note">{t('passwords.system.open.body')}</p>
        <div>
          <Button icon={<ExternalLink />} onClick={() => void call('passwords', 'openSystemPasswords').catch((err: unknown) => setError(errorText(err)))}>
            {t('passwords.system.open.button')}
          </Button>
        </div>
      </SystemStep>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={close}>
          {t('passwords.system.skip')}
        </Button>
        <Button variant="primary" onClick={() => setStage('export')} data-autofocus>
          {t('passwords.system.next')}
        </Button>
      </>
    )
  } else if (stage === 'export') {
    body = (
      <SystemStep step={step} title={t('passwords.system.export.title')}>
        <ol className="pw-howto">
          <li>{t('passwords.system.export.step1')}</li>
          <li>{t('passwords.system.export.step2')}</li>
          <li>{t('passwords.system.export.step3')}</li>
        </ol>
      </SystemStep>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStage('open')}>
          {t('passwords.import.back')}
        </Button>
        <Button variant="primary" onClick={() => setStage('pick')} data-autofocus>
          {t('passwords.system.next')}
        </Button>
      </>
    )
  } else if (stage === 'pick') {
    const pickBody = (
      <>
        <p className="pw-form__note">{source === 'system' ? t('passwords.system.pick.body') : t('passwords.import.chooseBody')}</p>
        {busy && (
          <p className="pw-import__meta" role="status">
            <Spinner size={14} /> {t('passwords.import.reading')}
          </p>
        )}
      </>
    )
    body = source === 'system' ? <SystemStep step={step} title={t('passwords.system.pick.title')}>{pickBody}</SystemStep> : <div className="pw-form">{pickBody}</div>
    footer = (
      <>
        <Button variant="ghost" onClick={source === 'system' ? () => setStage('export') : close} disabled={busy}>
          {source === 'system' ? t('passwords.import.back') : t('passwords.import.cancel')}
        </Button>
        <Button variant="primary" icon={<FileUp />} loading={busy} onClick={() => void pick()} data-autofocus>
          {t('passwords.import.choose')}
        </Button>
      </>
    )
  } else if (stage === 'map' && preview) {
    const options = mappingOptions(preview.columns, t('passwords.import.noColumn'), (n) => t('passwords.import.column', { n }))
    const mapped = new Set([preview.mapping.url, preview.mapping.username, preview.mapping.password])
    body = (
      <div className="pw-form">
        <p className="pw-import__meta">
          <span>{t('passwords.import.file', { name: preview.fileName, count: preview.rowCount })}</span>
          <span>{t(FORMAT_KEY[preview.format])}</span>
        </p>
        <div className="pw-map">
          {FIELDS.map(({ field, label }) => (
            <Field key={field} label={t(label)} htmlFor={`${ids}-${field}`}>
              <Select
                id={`${ids}-${field}`}
                fullWidth
                value={preview.mapping[field] === null ? '' : String(preview.mapping[field])}
                options={options}
                onChange={(v) => void changeColumn(field, v)}
              />
            </Field>
          ))}
        </div>
        <div className="pw-preview" role="region" aria-label={t('passwords.import.preview')} tabIndex={0}>
          <table>
            <thead>
              <tr>
                {preview.columns.map((c, i) => (
                  <th key={i} scope="col" data-mapped={mapped.has(i)}>
                    {c || t('passwords.import.column', { n: i + 1 })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} data-mapped={mapped.has(i)}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="pw-form__note">{t('passwords.import.preview')}</p>
        <p className="pw-import__count" aria-live="polite">
          {t('passwords.import.importable', { count: preview.importable })}
        </p>
      </div>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={close} disabled={busy}>
          {t('passwords.import.cancel')}
        </Button>
        <Button variant="primary" loading={busy} disabled={preview.importable === 0} onClick={() => void confirm(preview)}>
          {t('passwords.import.confirm', { count: preview.importable })}
        </Button>
      </>
    )
  } else {
    const outcome = report ? importOutcome(report) : 'none'
    body = (
      <div className="pw-form">
        {report && (
          <>
            <Notice tone={outcome === 'none' ? 'warning' : 'info'}>
              {outcome === 'none' ? t('passwords.import.report.none') : outcome === 'incomplete' ? t('passwords.import.report.incomplete') : t('passwords.import.report.ok')}
            </Notice>
            <ul className="pw-report" aria-label={t('passwords.import.report.title')}>
              <li data-zero={report.added === 0}>{t('passwords.import.report.added', { count: report.added })}</li>
              <li data-zero={report.updated === 0}>{t('passwords.import.report.updated', { count: report.updated })}</li>
              <li data-zero={report.same === 0}>{t('passwords.import.report.same', { count: report.same })}</li>
              <li data-zero={report.skipped === 0}>{t('passwords.import.report.skipped', { count: report.skipped })}</li>
            </ul>
          </>
        )}
        {trashed ? (
          <p className="pw-form__note" role="status">
            {t('passwords.import.trashed')}
          </p>
        ) : (
          token.current && (
            <>
              <p className="pw-form__note">{t('passwords.import.trashBody')}</p>
              <div>
                <Button icon={<Trash2 />} loading={busy} onClick={() => void trash()}>
                  {t('passwords.import.trash')}
                </Button>
              </div>
            </>
          )
        )}
      </div>
    )
    footer = (
      <Button variant="primary" onClick={close} data-autofocus>
        {t('passwords.import.done')}
      </Button>
    )
  }

  return (
    <Dialog open={open} onClose={close} dismissible={!busy} title={stage === 'report' ? t('passwords.import.report.title') : title} size={stage === 'map' ? 'lg' : 'md'} footer={footer}>
      <div className="pw-form">
        {body}
        {error && (
          <p className="pw-form__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}

function SystemStep({ step, title, children }: { step: number; title: string; children: ReactNode }): ReactElement {
  const t = useT()
  return (
    <div className="pw-form">
      <div className="pw-steps" aria-hidden>
        {[1, 2, 3].map((n) => (
          <i key={n} data-on={n <= step} />
        ))}
      </div>
      <p className="pw-step-label">{t('passwords.system.step', { n: step })}</p>
      <h3 className="pw-welcome__title">{title}</h3>
      {children}
    </div>
  )
}
