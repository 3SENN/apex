/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { AttachmentKind, AttachmentRef } from '@shared/attachments'
import type { EngineId } from '@shared/engine'
import type { ChatCapabilities } from '../src/main/chats'
import type { PreparedAttachment } from '../src/main/intake/types'
import type { ResolvedConnector } from '../src/main/stores'
import {
  apiBlocks,
  assertRequestSize,
  attachmentBlocksOf,
  deleteRemoteFiles,
  keyFingerprint,
  OFFICE_NEEDS_DOCUMENTS,
  RemoteFileCache,
  REQUEST_TOO_LARGE,
  type ApiBlockContext,
  type FilesApi,
} from '../src/main/agent/content'
import { buildRequest } from '../src/main/agent/session'
import { SessionRichChat, type SessionRichChatHost } from '../src/main/agent/sessionRichChat'
import type { RichRequest } from '../src/main/agent/richRequest'

// The request half: attachments into content blocks, the Files API cache
// with its base64 fallback, the 32 MB cap, and the request matrix
// (attachments × engines × documents × models). Another engine's own blocks
// are its backend's (the Claude subscription engine's are in its own tests).
// The Files API is a fake; nothing leaves the machine.

const ref = (id: string, kind: AttachmentKind, name: string, extra: Partial<AttachmentRef> = {}): AttachmentRef => ({ id, kind, name, state: 'ready', error: null, size: 10, mediaType: 'application/octet-stream', thumbnail: null, ...extra })

