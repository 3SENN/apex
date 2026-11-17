/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { SHEET_LIMITS, type SheetData } from '@shared/files'
import { t } from '@shared/i18n/core'
import { columnName } from '@shared/sheetReader'

// Spreadsheets (OV-32, CH-28): the first sheet main read, capped at
// SHEET_LIMITS rows and columns, with column letters and row numbers like a
// sheet app, and a note when the file holds more than shows.

export function SheetView({ sheet, name }: { sheet: SheetData; name: string }): ReactElement {
  const width = Math.max(0, ...sheet.rows.map((r) => r.length))
  const columns = Array.from({ length: width }, (_, i) => columnName(i))
  return (
    <>
      {(sheet.sheetName !== null && sheet.sheetCount > 1) || sheet.truncated ? (
        <p className="fv-sheet__meta">
          {sheet.sheetName !== null && sheet.sheetCount > 1 && t('files.viewer.sheet.sheets', { name: sheet.sheetName, count: sheet.sheetCount })}
          {sheet.sheetName !== null && sheet.sheetCount > 1 && sheet.truncated && ' · '}
          {sheet.truncated &&
            t('files.viewer.sheet.more', {
              rows: Math.min(sheet.totalRows, SHEET_LIMITS.rows),
              columns: Math.min(sheet.totalColumns, SHEET_LIMITS.columns),
              totalRows: sheet.totalRows,
              totalColumns: sheet.totalColumns,
            })}
        </p>
      ) : null}
      <div className="fv-sheet" tabIndex={0} role="region" aria-label={name}>
        {sheet.rows.length === 0 ? (
          <p className="fv-placeholder__meta" style={{ padding: 16 }}>
            {t('files.viewer.empty')}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col" aria-hidden />
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row">{r + 1}</th>
                  {columns.map((c, i) => (
                    <td key={c} title={(row[i] ?? '').length > 40 ? row[i] : undefined}>
                      {row[i] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
