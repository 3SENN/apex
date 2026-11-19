/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { strFromU8, unzipSync } from 'fflate'
import { decodeXml, readSharedStrings, readSheetXml, XLSX_PART_MAX_BYTES } from '@shared/sheetReader'
import type { SHEET_LIMITS } from '@shared/files'
import { OFFICE_MEDIA } from '../../../../src/main/intake/detect'

// The text of Word, Excel and PowerPoint files, read on this computer
// for chats on Claude Code (the API key sends office files to the code
// container instead). Pure and offline: fflate opens the zip and small
// readers walk the XML parts. Output is capped so a huge or hostile file
// never becomes a huge message. The text is model-facing, like a PDF's.

export type OfficeKind = keyof typeof OFFICE_MEDIA

/** The most text one office file adds to a message. */
export const OFFICE_TEXT_MAX_CHARS = 1_000_000
/** Rows and columns read per sheet; the text says when a sheet was cut. */
export const OFFICE_SHEET_LIMITS = { rows: 2000, columns: 60 } as const

export interface OfficeText {
  kind: OfficeKind
  text: string
  /** Sheets for a workbook, slides for a deck, 1 for a document. */
  parts: number
  truncated: boolean
}

/** The kind from the attachment's media type, then its name. */
export function officeKindOf(mediaType: string, name: string): OfficeKind | null {
  for (const [kind, media] of Object.entries(OFFICE_MEDIA) as Array<[OfficeKind, string]>) if (media === mediaType) return kind
  const ext = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase()
  return ext === 'docx' || ext === 'xlsx' || ext === 'pptx' ? ext : null
}

class TooLarge extends Error {}

function unzipParts(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        if (!wanted(file.name)) return false
        if (file.originalSize > XLSX_PART_MAX_BYTES) throw new TooLarge('too large')
        return true
      },
    })
  } catch (err) {
    throw new Error(err instanceof TooLarge ? 'A part of this file is too large to read.' : 'This file isn’t a readable Office document.')
  }
}

