/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import type { BetaContentBlock, BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent } from '@shared/chats'
import type { LibraryFileRef } from '@shared/files'
import type { AgentEvent } from '@shared/ipc'
import { RemoteFileCache, type FilesApi } from '../src/main/agent/content'
import {
  CODE_EXECUTION_BETA,
  CODE_EXECUTION_TOOL,
  CONTAINER_EXPIRED_NOTICE,
  containerParam,
  isContainerGone,
  producedFileIds,
  saveGeneratedFiles,
  withDocuments,
} from '../src/main/agent/documents'
import { AgentHost } from '../src/main/agent/host'
import { findInPdfText, isPdfTab, PdfTabReader, pdfPageText, type PdfTabLike } from '../src/main/agent/pdfTab'
import { applyRichRequest } from '../src/main/agent/richRequest'
import { SessionRichChat, type RichChatDeps, type SessionRichChatHost } from '../src/main/agent/sessionRichChat'
import { SMOKE_GENERATED, smokeRichChat } from '../src/main/agent/smokeClientRichChat'
import type { ChatContent } from '../src/main/chats'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import type { LibraryFiles } from '../src/main/files/types'
import { createSmokeClient } from '../src/main/smokeClient'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'
import type { EngineId } from '@shared/engine'

// Files and documents (code execution with the document
// skills, a reused container, generated files into Library › Files),
// mcp_toolset configs, and PDF tab reading. Offline fakes only.

const dynamicTools: BetaToolUnion[] = [
  { type: 'browser_toolset_20260801' } as BetaToolUnion,
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
  { type: 'memory_20250818', name: 'memory' },
  { type: 'mcp_toolset', mcp_server_name: 'notes' },
  { name: 'save_artifact', description: 'x', input_schema: { type: 'object' } },
]

