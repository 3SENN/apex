/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '../src/shared/branding'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { AttachmentRef } from '@shared/attachments'
import type { ChatAgentEvent } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import { RemoteFileCache } from '../src/main/agent/content'
import { configureDocumentsWorkspace, documentsWorkspace } from '../src/engines/claude-code/main/documentsWorkspace'
import { AgentHost } from '../src/main/agent/host'
import { PdfTabReader } from '../src/main/agent/pdfTab'
import type { RichChatDeps } from '../src/main/agent/sessionRichChat'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import { claudeCodeEngines, type TestEngines } from './helpers/engines'
import { type EngineSettings } from '../src/main/engines/service'
import { StreamJsonReader, userLine } from '../src/engines/claude-code/main/streamJson'
import type { AttachmentStore, PreparedAttachment } from '../src/main/intake/types'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'
import { installScript, programPath } from './helpers/fakeProgram'

// The Claude Code adapter's attachment handling, against a fake `claude` that
// speaks stream-json: attachments as base64 images and extracted text,
// office files as text read on this computer, copies in the chat's
// documents folder with Files and documents on, and compact_boundary as a compaction card. The real
// CLI never runs; nothing leaves the machine.

const root = mkdtempSync(join(tmpdir(), 'atelier-cc-attach-'))
const fake = programPath(join(root, 'bin'), 'claude')

// Replies with the block types it was sent; "compact" condenses first.
const FAKE = `#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
const args = process.argv.slice(2)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (args[0] === '--version') { process.stdout.write('9.9.9 (Claude Code)\\n'); process.exit(0) }
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }); process.exit(0) }
if (args[0] === 'mcp') process.exit(0)
const session_id = randomUUID()
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } }); return }
  if (message.type !== 'user') return
  const blocks = message.message.content
  out({ type: 'system', subtype: 'init', session_id, model: 'claude-test', tools: [], mcp_servers: [] })
  const typed = blocks.at(-1).text
  if (typed.includes('compact')) {
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id })
    out({ type: 'system', subtype: 'compact_boundary', session_id, compact_metadata: { trigger: 'auto', pre_tokens: 181000 } })
  }
  const summary = blocks.map((b) => b.type === 'image' ? 'image:' + b.source.type + ':' + b.source.media_type : b.type === 'text' && b.text.startsWith('<document') ? 'doc:' + /title="([^"]*)"/.exec(b.text)[1] : b.type === 'text' && b.text.startsWith('<') ? 'tag:' + /^<([a-z_]+)/.exec(b.text)[1] : b.type).join(',')
  const id = 'msg_' + randomUUID().slice(0, 8)
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, model: 'claude-test', usage: { input_tokens: 5, output_tokens: 1 } } }, session_id, parent_tool_use_id: null })
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: summary } }, session_id, parent_tool_use_id: null })
  out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, session_id, parent_tool_use_id: null })
  out({ type: 'stream_event', event: { type: 'message_stop' }, session_id, parent_tool_use_id: null })
  out({ type: 'result', subtype: 'success', is_error: false, result: summary, session_id, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 3 } })
})
rl.on('close', () => process.exit(0))
`

mkdirSync(join(root, 'bin'), { recursive: true })
writeFileSync(join(root, 'fake-claude.mjs'), FAKE)
installScript(join(root, 'fake-claude.mjs'), join(root, 'bin'), 'claude')
const imagePath = join(root, 'photo.png')
writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
const workbookPath = join(root, 'budget.xlsx')
writeFileSync(workbookPath, zipSync({
  'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Q3" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>'),
}))

const services: TestEngines[] = []
afterAll(async () => {
  await Promise.all(services.map((s) => s.dispose()))
})

