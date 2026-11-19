/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '../src/shared/branding'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { AttachmentKind, AttachmentRef } from '@shared/attachments'
import type { PreparedAttachment } from '../src/main/intake/types'
import { SessionRichChat, type SessionRichChatHost } from '../src/main/agent/sessionRichChat'
import { claudeCodeBlocks } from '../src/engines/claude-code/main/blocks'

// Attachments as Claude Code's stream-json blocks (blocks.ts): base64 images,
// PDFs as documents, text and office files as their text. The API key's
// blocks are tests/agentContent.test.ts.

const ref = (id: string, kind: AttachmentKind, name: string, extra: Partial<AttachmentRef> = {}): AttachmentRef => ({ id, kind, name, state: 'ready', error: null, size: 10, mediaType: 'application/octet-stream', thumbnail: null, ...extra })

const image: PreparedAttachment = { ref: ref('a-img', 'image', 'photo.png'), payload: { type: 'image', mediaType: 'image/png', path: '/x/photo.png' } }
const pdf: PreparedAttachment = { ref: ref('a-pdf', 'pdf', 'Report.pdf'), payload: { type: 'pdf', path: '/x/report.pdf', pages: 3, text: 'Page one text' } }
const tab: PreparedAttachment = { ref: ref('a-tab', 'tab', 'Example'), payload: { type: 'text', text: 'Page text', title: 'Example', sourceUrl: 'https://example.com/' } }
const selection: PreparedAttachment = {
  ref: ref('a-sel', 'selection', 'Quote', { source: { url: 'https://news.example/a', title: 'The article' } }),
  payload: { type: 'text', text: 'A quoted line', title: 'Quote', sourceUrl: 'https://news.example/a' },
}
const office: PreparedAttachment = { ref: ref('a-doc', 'office', 'Budget.xlsx'), payload: { type: 'office', path: '/x/budget.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }
const skill: PreparedAttachment = { ref: ref('a-skill', 'skill', 'brand-kit'), payload: { type: 'skill', skillId: 'brand-kit' } }

const blockContext = () => ({
  skill: (id: string) => (id === 'brand-kit' ? { name: 'brand-kit', instructions: 'Use the brand colours.' } : null),
  readFile: (path: string) => Buffer.from(`bytes of ${path}`),
})

describe('Claude Code content blocks', () => {
  const ctx = { skill: blockContext().skill, readFile: blockContext().readFile }

  it('sends images as base64 and PDFs and text as extracted text', () => {
    const blocks = claudeCodeBlocks([image, pdf, tab, selection, skill], ctx)
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('bytes of /x/photo.png').toString('base64') } })
    // The PDF itself as a document block, as on the API key (its text only when it is very large or unreadable).
    expect(blocks[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('bytes of /x/report.pdf').toString('base64') }, title: 'Report.pdf' })
    expect(blocks[2]).toEqual({ type: 'text', text: '<document title="Example" source="https://example.com/">\nPage text\n</document>' })
    expect(blocks[3]).toMatchObject({ type: 'text', text: expect.stringContaining('kind="quote from a page the user selected"') })
    expect(blocks[4]).toMatchObject({ type: 'text', text: expect.stringContaining('<skill name="brand-kit">') })
  })

  it('reads office files as text on this computer, and says so plainly when it can’t', () => {
    const workbook = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Q3" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>'),
    })
    const blocks = claudeCodeBlocks([office], { skill: () => null, readFile: () => Buffer.from(workbook) })
    expect(blocks).toEqual([{ type: 'text', text: '<document title="Budget.xlsx" kind="xlsx" sheets="1">\n## Sheet: Q3\nTotal\t42\n</document>' }])
    expect(() => claudeCodeBlocks([office], ctx)).toThrow(`${BRAND_NAME} couldn’t read the text of Budget.xlsx`)
  })
})

describe('the request matrix on Claude Code', () => {
  const session = new SessionRichChat({} as SessionRichChatHost, () => undefined)

  it('sends Claude Code only base64 images and text, with documents in its own folder instead of a container', () => {
    const setup = session.draftSetup('claude-code', 'claude-opus-5-5', true)
    expect(setup).toEqual({ documents: true, compaction: false })
    const blocks = claudeCodeBlocks([image, pdf, tab], { skill: () => null, readFile: (p) => Buffer.from(p) })
    expect(blocks.map((b) => b.type)).toEqual(['image', 'document', 'text']) // PDFs as documents
    expect(blocks[0]).toMatchObject({ source: { type: 'base64' } })
  })
})