describe('the documents request', () => {
  it('swaps in the basic web tools and adds code execution before connectors and client tools', () => {
    const tools = withDocuments(dynamicTools)
    expect(tools.map((t) => ('type' in t && t.type ? t.type : (t as { name: string }).name))).toEqual([
      'browser_toolset_20260801',
      'web_search_20250305',
      'web_fetch_20250910',
      'memory_20250818',
      'code_execution_20260521',
      'mcp_toolset',
      'save_artifact',
    ])
    expect(withDocuments([{ type: 'memory_20250818', name: 'memory' }]).at(-1)).toEqual(CODE_EXECUTION_TOOL)
  })

  it('names the four document skills at latest, and the chat’s container when it has one', () => {
    const skills = ['pptx', 'xlsx', 'docx', 'pdf'].map((skill_id) => ({ type: 'anthropic', skill_id, version: 'latest' }))
    expect(containerParam(null)).toEqual({ skills })
    expect(containerParam('container_9')).toEqual({ id: 'container_9', skills })
  })

  it('adds the beta, the container and the tool only with documents on', () => {
    const base = { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user' as const, content: 'hi' }], tools: dynamicTools, betas: ['mcp-client-2025-11-20'] }
    const c = { documents: true, containerId: 'container_1', compaction: false, replyTools: [], localTools: [], mcpDisabled: {} }
    const on = applyRichRequest(base, c)
    expect(on.betas).toEqual(['mcp-client-2025-11-20', CODE_EXECUTION_BETA])
    expect(on.container).toEqual(containerParam('container_1'))
    expect((on.tools ?? []).some((t) => 'type' in t && t.type === 'web_search_20260209')).toBe(false)
    const off = applyRichRequest(base, { ...c, documents: false })
    expect(off.container).toBeUndefined()
    expect(off.betas).toEqual(['mcp-client-2025-11-20'])
    expect((off.tools ?? []).some((t) => 'type' in t && t.type === 'code_execution_20260521')).toBe(false)
  })

  it('keeps remote tools that were off at the chat’s start off, sorted', () => {
    const base = { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user' as const, content: 'hi' }], tools: dynamicTools }
    const out = applyRichRequest(base, { documents: false, containerId: null, compaction: false, replyTools: [], localTools: [], mcpDisabled: { notes: ['delete_note', 'archive'] } })
    const toolset = (out.tools ?? []).find((t) => 'type' in t && t.type === 'mcp_toolset')
    expect(toolset).toEqual({ type: 'mcp_toolset', mcp_server_name: 'notes', configs: { archive: { enabled: false }, delete_note: { enabled: false } } })
    const none = applyRichRequest(base, { documents: false, containerId: null, compaction: false, replyTools: [], localTools: [], mcpDisabled: {} })
    expect((none.tools ?? []).find((t) => 'type' in t && t.type === 'mcp_toolset')).toEqual({ type: 'mcp_toolset', mcp_server_name: 'notes' })
  })
})

const output = (fileId: string) => ({ type: 'bash_code_execution_output', file_id: fileId })
const result = (files: string[]) => ({ type: 'bash_code_execution_tool_result', tool_use_id: 'srv_1', content: { type: 'bash_code_execution_result', stdout: '', stderr: '', return_code: 0, content: files.map(output) } })

function fakeLibrary() {
  const added: Array<{ name: string; mediaType: string; text: string }> = []
  const library = {
    addGenerated: (input: { chatId: string; companionId: string; name: string; mediaType: string; bytes: Buffer }) => {
      added.push({ name: input.name, mediaType: input.mediaType, text: input.bytes.toString('utf8') })
      return { id: `lib_${added.length}`, name: input.name, mediaType: input.mediaType, size: input.bytes.byteLength, kind: 'generated', chatId: input.chatId, companionId: input.companionId, createdAt: 1, state: 'ready', artifact: false } as LibraryFileRef
    },
  }
  return { library: library as unknown as LibraryFiles, added }
}

describe('generated files', () => {
  it('lists each file the code wrote once, in order', () => {
    const content = [result(['file_a', 'file_b']), { type: 'text', text: 'Done' }, result(['file_b', 'file_c']), { type: 'bash_code_execution_tool_result', tool_use_id: 'x', content: { type: 'bash_code_execution_tool_result_error', error_code: 'unavailable' } }]
    expect(producedFileIds(content as unknown as BetaContentBlock[])).toEqual(['file_a', 'file_b', 'file_c'])
  })

  it('downloads them into Library › Files, skipping one that fails', async () => {
    const files: FilesApi = {
      upload: async () => ({ id: 'x' }),
      delete: async () => undefined,
      retrieveMetadata: async (id) => {
        if (id === 'file_bad') throw new Error('gone')
        return { filename: `${id}.xlsx`, mime_type: 'application/vnd.ms-excel', size_bytes: 3 }
      },
      download: async (id) => ({ arrayBuffer: async () => new TextEncoder().encode(`data:${id}`).buffer as ArrayBuffer }),
    }
    const { library, added } = fakeLibrary()
    const seen: string[] = []
    const saved = await saveGeneratedFiles(['file_a', 'file_bad', 'file_b'], { files, library, chatId: 'c1', companionId: 'nova', onFile: (f) => seen.push(f.name) })
    expect(saved.map((f) => f.name)).toEqual(['file_a.xlsx', 'file_b.xlsx'])
    expect(added[0]).toEqual({ name: 'file_a.xlsx', mediaType: 'application/vnd.ms-excel', text: 'data:file_a' })
    expect(seen).toEqual(['file_a.xlsx', 'file_b.xlsx'])
  })
})

describe('an expired container', () => {
  it('is recognized from the API error', () => {
    expect(isContainerGone(new Anthropic.BadRequestError(400, undefined, 'container_9 has expired', new Headers()))).toBe(true)
    expect(isContainerGone(new Anthropic.NotFoundError(404, undefined, 'Container not found', new Headers()))).toBe(true)
    expect(isContainerGone(new Anthropic.BadRequestError(400, undefined, 'max_tokens is too large', new Headers()))).toBe(false)
    expect(isContainerGone(new Error('container expired'))).toBe(false)
  })

  it('is forgotten with a notice, and the stream ends for a retry', async () => {
    const events: AgentEvent[] = []
    const session = new SessionRichChat({ chatId: 'c1', emit: (e: AgentEvent) => events.push(e) } as unknown as SessionRichChatHost, () => undefined)
    const content = { capabilities: { documents: true, containerId: 'container_9', compaction: false }, messages: [] } as unknown as ChatContent
    async function* failing(): AsyncGenerator<never> {
      yield* []
      throw new Anthropic.BadRequestError(400, undefined, 'container_9 has expired', new Headers())
    }
    const seen: unknown[] = []
    for await (const event of session.watch(failing(), content)) seen.push(event)
    expect(seen).toEqual([])
    expect(content.capabilities.containerId).toBeNull()
    expect(events).toEqual([{ type: 'error', message: CONTAINER_EXPIRED_NOTICE }])
    expect(session.takeRetry()).toBe(true)
    expect(session.takeRetry()).toBe(false)
  })
})

// ---- a documents chat end to end ----

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('Timed out')
}

function setup(settings: { documents: boolean; engine?: EngineId }) {
  const dir = mkdtempSync(join(tmpdir(), 'apex-docs-'))
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const events: ChatAgentEvent[] = []
  const smoke = createSmokeClient()
  const { library, added } = fakeLibrary()
  const tabs = { find: () => undefined, active: () => null, activeId: () => null, rail: () => null, activate: () => undefined, all: () => [], info: () => ({ title: '', url: '' }), setAgentControlled: () => undefined, setNeedsInput: () => undefined } as unknown as TabManager
  const host = new AgentHost({
    settings: { get: () => ({ model: 'claude-opus-5-5', effort: 'medium', webTools: true, memory: false, confirmConsequentialActions: true, ...settings }), view: () => ({ hasApiKey: true }), apiKey: () => 'test-key' },
    tabs,
    bridge: {} as never,
    memory: { execute: async () => 'ok' },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions: new CompanionStore(dir, { presets: () => presets }),
    presets: { personality: () => undefined },
    client: smoke.client,
    emit: (event) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const unavailable = (): never => {
    throw new Error('not in this test')
  }
  const deps: RichChatDeps = {
    attachments: unavailable,
    chatContext: unavailable,
    libraryFiles: () => library,
    connectors: unavailable,
    remoteFiles: new RemoteFileCache(dir),
    pdf: new PdfTabReader(async () => ({ pages: 0, text: '' })),
    directory: () => null,
    builtinSkill: () => undefined,
  }
  host.useRichChat(deps)
  const eventsOf = (id: string): AgentEvent[] => events.filter((e) => e.chatId === id).map((e) => e.event)
  return { host, chats, added, eventsOf, idle: (id: string) => until(() => !host.isRunning(id)) }
}

describe('a documents chat', () => {
  it('runs code with the skills, keeps its container and saves what the code wrote', async () => {
    smokeRichChat.reset()
    const t = setup({ documents: true })
    const id = t.host.start('smoke:document make a table')
    await t.idle(id)
    const first = smokeRichChat.lastRequest
    expect(first?.betas).toContain(CODE_EXECUTION_BETA)
    expect(first?.container).toEqual(containerParam(null))
    expect(first?.tools?.map((tool) => tool.type ?? tool.name)).toEqual(expect.arrayContaining(['web_search_20250305', 'web_fetch_20250910', 'code_execution_20260521']))
    expect(first?.tools?.some((tool) => tool.type?.endsWith('_20260209'))).toBe(false)

    expect(t.added).toEqual([{ name: SMOKE_GENERATED.name, mediaType: SMOKE_GENERATED.mediaType, text: SMOKE_GENERATED.text }])
    expect(t.eventsOf(id).find((e) => e.type === 'file-produced')).toMatchObject({ file: { name: SMOKE_GENERATED.name } })
    expect(t.chats.load(id).capabilities.containerId).toBe('container_smoke_1')

    t.host.send(id, 'thanks')
    await t.idle(id)
    expect(smokeRichChat.lastRequest?.container).toEqual(containerParam('container_smoke_1'))
  })

  it('stays off by default, and follows the setting on another engine', async () => {
    smokeRichChat.reset()
    const t = setup({ documents: false })
    const id = t.host.start('smoke:document make a table')
    await t.idle(id)
    expect(smokeRichChat.lastRequest?.container).toBeUndefined()
    expect(smokeRichChat.lastRequest?.betas ?? []).not.toContain(CODE_EXECUTION_BETA)
    expect(t.chats.load(id).capabilities.documents).toBe(false)
    const other = 'another-engine' as EngineId
    expect(new SessionRichChat({} as SessionRichChatHost, () => undefined).draftSetup(other, 'claude-opus-5-5', true).documents).toBe(true)
    expect(new SessionRichChat({} as SessionRichChatHost, () => undefined).draftSetup(other, 'claude-opus-5-5', false).documents).toBe(false)
  })
})

// ---- PDF tabs ----

function pdfTab(url: string, options: { status?: number; bytes?: number; contentType?: string } = {}) {
  const fetches: string[] = []
  const tab: PdfTabLike = {
    view: {
      webContents: {
        getURL: () => url,
        executeJavaScript: async () => options.contentType ?? 'text/html',
        session: {
          fetch: async (target: string) => {
            fetches.push(target)
            return new Response(new Uint8Array(options.bytes ?? 4), { status: options.status ?? 200, headers: { 'content-length': String(options.bytes ?? 4) } })
          },
        },
      },
    },
  }
  return { tab, fetches }
}

describe('reading a PDF tab', () => {
  const text = '--- Page 1 ---\nQuarterly revenue grew.\n--- Page 2 ---\nCosts fell by 4%.\nRevenue outlook is steady.'

  it('knows a PDF tab by its URL or its document type', async () => {
    expect(await isPdfTab(pdfTab('https://example.com/report.PDF').tab)).toBe(true)
    expect(await isPdfTab(pdfTab('https://example.com/view?id=1', { contentType: 'application/pdf' }).tab)).toBe(true)
    expect(await isPdfTab(pdfTab('https://example.com/page').tab)).toBe(false)
    expect(await isPdfTab(pdfTab('apex://settings/report.pdf').tab)).toBe(false)
  })

  it('fetches the bytes through the tab’s session once, and reads them as text', async () => {
    const { tab, fetches } = pdfTab('https://example.com/report.pdf')
    const extracts: number[] = []
    const reader = new PdfTabReader(async (bytes, maxPages) => {
      extracts.push(bytes.byteLength)
      expect(maxPages).toBeGreaterThan(0)
      return { pages: 2, text }
    })
    expect(await reader.pageText(tab)).toMatch(/^This tab shows a PDF \(2 pages\)/)
    expect(await reader.find(tab, 'revenue')).toBe('This tab shows a PDF; matches by text (no element references):\nPage 1: Quarterly revenue grew.\nPage 2: Revenue outlook is steady.')
    expect(fetches).toEqual(['https://example.com/report.pdf'])
    expect(extracts).toEqual([4])
  })

  it('says why it can’t read one', async () => {
    const reader = new PdfTabReader(async () => ({ pages: 1, text: '' }))
    await expect(reader.text(pdfTab('https://example.com/a.pdf', { status: 404 }).tab)).rejects.toThrow('The PDF could not be loaded (404).')
    await expect(reader.text(pdfTab('https://example.com/b.pdf', { bytes: 33_000_000 }).tab)).rejects.toThrow(/larger than 32 MB/)
    expect(pdfPageText(1, '  ')).toMatch(/No text could be read/)
    expect(findInPdfText(text, 'x')).toBe('Give a few words to look for.')
    expect(findInPdfText(text, 'dividends')).toBe('No text in this PDF matches “dividends”.')
  })
})
