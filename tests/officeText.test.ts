/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { docxBodyText, drawingText, extractOfficeText, officeKindOf, OFFICE_SHEET_LIMITS, resolvePart } from '../src/engines/claude-code/main/officeText'

// Office files' text, read on this computer for chats on Claude Code.
// Every file here is built in memory; nothing leaves the machine.

const zip = (parts: Record<string, string>): Uint8Array => zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)])))

const W = (body: string): string => `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`
const para = (text: string, props = ''): string => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

describe('officeKindOf', () => {
  it('knows the kind from the media type, then the name', () => {
    expect(officeKindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x')).toBe('docx')
    expect(officeKindOf('application/zip', 'Deck.PPTX')).toBe('pptx')
    expect(officeKindOf('application/vnd.ms-excel', 'Budget.xlsx')).toBe('xlsx')
    expect(officeKindOf('application/zip', 'archive.zip')).toBeNull()
  })
})

describe('Word documents', () => {
  it('keeps headings, list items, paragraphs, tabs and breaks, and leaves tab stops out', () => {
    const xml = W(
      para('Quarterly plan', '<w:pStyle w:val="Title"/>') +
        para('Goals', '<w:pStyle w:val="Heading2"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>') +
        para('Ship &amp; learn', '<w:numPr><w:ilvl w:val="0"/></w:numPr>') +
        '<w:p><w:r><w:t>Name</w:t></w:r><w:r><w:tab/><w:t>Owner</w:t></w:r><w:r><w:br/><w:t>Next line</w:t></w:r></w:p>' +
        '<w:p/>' +
        para('Doelen', '<w:pStyle w:val="Kop1"/>'),
    )
    expect(docxBodyText(xml)).toBe('# Quarterly plan\n## Goals\n- Ship & learn\nName\tOwner\nNext line\n\n# Doelen')
  })

  it('writes tables as rows of cells', () => {
    const cell = (text: string): string => `<w:tc><w:tcPr/>${para(text)}</w:tc>`
    const xml = W(`${para('Before')}<w:tbl><w:tr>${cell('Item')}${cell('Cost')}</w:tr><w:tr>${cell('Rent | hall')}${cell('1200')}</w:tr></w:tbl>${para('After')}`)
    expect(docxBodyText(xml)).toBe('Before\n\n| Item | Cost |\n| Rent \\| hall | 1200 |\n\nAfter')
  })

  it('reads a whole .docx with its footnotes', () => {
    const bytes = zip({ 'word/document.xml': W(para('Body text')), 'word/footnotes.xml': `<w:footnotes>${para('A note')}</w:footnotes>`, 'word/styles.xml': '<x/>' })
    expect(extractOfficeText(bytes, 'docx')).toEqual({ kind: 'docx', text: 'Body text\n\nFootnotes:\nA note', parts: 1, truncated: false })
  })
})

describe('Excel workbooks', () => {
  const workbook = (sheets: Record<string, string>, shared: string[] = []): Uint8Array => {
    const names = Object.keys(sheets)
    return zip({
      'xl/workbook.xml': `<workbook><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${names.length - i}.xml"/>`).join('')}</Relationships>`,
      'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      ...Object.fromEntries(names.map((n, i) => [`xl/worksheets/sheet${names.length - i}.xml`, `<worksheet><sheetData>${sheets[n]}</sheetData></worksheet>`])),
    })
  }

  it('reads every sheet in workbook order, through the relationships, with shared strings', () => {
    const bytes = workbook(
      {
        Costs: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1200</v></c></row>',
        'R&amp;D': '<row r="1"><c r="A1" t="b"><v>1</v></c></row>',
      },
      ['Item', 'Cost', 'Rent'],
    )
    expect(extractOfficeText(bytes, 'xlsx')).toEqual({ kind: 'xlsx', text: '## Sheet: Costs\nItem\tCost\nRent\t\t1200\n\n## Sheet: R&D\nTRUE', parts: 2, truncated: false })
  })

  it('says when a big sheet was shortened', () => {
    const rows = Array.from({ length: OFFICE_SHEET_LIMITS.rows + 5 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')
    const out = extractOfficeText(workbook({ Big: rows }), 'xlsx')
    expect(out.truncated).toBe(true)
    expect(out.text).toContain(`(Shortened: the first ${OFFICE_SHEET_LIMITS.rows} of ${OFFICE_SHEET_LIMITS.rows + 5} rows`)
    expect(out.text.split('\n').filter((l) => /^\d+$/.test(l))).toHaveLength(OFFICE_SHEET_LIMITS.rows)
  })

  it('falls back to the sheet files when the workbook lists none', () => {
    const bytes = zip({ 'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData></worksheet>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' })
    expect(extractOfficeText(bytes, 'xlsx').text).toBe('## Sheet: Sheet 1\n1\n\n## Sheet: Sheet 2\n2')
  })
})

describe('PowerPoint decks', () => {
  const slide = (texts: string[]): string => `<p:sld><p:cSld><p:spTree>${texts.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`

  it('reads slides in the presentation’s order, with their notes, and leaves slide numbers out', () => {
    const bytes = zip({
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slide(['Second', 'Point &lt;b&gt;']),
      'ppt/slides/slide2.xml': slide(['First']),
      'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas/notesSlide" Target="../notesSlides/notesSlide7.xml"/></Relationships>',
      'ppt/notesSlides/notesSlide7.xml': '<p:notes><a:p><a:r><a:t>Say hello</a:t></a:r></a:p><a:p><a:fld type="slidenum"><a:t>1</a:t></a:fld></a:p></p:notes>',
    })
    expect(extractOfficeText(bytes, 'pptx')).toEqual({ kind: 'pptx', text: '## Slide 1\nFirst\nNotes: Say hello\n\n## Slide 2\nSecond\nPoint <b>', parts: 2, truncated: false })
  })

  it('breaks lines and resolves relationship targets', () => {
    expect(drawingText('<a:p><a:r><a:t>One</a:t></a:r><a:br/><a:r><a:t>Two</a:t></a:r></a:p><a:p/>')).toBe('One\nTwo')
    expect(resolvePart('ppt/slides', '../notesSlides/n1.xml')).toBe('ppt/notesSlides/n1.xml')
    expect(resolvePart('ppt', '/ppt/slides/s.xml')).toBe('ppt/slides/s.xml')
  })
})

describe('limits and damaged files', () => {
  it('caps the text and says the rest was left out', () => {
    const bytes = zip({ 'word/document.xml': W(para('x'.repeat(500))) })
    const out = extractOfficeText(bytes, 'docx', 100)
    expect(out.truncated).toBe(true)
    expect(out.text).toBe(`${'x'.repeat(100)}\n(The rest of this file was left out: it is too long for one message.)`)
  })

  it('throws plain sentences for files it can’t read', () => {
    expect(() => extractOfficeText(strToU8('not a zip'), 'docx')).toThrow('This file isn’t a readable Office document.')
    expect(() => extractOfficeText(zip({ 'word/other.xml': '<x/>' }), 'docx')).toThrow('This Word file has no document body.')
    expect(() => extractOfficeText(zip({ 'ppt/presentation.xml': '<p/>' }), 'pptx')).toThrow('This presentation has no slides.')
    expect(() => extractOfficeText(zip({ 'xl/styles.xml': '<x/>' }), 'xlsx')).toThrow('This workbook has no sheets.')
  })
})