const ref = (id: string, kind: AttachmentRef['kind'], name: string): AttachmentRef => ({ id, kind, name, state: 'ready', error: null, size: 7, mediaType: 'image/png', thumbnail: null })
const PREPARED: Record<string, PreparedAttachment> = {
  img: { ref: ref('img', 'image', 'photo.png'), payload: { type: 'image', mediaType: 'image/png', path: imagePath } },
  pdf: { ref: ref('pdf', 'pdf', 'Report.pdf'), payload: { type: 'pdf', path: '/nowhere.pdf', pages: 2, text: 'PDF words' } },
  tab: { ref: ref('tab', 'tab', 'Example'), payload: { type: 'text', text: 'Page words', title: 'Example', sourceUrl: 'https://example.com/' } },
  xls: { ref: ref('xls', 'office', 'Budget.xlsx'), payload: { type: 'office', path: '/nowhere.xlsx', mediaType: 'application/vnd.ms-excel' } },
  xlsx: { ref: ref('xlsx', 'office', 'Budget.xlsx'), payload: { type: 'office', path: workbookPath, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } },
}

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

function setup(options: { documents?: boolean } = {}) {
  const dir = mkdtempSync(join(root, 'data-'))
  configureDocumentsWorkspace(dir)
  const settings: EngineSettings = { engine: 'claude-code', claudeCodePath: fake, externalAccess: false, externalTabs: 'own' }
  const engines = claudeCodeEngines({
    dataDir: dir,
    home: dir,
    env: { ...process.env },
    // The fake really runs, so the engine works the way it does on this platform.
    platform: process.platform,
    resourcesPath: null,
    settings: () => settings,
    apiKeyState: () => 'missing',
    folder: (id) => join(dir, 'companion-files', id),
    openPath: async () => '',
    outside: { box: { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() }, executor: { tabs: {} as TabManager, bridge: {} as never }, approve: async () => false, claim: () => undefined, release: () => undefined },
    shell: async () => null,
    isExecutable: (path) => path === fake,
    available: true,
  })
  services.push(engines)
  const events: ChatAgentEvent[] = []
  const bound: string[][] = []
  const tabs = { find: () => undefined, active: () => null, activeId: () => null, rail: () => null, activate: () => undefined, all: () => [], info: () => ({ title: '', url: '' }), contentBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), setAgentControlled: () => undefined, setNeedsInput: () => undefined } as unknown as TabManager
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const host = new AgentHost({
    settings: { get: () => ({ model: 'claude-opus-5-5', effort: 'medium', webTools: false, memory: false, confirmConsequentialActions: true, engine: 'claude-code', documents: options.documents === true }), view: () => ({ hasApiKey: false }), apiKey: () => null },
    tabs,
    bridge: {} as never,
    memory: { execute: async () => 'ok' },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions: new CompanionStore(dir, { presets: () => presets }),
    presets: { personality: () => undefined },
    client: () => {
      throw new Error('The API-key engine must not run in these tests.')
    },
    backends: { 'claude-code': engines.backend },
    emit: (event) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const store = {
    resolve: (_chatId: string, ids: readonly string[]) => ids.map((id) => PREPARED[id] as PreparedAttachment),
    bindToMessage: (_chatId: string, ids: readonly string[]) => bound.push([...ids]),
  } as unknown as AttachmentStore
  const unavailable = (): never => {
    throw new Error('not in this test')
  }
  const deps: RichChatDeps = {
    attachments: () => store,
    chatContext: unavailable,
    libraryFiles: unavailable,
    connectors: unavailable,
    remoteFiles: new RemoteFileCache(dir),
    pdf: new PdfTabReader(async () => ({ pages: 0, text: '' })),
    directory: () => null,
    builtinSkill: () => undefined,
  }
  host.useRichChat(deps)
  const eventsOf = (id: string): AgentEvent[] => events.filter((e) => e.chatId === id).map((e) => e.event)
  const reply = (id: string): string => eventsOf(id).flatMap((e) => (e.type === 'text-delta' ? [e.text] : [])).join('')
  const idle = (id: string) => until(() => !host.isRunning(id) && eventsOf(id).some((e) => e.type === 'status'))
  return { host, chats, eventsOf, reply, idle, bound }
}

async function until(condition: () => boolean, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('Timed out')
}

describe('the stream-json wire format', () => {
  it('writes attachment blocks into one user line, and reads compact_boundary as a condensing that ended', () => {
    const line = userLine([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'hi' }])
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'hi' }] } })
    const reader = new StreamJsonReader()
    expect(reader.read(JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }))).toEqual([{ kind: 'compacting', active: true }])
    expect(reader.read(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 9000 } }))).toEqual([{ kind: 'compacting', active: false, boundary: { trigger: 'manual', preTokens: 9000 } }])
    expect(reader.read(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))).toEqual([{ kind: 'compacting', active: false, boundary: { trigger: 'auto', preTokens: null } }])
  })
})