const text = (files: Record<string, Uint8Array>, path: string): string => (files[path] ? strFromU8(files[path]) : '')
const attr = (attrs: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null

/** Tags and text runs of an XML part, in order. */
const TOKENS = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g

function tidy(lines: readonly string[]): string {
  return lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---- Word ----

function headingLevel(style: string | null): number {
  if (!style) return 0
  if (/^(title|titel|titre|titolo)$/i.test(style)) return 1
  const n = /(?:heading|kop|berschrift|titre|titolo|encabezado)\s*(\d)/i.exec(style)?.[1]
  return n ? Math.min(6, Number(n)) : 0
}

/** A document.xml body as Markdown-like text: headings, list items, paragraphs and tables as rows. */
export function docxBodyText(xml: string): string {
  const lines: string[] = []
  let para = ''
  let style: string | null = null
  let listItem = false
  let inText = false
  let inProps = 0
  let tables = 0
  let row: string[] = []
  let cell: string[] = []
  const endParagraph = (): void => {
    const body = para.trimEnd()
    if (tables > 0) {
      if (body.trim()) cell.push(body.trim())
    } else {
      const level = headingLevel(style)
      if (!body.trim()) lines.push('')
      else lines.push(level > 0 ? `${'#'.repeat(level)} ${body.trim()}` : listItem ? `- ${body.trim()}` : body)
    }
    para = ''
    style = null
    listItem = false
  }
  for (const m of xml.matchAll(TOKENS)) {
    if (m[5] !== undefined) {
      if (inText) para += decodeXml(m[5])
      continue
    }
    const closing = m[1] === '/'
    const empty = m[4] === '/'
    const opening = !closing && !empty
    switch (m[2]) {
      case 'w:t':
        inText = opening
        break
      case 'w:pPr':
      case 'w:rPr':
        if (opening) inProps++
        else if (closing) inProps = Math.max(0, inProps - 1)
        break
      case 'w:tab':
        // Tab stops inside paragraph properties are layout, not text.
        if (!closing && inProps === 0) para += '\t'
        break
      case 'w:br':
      case 'w:cr':
        if (!closing) para += '\n'
        break
      case 'w:pStyle':
        style = attr(m[3] ?? '', 'w:val')
        break
      case 'w:numPr':
        if (!closing) listItem = true
        break
      case 'w:p':
        if (closing || empty) endParagraph()
        break
      case 'w:tbl':
        if (opening) {
          if (tables === 0) lines.push('')
          tables++
        } else if (closing) {
          tables = Math.max(0, tables - 1)
          if (tables === 0) lines.push('')
        }
        break
      case 'w:tc':
        if (closing && tables === 1) {
          row.push(cell.join(' ').replace(/\|/g, '\\|'))
          cell = []
        }
        break
      case 'w:tr':
        if (closing && tables === 1) {
          lines.push(`| ${row.join(' | ')} |`)
          row = []
        }
        break
    }
  }
  if (para) endParagraph()
  return tidy(lines)
}

function docxText(bytes: Uint8Array): OfficeText {
  const files = unzipParts(bytes, (name) => name === 'word/document.xml' || name === 'word/footnotes.xml')
  if (!files['word/document.xml']) throw new Error('This Word file has no document body.')
  const body = docxBodyText(text(files, 'word/document.xml'))
  const notes = files['word/footnotes.xml'] ? docxBodyText(text(files, 'word/footnotes.xml')) : ''
  return { kind: 'docx', text: notes ? `${body}\n\nFootnotes:\n${notes}` : body, parts: 1, truncated: false }
}

// ---- Excel ----

function sheetList(files: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const workbook = text(files, 'xl/workbook.xml')
  const rels = new Map<string, string>()
  for (const m of text(files, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1] ?? '', 'Id')
    const target = attr(m[1] ?? '', 'Target')
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m, i) => {
    const attrs = m[1] ?? ''
    const rid = attr(attrs, 'r:id')
    return { name: decodeXml(attr(attrs, 'name') ?? `Sheet ${i + 1}`), path: (rid && rels.get(rid)) || `xl/worksheets/sheet${i + 1}.xml` }
  })
  if (sheets.length > 0) return sheets
  return Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]))
    .map((path, i) => ({ name: `Sheet ${i + 1}`, path }))
}