const image: PreparedAttachment = { ref: ref('a-img', 'image', 'photo.png'), payload: { type: 'image', mediaType: 'image/png', path: '/x/photo.png' } }
const pdf: PreparedAttachment = { ref: ref('a-pdf', 'pdf', 'Report.pdf'), payload: { type: 'pdf', path: '/x/report.pdf', pages: 3, text: 'Page one text' } }
const text: PreparedAttachment = { ref: ref('a-txt', 'text', 'notes.txt'), payload: { type: 'text', text: 'Some notes', title: 'notes.txt', sourceUrl: null } }
const tab: PreparedAttachment = { ref: ref('a-tab', 'tab', 'Example'), payload: { type: 'text', text: 'Page text', title: 'Example', sourceUrl: 'https://example.com/' } }
const selection: PreparedAttachment = {
  ref: ref('a-sel', 'selection', 'Quote', { source: { url: 'https://news.example/a', title: 'The article' } }),
  payload: { type: 'text', text: 'A quoted line', title: 'Quote', sourceUrl: 'https://news.example/a' },
}
const office: PreparedAttachment = { ref: ref('a-doc', 'office', 'Budget.xlsx'), payload: { type: 'office', path: '/x/budget.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }
const skill: PreparedAttachment = { ref: ref('a-skill', 'skill', 'brand-kit'), payload: { type: 'skill', skillId: 'brand-kit' } }

function fakeFiles(options: { fail?: boolean } = {}) {
  const uploads: string[] = []
  const deleted: string[] = []
  const files: FilesApi = {
    upload: async ({ file }) => {
      if (options.fail) throw new Error('network down')
      uploads.push(file.name)
      return { id: `file_${uploads.length}` }
    },
    download: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    delete: async (id) => {
      if (id === 'file_gone') throw new Error('not found')
      deleted.push(id)
    },
    retrieveMetadata: async () => ({ filename: 'x', mime_type: 'text/plain', size_bytes: 0 }),
  }
  return { files, uploads, deleted }
}

function blockContext(overrides: Partial<ApiBlockContext> = {}): ApiBlockContext & { remote: Array<[string, string]> } {
  const remote: Array<[string, string]> = []
  return {
    chatId: 'c1',
    documents: false,
    files: null,
    fingerprint: keyFingerprint('sk-ant-test-key'),
    cache: new RemoteFileCache(mkdtempSync(join(tmpdir(), 'atelier-remote-'))),
    onRemote: (id, fileId) => remote.push([id, fileId]),
    skill: (id) => (id === 'brand-kit' ? { name: 'brand-kit', instructions: 'Use the brand colours.' } : null),
    readFile: (path) => Buffer.from(`bytes of ${path}`),
    remote,
    ...overrides,
  }
}

describe('API-key content blocks', () => {
  it('uploads images and PDFs once per attachment and key, and refers to them by file id', async () => {
    const { files, uploads } = fakeFiles()
    const ctx = blockContext({ files })
    const first = await apiBlocks([image, pdf], ctx)
    expect(first).toEqual([
      { type: 'image', source: { type: 'file', file_id: 'file_1' } },
      { type: 'document', source: { type: 'file', file_id: 'file_2' }, title: 'Report.pdf' },
    ])
    expect(ctx.remote).toEqual([['a-img', 'file_1'], ['a-pdf', 'file_2']])
    // Sent again (a retry, the next turn): the cache answers.
    expect(await apiBlocks([image, pdf], ctx)).toEqual(first)
    expect(uploads).toEqual(['photo.png', 'Report.pdf'])
    // A different key uploads again, since files belong to the key's organization.
    await apiBlocks([image], { ...ctx, fingerprint: keyFingerprint('sk-ant-other') })
    expect(uploads).toHaveLength(3)
  })

  it('falls back to base64 when the upload fails or there is no key', async () => {
    const { files } = fakeFiles({ fail: true })
    const failing = await apiBlocks([image, pdf], blockContext({ files }))
    const data = (path: string) => Buffer.from(`bytes of ${path}`).toString('base64')
    expect(failing).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data('/x/photo.png') } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data('/x/report.pdf') }, title: 'Report.pdf' },
    ])
    expect(await apiBlocks([image], blockContext({ files: null, fingerprint: null }))).toEqual([failing[0]])
  })

  it('makes titled text documents with their source, and quotes selections with their link', async () => {
    const blocks = await apiBlocks([text, tab, selection], blockContext())
    expect(blocks[0]).toEqual({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Some notes' }, title: 'notes.txt' })
    expect(blocks[1]).toEqual({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Page text' }, title: 'Example', context: 'Source: https://example.com/' })
    expect(blocks[2]).toMatchObject({ type: 'document', title: 'Quote', context: expect.stringContaining('selected and quoted from “The article” (https://news.example/a)') })
  })

  it('expands skills like a typed /name, and notes a skill that is gone', async () => {
    const gone: PreparedAttachment = { ref: ref('a-x', 'skill', 'old-skill'), payload: { type: 'skill', skillId: 'old-skill' } }
    const blocks = await apiBlocks([skill, gone], blockContext())
    expect(blocks[0]).toEqual({ type: 'text', text: '<skill name="brand-kit">\nUse the brand colours.\n</skill>' })
    expect(blocks[1]).toMatchObject({ type: 'text', text: expect.stringContaining('no longer exists') })
  })

  it('sends office files only with documents, as container uploads', async () => {
    await expect(apiBlocks([office], blockContext())).rejects.toThrow(OFFICE_NEEDS_DOCUMENTS)
    const { files } = fakeFiles()
    const blocks = await apiBlocks([office], blockContext({ files, documents: true }))
    expect(blocks).toEqual([{ type: 'container_upload', file_id: 'file_1' }, { type: 'text', text: 'The user attached Budget.xlsx; it is in the code workspace.' }])
    await expect(apiBlocks([office], blockContext({ files: fakeFiles({ fail: true }).files, documents: true }))).rejects.toThrow(/couldn’t send Budget.xlsx/)
  })

  it('also puts uploaded images and PDFs in the code workspace when documents is on', async () => {
    const { files } = fakeFiles()
    const blocks = await apiBlocks([image], blockContext({ files, documents: true }))
    expect(blocks).toEqual([{ type: 'image', source: { type: 'file', file_id: 'file_1' } }, { type: 'container_upload', file_id: 'file_1' }])
  })
})

describe('the request cap and kept blocks', () => {
  it('refuses more than 32 MB with a readable error', () => {
    const big: BetaMessageParam = { role: 'user', content: 'x'.repeat(31_000_000) }
    expect(() => assertRequestSize([big])).not.toThrow()
    expect(() => assertRequestSize([big], [{ type: 'text', text: 'y'.repeat(2_000_000) }])).toThrow(REQUEST_TOO_LARGE)
  })

  it('keeps a sent message’s attachment blocks for edit and retry, without the context or the typed text', () => {
    const sent: BetaMessageParam = {
      role: 'user',
      content: [
        { type: 'text', text: '<browser_context>tabs</browser_context>' },
        { type: 'image', source: { type: 'file', file_id: 'file_1' } },
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'notes' }, title: 'notes.txt' },
        { type: 'text', text: 'What is in these?' },
      ],
    }
    expect(attachmentBlocksOf(sent)).toEqual([
      { type: 'image', source: { type: 'file', file_id: 'file_1' } },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'notes' }, title: 'notes.txt' },
    ])
    expect(attachmentBlocksOf({ role: 'assistant', content: 'hi' })).toEqual([])
    expect(attachmentBlocksOf(undefined)).toEqual([])
  })
})