describe('Claude Code chats with attachments', () => {
  it('sends images as base64 and PDFs and pages as text, before the typed text', async () => {
    const t = setup()
    const id = t.host.start('what are these?', {}, [{ kind: 'ref', id: 'img' }, { kind: 'ref', id: 'pdf' }, { kind: 'ref', id: 'tab' }])
    await t.idle(id)
    expect(t.reply(id)).toBe('tag:browser_context,image:base64:image/png,doc:Report.pdf,doc:Example,text')
    expect(t.bound).toEqual([['img', 'pdf', 'tab']])
    // The log keeps the refs with the message.
    const sent = t.eventsOf(id).find((e) => e.type === 'user-message')
    expect((sent as { attachments?: AttachmentRef[] } | undefined)?.attachments?.map((a) => a.id)).toEqual(['img', 'pdf', 'tab'])
    // With the setting off, the chat has no documents folder.
    expect(t.chats.load(id).capabilities.documents).toBe(false)
  })

  it('reads office files as text on this computer, and gives a plain reason when it can’t', async () => {
    const t = setup()
    const id = t.host.start('read this', {}, [{ kind: 'ref', id: 'xlsx' }])
    await t.idle(id)
    expect(t.reply(id)).toMatch(/doc:Budget\.xlsx,text$/)
    const bad = t.host.start('read this', {}, [{ kind: 'ref', id: 'xls' }])
    await until(() => !t.host.isRunning(bad) && t.eventsOf(bad).some((e) => e.type === 'error'))
    expect(t.eventsOf(bad).find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining(`${BRAND_NAME} couldn’t read the text of Budget.xlsx`) })
  })

  it('with Files and documents on, copies attachments into the chat’s own folder', async () => {
    const t = setup({ documents: true })
    const id = t.host.start('make a summary deck', {}, [{ kind: 'ref', id: 'img' }, { kind: 'ref', id: 'pdf' }, { kind: 'ref', id: 'xlsx' }])
    await t.idle(id)
    expect(t.chats.load(id).capabilities.documents).toBe(true)
    // The image's copy note follows it; the PDF's copy failed (no such file) and the message still went; the workbook names its copy.
    expect(t.reply(id)).toMatch(/image:base64:image\/png,text,doc:Report\.pdf,doc:Budget\.xlsx,text$/)
    const folder = documentsWorkspace(id)
    expect(readFileSync(join(folder, 'inputs', 'photo.png'))).toEqual(readFileSync(imagePath))
    expect(existsSync(join(folder, 'inputs', 'Budget.xlsx'))).toBe(true)
    expect(existsSync(join(folder, 'inputs', 'Report.pdf'))).toBe(false)
  })

  it('shows Claude Code’s own condensing as a compaction card', async () => {
    const t = setup()
    const id = t.host.start('please compact')
    await t.idle(id)
    const cards = t.eventsOf(id).filter((e): e is Extract<AgentEvent, { type: 'compaction' }> => e.type === 'compaction')
    expect(cards.map((c) => c.state)).toEqual(['running', 'done'])
    expect(cards[1]).toMatchObject({ trigger: 'auto', replacedTokens: 181000 })
    expect(cards[0]?.id).toBe(cards[1]?.id)
  })
})