function xlsxText(bytes: Uint8Array): OfficeText {
  const files = unzipParts(bytes, (name) => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml' || name.startsWith('xl/worksheets/sheet'))
  const shared = readSharedStrings(text(files, 'xl/sharedStrings.xml'))
  const sheets = sheetList(files)
  if (sheets.length === 0) throw new Error('This workbook has no sheets.')
  // readSheetXml's limits type is the preview's literal caps; the reader itself takes any numbers.
  const limits = OFFICE_SHEET_LIMITS as unknown as typeof SHEET_LIMITS
  const out: string[] = []
  let truncated = false
  for (const sheet of sheets) {
    const xml = text(files, sheet.path)
    out.push(`## Sheet: ${sheet.name}`)
    if (!xml) {
      out.push('(This sheet could not be read.)', '')
      continue
    }
    const data = readSheetXml(xml, shared, limits)
    const rows = data.rows.map((cells) => {
      let end = cells.length
      while (end > 0 && !cells[end - 1]) end--
      return cells.slice(0, end).join('\t')
    })
    while (rows.length > 0 && !rows.at(-1)) rows.pop()
    out.push(rows.length > 0 ? rows.join('\n') : '(empty)')
    if (data.truncated) {
      truncated = true
      out.push(`(Shortened: the first ${Math.min(data.totalRows, OFFICE_SHEET_LIMITS.rows)} of ${data.totalRows} rows and ${Math.min(data.totalColumns, OFFICE_SHEET_LIMITS.columns)} of ${data.totalColumns} columns.)`)
    }
    out.push('')
  }
  return { kind: 'xlsx', text: out.join('\n').trim(), parts: sheets.length, truncated }
}

// ---- PowerPoint ----

/** A slide or notes part's text: one line per paragraph, slide-number fields left out. */
export function drawingText(xml: string): string {
  const lines: string[] = []
  let para = ''
  let inText = false
  let field = 0
  for (const m of xml.matchAll(TOKENS)) {
    if (m[5] !== undefined) {
      if (inText && field === 0) para += decodeXml(m[5])
      continue
    }
    const closing = m[1] === '/'
    const empty = m[4] === '/'
    switch (m[2]) {
      case 'a:t':
        inText = !closing && !empty
        break
      case 'a:fld':
        if (!closing && !empty && /\btype="slidenum"/i.test(m[3] ?? '')) field++
        else if (closing && field > 0) field--
        break
      case 'a:br':
        if (!closing) para += '\n'
        break
      case 'a:p':
        if (closing || empty) {
          if (para.trim()) lines.push(para.trim())
          para = ''
        }
        break
    }
  }
  if (para.trim()) lines.push(para.trim())
  return lines.join('\n')
}

function relTargets(xml: string, base: string): Array<{ id: string; type: string; path: string }> {
  return [...xml.matchAll(/<Relationship\b([^>]*)\/?>/g)].flatMap((m) => {
    const attrs = m[1] ?? ''
    const id = attr(attrs, 'Id')
    const target = attr(attrs, 'Target')
    if (!id || !target) return []
    return [{ id, type: attr(attrs, 'Type') ?? '', path: resolvePart(base, target) }]
  })
}

/** A relationship target against its part's folder: ppt/slides + ../notesSlides/n.xml → ppt/notesSlides/n.xml. */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').filter(Boolean)
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop()
    else if (piece !== '.' && piece) parts.push(piece)
  }
  return parts.join('/')
}

function pptxText(bytes: Uint8Array): OfficeText {
  const files = unzipParts(bytes, (name) => name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels' || /^ppt\/(slides|notesSlides)\/(_rels\/)?[^/]+\.xml(\.rels)?$/.test(name))
  const rels = new Map(relTargets(text(files, 'ppt/_rels/presentation.xml.rels'), 'ppt').map((r) => [r.id, r.path]))
  let slides = [...text(files, 'ppt/presentation.xml').matchAll(/<p:sldId\b([^>]*)\/?>/g)]
    .map((m) => rels.get(attr(m[1] ?? '', 'r:id') ?? '') ?? '')
    .filter((path) => path && files[path])
  if (slides.length === 0) {
    slides = Object.keys(files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]))
  }
  if (slides.length === 0) throw new Error('This presentation has no slides.')
  const out: string[] = []
  slides.forEach((path, i) => {
    out.push(`## Slide ${i + 1}`)
    out.push(drawingText(text(files, path)) || '(no text)')
    const name = path.split('/').pop() ?? ''
    const notesPath = relTargets(text(files, `ppt/slides/_rels/${name}.rels`), 'ppt/slides').find((r) => r.type.endsWith('/notesSlide'))?.path
    const notes = notesPath ? drawingText(text(files, notesPath)) : ''
    if (notes) out.push(`Notes: ${notes}`)
    out.push('')
  })
  return { kind: 'pptx', text: out.join('\n').trim(), parts: slides.length, truncated: false }
}

/** The file's text, capped at OFFICE_TEXT_MAX_CHARS. Throws a plain sentence when it can't be read. */
export function extractOfficeText(bytes: Uint8Array, kind: OfficeKind, maxChars: number = OFFICE_TEXT_MAX_CHARS): OfficeText {
  const result = kind === 'docx' ? docxText(bytes) : kind === 'xlsx' ? xlsxText(bytes) : pptxText(bytes)
  if (result.text.length <= maxChars) return result
  return { ...result, text: `${result.text.slice(0, maxChars)}\n(The rest of this file was left out: it is too long for one message.)`, truncated: true }
}
