/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { SHEET_LIMITS } from '@shared/files'
import { t } from '@shared/i18n/core'
import { columnIndex, columnName, decodeXml, readDelimited, readSharedStrings, readSheetXml, readXlsx } from '@shared/sheetReader'

// Atelier's own sheet reader (OV-32, CH-28): CSV and TSV, and the first sheet of
// an XLSX workbook through fflate, always capped at 200 rows by 50 columns.

function grid(rows: number, cols: number, sep = ','): string {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`).join(sep)).join('\n')
}

function workbook(sheetXml: string, options: { shared?: string[]; sheets?: string[] } = {}): Uint8Array {
  const sheets = options.sheets ?? ['Budget']
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(`<workbook><sheets>${sheets.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
  }
  if (options.shared) files['xl/sharedStrings.xml'] = strToU8(`<sst>${options.shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`)
  for (let i = 1; i < sheets.length; i++) files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8('<worksheet><sheetData/></worksheet>')
  return zipSync(files)
}

describe('delimited sheets', () => {
  it('keeps everything under the cap', () => {
    const sheet = readDelimited('name,qty\nPears,4\n"Figs, dried",12\n')
    expect(sheet.rows).toEqual([['name', 'qty'], ['Pears', '4'], ['Figs, dried', '12']])
    expect(sheet).toMatchObject({ totalRows: 3, totalColumns: 2, truncated: false, sheetName: null, sheetCount: 1 })
  })

  it('caps rows at 200 and columns at 50, counting the whole sheet', () => {
    const sheet = readDelimited(grid(260, 70))
    expect(sheet.rows).toHaveLength(SHEET_LIMITS.rows)
    expect(sheet.rows.every((r) => r.length === SHEET_LIMITS.columns)).toBe(true)
    expect(sheet.rows[199]?.[49]).toBe('r199c49')
    expect(sheet).toMatchObject({ totalRows: 260, totalColumns: 70, truncated: true })
  })

  it('reads TSV, and a quoted newline stays inside its cell', () => {
    expect(readDelimited('a\tb\n1\t2', '\t').rows).toEqual([['a', 'b'], ['1', '2']])
    const quoted = readDelimited(`${grid(201, 1)}\n"two\nlines"`)
    expect(quoted.totalRows).toBe(202)
  })
})

describe('XLSX', () => {
  it('reads shared, inline, boolean and number cells of the first sheet, with gaps kept', () => {
    const xml =
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Q&amp;A</t></is></c></row>' +
      '<row r="3"><c r="A3"><v>42.5</v></c><c r="B3" t="b"><v>1</v></c></row>' +
      '</sheetData></worksheet>'
    const sheet = readXlsx(workbook(xml, { shared: ['Item'], sheets: ['Budget', 'Notes'] }))
    expect(sheet.rows).toEqual([['Item', '', 'Q&A'], [], ['42.5', 'TRUE']])
    expect(sheet).toMatchObject({ totalRows: 3, totalColumns: 3, truncated: false, sheetName: 'Budget', sheetCount: 2 })
  })

  it('caps a large sheet at 200 by 50 and reports its full size', () => {
    let xml = '<worksheet><sheetData>'
    for (let r = 1; r <= 230; r++) {
      xml += `<row r="${r}">`
      for (let c = 0; c < 60; c++) xml += `<c r="${columnName(c)}${r}"><v>${r * 100 + c}</v></c>`
      xml += '</row>'
    }
    xml += '</sheetData></worksheet>'
    const sheet = readXlsx(workbook(xml))
    expect(sheet.rows).toHaveLength(200)
    expect(Math.max(...sheet.rows.map((r) => r.length))).toBe(50)
    expect(sheet.rows[0]?.[49]).toBe('149')
    expect(sheet).toMatchObject({ totalRows: 230, totalColumns: 60, truncated: true })
  })

  it('refuses files that are not workbooks, and workbooks with no sheet', () => {
    expect(() => readXlsx(strToU8('not a zip'))).toThrow(t('files.error.notWorkbook'))
    expect(() => readXlsx(zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') }))).toThrow(t('files.error.noSheet'))
  })

  it('maps column letters both ways and decodes XML text', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA'])
    expect(['A1', 'Z9', 'AA10', 'AAA1'].map(columnIndex)).toEqual([0, 25, 26, 702])
    expect(columnIndex('1A')).toBeNull()
    expect(decodeXml('a &lt;b&gt; &amp; &#65;&#x42;')).toBe('a <b> & AB')
    expect(readSharedStrings('<sst><si><r><t>Bold</t></r><r><t xml:space="preserve"> part</t></r></si></sst>')).toEqual(['Bold part'])
    expect(readSheetXml('<sheetData><row r="1"/></sheetData>', []).rows).toEqual([[]])
  })
})