describe('remote files', () => {
  it('keeps ids a duplicate still refers to when one chat is deleted, and survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-remote-'))
    const cache = new RemoteFileCache(dir)
    cache.set('c1', 'a1', 'fp', 'file_1')
    cache.set('c1', 'a2', 'fp', 'file_2')
    cache.copyChat('c1', 'c2')
    cache.set('c2', 'a3', 'fp', 'file_3')
    expect(cache.removeChat('c1', ['file_gen'])).toEqual(['file_gen'])
    const reloaded = new RemoteFileCache(dir)
    expect(reloaded.get('c2', 'a1', 'fp')).toBe('file_1')
    expect(reloaded.removeChat('c2').sort()).toEqual(['file_1', 'file_2', 'file_3'])
  })

  it('deletes best effort, counting what went', async () => {
    const { files, deleted } = fakeFiles()
    expect(await deleteRemoteFiles(files, ['file_1', 'file_gone', 'file_2'])).toBe(2)
    expect(deleted).toEqual(['file_1', 'file_2'])
    expect(await deleteRemoteFiles(null, ['file_1'])).toBe(0)
  })

  it('fingerprints keys without revealing them', () => {
    const fp = keyFingerprint('sk-ant-secret')
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(fp).not.toContain('secret')
    expect(keyFingerprint(null)).toBeNull()
  })
})

// ---- the request matrix ----

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5'] as const
// The API key, and an engine besides it (a build's own; its id doesn't matter here).
const ENGINES = ['api-key', 'another-engine' as EngineId] as const

const session = new SessionRichChat({} as SessionRichChatHost, () => undefined)

function capabilities(model: string, setup: { documents: boolean; compaction: boolean }): ChatCapabilities {
  return { model, browser: true, webTools: true, memory: true, connectorIds: ['notes'], engine: 'api-key', ...setup, containerId: null, localTools: [], toolPolicies: {}, cClientTools: ['save_artifact', 'suggest_connector', 'suggest_next_steps'] }
}

const connectors = [{ id: 'notes', name: 'Notes', url: 'https://mcp.notes.example/mcp', token: null }] as unknown as ResolvedConnector[]

function request(model: string, setup: { documents: boolean; compaction: boolean }, messages: BetaMessageParam[]) {
  const caps = capabilities(model, setup)
  const rich: RichRequest = { documents: setup.documents, containerId: null, compaction: setup.compaction, replyTools: caps.cClientTools ?? [], localTools: [], mcpDisabled: {} }
  return buildRequest({ capabilities: caps, system: 'You are Nova.', effort: 'medium', connectors, messages, rich })
}

describe('the request matrix', () => {
  it('fixes documents and compaction per engine, model and setting', () => {
    for (const engine of ENGINES) {
      for (const model of MODELS) {
        for (const documents of [false, true]) {
          const setup = session.draftSetup(engine, model, documents)
          // Files and documents works on every engine; compaction stays the API key's.
          expect(setup.documents).toBe(documents)
          expect(setup.compaction).toBe(engine === 'api-key' && model !== 'claude-haiku-4-5')
        }
      }
    }
  })

  it('builds each API-key request with the right tools, betas and container', async () => {
    const { files } = fakeFiles()
    for (const model of MODELS) {
      for (const documentsSetting of [false, true]) {
        const setup = session.draftSetup('api-key', model, documentsSetting)
        const attachments = documentsSetting ? [image, pdf, tab, office] : [image, pdf, tab]
        const blocks = await apiBlocks(attachments, blockContext({ files, documents: setup.documents }))
        const req = request(model, setup, [{ role: 'user', content: [...blocks, { type: 'text', text: 'Look at these.' }] }])
        const types = (req.tools ?? []).map((t) => ('type' in t && t.type ? t.type : 'custom'))
        const betas = req.betas ?? []
        const label = `${model} documents=${documentsSetting}`

        expect(types.includes('code_execution_20260521'), label).toBe(setup.documents)
        expect(betas.includes('code-execution-2025-08-25'), label).toBe(setup.documents)
        expect(Boolean(req.container), label).toBe(setup.documents)
        // The dynamic web tools never go out alongside code execution.
        if (setup.documents) expect(types.filter((t) => t.endsWith('_20260209')), label).toEqual([])
        expect(betas.includes('compact-2026-01-12'), label).toBe(setup.compaction)
        expect(Boolean(req.context_management), label).toBe(setup.compaction)
        // The extra client tools come last, sorted, with save_artifact streaming eagerly.
        const custom = (req.tools ?? []).filter((t) => !('type' in t) || t.type === undefined || t.type === 'custom') as Array<{ name: string; eager_input_streaming?: boolean }>
        expect(custom.map((t) => t.name), label).toEqual(['save_artifact', 'suggest_connector', 'suggest_next_steps'])
        // Attachments sit before the typed text.
        const content = req.messages[0]?.content as Array<{ type: string }>
        expect(content.at(-1), label).toEqual({ type: 'text', text: 'Look at these.' })
        expect(content.some((b) => b.type === 'container_upload'), label).toBe(setup.documents)
        // Haiku has no server-side fallback.
        expect(betas.includes('server-side-fallback-2026-07-01'), label).toBe(!model.startsWith('claude-haiku'))
      }
    }
  })
})
