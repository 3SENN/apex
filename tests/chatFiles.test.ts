/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../src/shared/attachments'
import type { LibraryFileRef } from '../src/shared/files'
import type { AgentEvent } from '../src/shared/ipc'
import { READ_BINARY_MAX, READ_TEXT_MAX, chatFilesReader, chatManifest, type ChatFilesDeps } from '../src/main/intake/chatFiles'

// CH-28: the chat's virtual folders, computed from the chat record and the
// stores, with their sizes, preview kinds, read caps and reveal rules.

const CHAT = '11111111-1111-4111-8111-111111111111'

const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({ id: 'a', kind: 'paste', name: 'Pasted text', state: 'ready', error: null, size: 5, mediaType: 'text/plain', thumbnail: null, ...over })

function deps(over: Partial<ChatFilesDeps> = {}): { deps: ChatFilesDeps; folder: string } {
  const folder = mkdtempSync(join(tmpdir(), 'apex-chatfiles-'))
  writeFileSync(join(folder, 'original'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'nav', name: 'navigate', toolset_name: 'browser', input: { tab_id: 't1', url: 'https://docs.test/a' } },
        { type: 'tool_use', id: 'txt', name: 'get_page_text', toolset_name: 'browser', input: { tab_id: 't1' } },
        { type: 'tool_use', id: 'calc', name: 'save_artifact', input: {} },
        { type: 'server_tool_use', id: 'wf', name: 'web_fetch', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'nav', content: [{ type: 'image', source: {} }] },
        { type: 'tool_result', tool_use_id: 'txt', content: [{ type: 'text', text: 'The page text' }] },
        { type: 'tool_result', tool_use_id: 'calc', content: { saved: true } },
      ],
    },
    { role: 'assistant', content: [{ type: 'web_fetch_tool_result', tool_use_id: 'wf', content: { type: 'web_fetch_result', url: 'https://fetched.test/x', content: { source: { data: 'fetched body' } } } }] },
  ]
  const log = [
    { type: 'user-message', text: 'Read this', attachments: [ref({ name: 'notes.md' })] },
    { type: 'text-delta', turnId: 'r1', text: 'Here ' },
    { type: 'text-delta', turnId: 'r1', text: 'it is.' },
  ] as unknown as AgentEvent[]
  const attachments: ReturnType<ChatFilesDeps['attachments']> = [
    { ref: ref({ id: 'p1', kind: 'paste' }), messageId: 'm', createdAt: 5, folder, hasOriginal: true },
    { ref: ref({ id: 'i1', kind: 'image', name: 'cat.png', mediaType: 'image/png', size: 4 }), messageId: 'm', createdAt: 6, folder, hasOriginal: true },
    { ref: ref({ id: 't1', kind: 'tab', name: 'Docs' }), messageId: 'm', createdAt: 7, folder, hasOriginal: false },
    { ref: ref({ id: 'f1', kind: 'image', state: 'failed' }), messageId: null, createdAt: 8, folder, hasOriginal: false },
  ]
  const generated: LibraryFileRef[] = [{ id: 'g1', name: 'report.md', mediaType: 'text/markdown', size: 10, kind: 'generated', chatId: CHAT, createdAt: 9 } as unknown as LibraryFileRef]
  return {
    folder,
    deps: {
      load: () => ({ messages, log, updatedAt: 100 }),
      attachments: () => attachments,
      attachmentText: (_chat, id) => (id === 'p1' ? 'hello' : id === 't1' ? 'tab text' : null),
      generated: () => generated,
      ...over,
    },
  }
}

describe('chatManifest', () => {
  it('builds each folder from the chat record and the stores', () => {
    const files = chatManifest(CHAT, deps().deps).map((f) => f.entry)
    const byFolder = (folder: string) => files.filter((f) => f.folder === folder).map((f) => f.name)
    expect(byFolder('tabs')).toEqual(['01 docs.test.txt', '02 fetched.test.txt'])
    expect(byFolder('tool-results')).toEqual(['01 save_artifact.json'])
    expect(byFolder('messages')).toEqual(['01 You.md', '02 Reply.md'])
    expect(byFolder('attachments')).toEqual(['Pasted text.txt', 'cat.png'])
    expect(byFolder('context')).toEqual(['Docs.txt'])
    expect(byFolder('generated')).toEqual(['report.md'])
    const image = files.find((f) => f.name === 'cat.png')
    expect(image).toMatchObject({ previewable: 'image', revealable: true, chars: null })
    expect(files.find((f) => f.name === '01 save_artifact.json')).toMatchObject({ previewable: 'code', mediaType: 'application/json' })
    expect(files.find((f) => f.name === '01 You.md')?.chars).toBeGreaterThan(0)
  })

  it('has only the store folders for a draft', () => {
    const files = chatManifest(CHAT, deps({ load: () => null, generated: () => [] }).deps)
    expect(new Set(files.map((f) => f.entry.folder))).toEqual(new Set(['attachments', 'context']))
  })
})

describe('chatFilesReader', () => {
  it('lists the non-empty folders in order, then their files', () => {
    const reader = chatFilesReader(deps().deps, () => {})
    expect(reader.list(CHAT, '').map((f) => [f.name, f.kind])).toEqual([
      ['tabs', 'folder'],
      ['attachments', 'folder'],
      ['messages', 'folder'],
      ['tool-results', 'folder'],
      ['context', 'folder'],
      ['generated', 'folder'],
    ])
    expect(reader.list(CHAT, 'messages')).toHaveLength(2)
    expect(reader.count(CHAT)).toBe(9)
  })

  it('reads text and images, and caps what it sends', () => {
    const big = 'x'.repeat(READ_TEXT_MAX + 5)
    const reader = chatFilesReader(deps({ attachmentText: () => big }).deps, () => {})
    const text = reader.read(CHAT, 'attachments/p1')
    expect(text.truncated).toBe(true)
    expect(text.text).toHaveLength(READ_TEXT_MAX)
    expect(reader.read(CHAT, 'attachments/i1')).toEqual({ dataUrl: 'data:image/png;base64,iVBORw==', truncated: false })
    expect(() => reader.read(CHAT, 'generated/g1')).toThrow('Open this file from Library › Files')
    expect(() => reader.read(CHAT, 'attachments/nope')).toThrow('This file is no longer in the chat')
  })

  it('sends no data for a binary over the cap', () => {
    const { deps: d, folder } = deps()
    const huge = { ref: ref({ id: 'h1', kind: 'pdf', name: 'big.pdf', mediaType: 'application/pdf', size: READ_BINARY_MAX + 1 }), messageId: 'm', createdAt: 1, folder, hasOriginal: false }
    const reader = chatFilesReader({ ...d, attachments: () => [huge] }, () => {})
    expect(reader.read(CHAT, 'attachments/h1')).toEqual({ truncated: true })
  })

  it('reveals only physical files', () => {
    const revealed: string[] = []
    const { deps: d, folder } = deps()
    const reader = chatFilesReader(d, (p) => revealed.push(p))
    reader.reveal(CHAT, 'attachments/i1')
    expect(revealed).toEqual([join(folder, 'original')])
    expect(reader.physicalPath(CHAT, 'messages/01')).toBeNull()
    expect(() => reader.reveal(CHAT, 'messages/01')).toThrow('Only saved files can be shown in their folder')
  })
})
