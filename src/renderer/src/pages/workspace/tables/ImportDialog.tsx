/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The CSV import preview: what Apex read from the file (its
// delimiter, whether the first row names the columns, each column's type and
// a sample), editable before anything is written. Confirm imports it.
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { TABLE_COLUMN_TYPES, columnIdentifiers, type CsvPreview, type TableColumn, type TableColumnType, type TableSummary } from '@shared/tables'
import { call, errorText } from '../../../api'
import { t, type MessageKey } from '../../../i18n/useT'
import { Field } from '../../../settings/kit'
import { Button, Dialog, Select, Switch } from '../../../ui'

const DELIMITERS: Record<string, MessageKey> = { ',': 'platform.tables.delim.comma', ';': 'platform.tables.delim.semicolon', '\t': 'platform.tables.delim.tab' }

export function defaultTableName(fileName: string): string {
  return fileName.replace(/\.(csv|tsv|txt)$/i, '').trim() || 'table'
}

export function ImportDialog({ preview, onClose }: { preview: CsvPreview | null; onClose(table: TableSummary | null): void }): ReactElement | null {
  const [name, setName] = useState('')
  const [hasHeader, setHasHeader] = useState(true)
  const [columns, setColumns] = useState<TableColumn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameField = useRef<HTMLInputElement>(null)
  const nameId = useId()

  useEffect(() => {
    if (!preview) return
    setName(defaultTableName(preview.fileName))
    setHasHeader(preview.hasHeader)
    setColumns(preview.columns)
    setError(null)
    setBusy(false)
  }, [preview?.token])

  const saved = useMemo(() => columnIdentifiers(columns.map((c) => c.name)), [columns])
  if (!preview) return null

  const rowCount = preview.rowCount + (hasHeader === preview.hasHeader ? 0 : preview.hasHeader ? 1 : -1)
  const switchHeader = async (on: boolean): Promise<void> => {
    setHasHeader(on)
    try {
      setColumns(await call('tables', 'previewColumns', preview.token, on))
    } catch (err) {
      setError(errorText(err))
    }
  }
  const setColumn = (i: number, patch: Partial<TableColumn>): void => setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const blank = columns.findIndex((c) => !c.name.trim())

  const confirm = async (): Promise<void> => {
    if (!name.trim()) {
      setError(t('platform.tables.import.needName'))
      nameField.current?.focus()
      return
    }
    if (blank >= 0) {
      setError(t('platform.tables.import.needColumn', { n: String(blank + 1) }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const table = await call('tables', 'confirmImport', preview.token, { name: name.trim(), columns: columns.map((c) => ({ name: c.name.trim().slice(0, 64), type: c.type })), hasHeader })
      onClose(table)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const typeOptions = TABLE_COLUMN_TYPES.map((type) => ({ value: type, label: t(`platform.tables.type.${type}` as MessageKey) }))

  return (
    <Dialog
      open
      size="lg"
      onClose={() => !busy && onClose(null)}
      title={t('platform.tables.import.title')}
      description={
        <span className="pl-import-meta">
          <span>
            <FileSpreadsheet size={13} aria-hidden /> {preview.fileName}
          </span>
          <span>{t('platform.tables.rowCount', { count: rowCount })}</span>
          <span>{t(DELIMITERS[preview.delimiter] ?? 'platform.tables.delim.comma')}</span>
        </span>
      }
      initialFocus={nameField}
      footer={
        <>
          <Button onClick={() => onClose(null)} disabled={busy}>
            {t('platform.common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void confirm()}>
            {t('platform.tables.import.confirm', { count: rowCount })}
          </Button>
        </>
      }
    >
      <div className="pl-stack">
        <Field label={t('platform.tables.import.name')} htmlFor={nameId} hint={t('platform.tables.import.nameHint')}>
          <input ref={nameField} id={nameId} className="sp-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Switch checked={hasHeader} onChange={(on) => void switchHeader(on)} label={t('platform.tables.import.header')} description={t('platform.tables.import.headerHint')} />
        <div>
          <p className="pl-section-title" id={`${nameId}-cols`}>
            {t('platform.tables.import.columns', { count: columns.length })}
          </p>
          <div className="pl-columns" role="group" aria-labelledby={`${nameId}-cols`}>
            {columns.map((c, i) => (
              <div className="pl-column" key={i}>
                <span className="pl-column__n">{i + 1}</span>
                <span>
                  <input
                    className="sp-input"
                    value={c.name}
                    maxLength={64}
                    aria-label={t('platform.tables.import.columnName', { n: String(i + 1) })}
                    aria-invalid={!c.name.trim() || undefined}
                    onChange={(e) => setColumn(i, { name: e.target.value })}
                  />
                  {saved[i] && saved[i] !== c.name.trim() && <span className="pl-faint pl-mono">{t('platform.tables.import.savedAs', { name: saved[i] ?? '' })}</span>}
                </span>
                <Select<TableColumnType> size="sm" value={c.type} options={typeOptions} onChange={(type) => setColumn(i, { type })} aria-label={t('platform.tables.import.columnType', { n: String(i + 1) })} />
              </div>
            ))}
          </div>
        </div>
        {preview.sample.length > 0 && (
          <div>
            <p className="pl-section-title">{t('platform.tables.import.sample')}</p>
            <div className="pl-sample" tabIndex={0} role="region" aria-label={t('platform.tables.import.sample')}>
              <table>
                <thead>
                  <tr>
                    {columns.map((c, i) => (
                      <th key={i} scope="col">
                        {c.name || t('platform.tables.import.unnamed')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row, r) => (
                    <tr key={r}>
                      {columns.map((_, i) => (
                        <td key={i} title={row[i] ?? ''}>
                          {row[i] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {error && (
          <p className="pl-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
