/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '@shared/attachments'
import type { ChatAgentEvent } from '@shared/chats'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import { ENGINES, type EngineId, type EngineStatus } from '@shared/engine'
import type { AgentEvent } from '@shared/ipc'
import { tidyEngineReady } from '../src/main/activity/feature'
import { RemoteFileCache, apiBlocksFor } from '../src/main/agent/content'
import { claudeCodeBlocks } from '../src/engines/claude-code/main/blocks'
import { CODE_EXECUTION_TOOL } from '../src/main/agent/documents'
import { OUTPUTS_FOLDER, changedOutputs, configureDocumentsWorkspace, documentsWorkspace, snapshotOutputs } from '../src/engines/claude-code/main/documentsWorkspace'
import { AgentHost } from '../src/main/agent/host'
import { createQuickModel, type QuickModel } from '../src/main/agent/quick'
import { claudeQuickEngine } from '../src/engines/claude-code/main/quick'
import { applyRichRequest, type RichRequest } from '../src/main/agent/richRequest'
import { buildRequest, buildTools } from '../src/main/agent/session'
import { smokeRichChat } from '../src/main/agent/smokeClientRichChat'
import { ChatStore, type ChatCapabilities } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import { MAX_STEPS, type AgentBackend, type BackendResult, type BackendTurn } from '../src/main/engines/backend'
import { ClaudeCodeBackend } from '../src/engines/claude-code/main/claudeCode'
import { launchPolicy, type LaunchPolicyInput } from '../src/engines/claude-code/main/launchPolicy'
import { StreamJsonReader, commandLine, pdfBlock, userLine } from '../src/engines/claude-code/main/streamJson'
import { curatedStarters, generateStarters } from '../src/main/firstWeekStarters'
import type { PreparedAttachment } from '../src/main/intake/types'
import { MemoryJobs } from '../src/main/memoryJobs'
import { createSmokeClient, registerScenario } from '../src/main/smokeClient'
import { ConnectorStore, SkillStore, type ResolvedConnector } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'

// Every model feature has a working path on both engines: the person's
// API key and their own Claude Code sign-in. Everything here is offline: the
// API key runs against the smoke stand-in or a scripted client, Claude Code
// against a fake backend (the AgentBackend seam) and the pure launch policy.
// No real `claude -p`, no network, no Anthropic API call.

const FEATURES = [
  'chat turn',
  'web search',
  'web fetch',
  'connectors (incl. tools switched off)',
  'images',
  'PDFs',
  'office files',
  'Files and documents',
  'compaction (automatic)',
  'compaction (Compact now)',
  'step cap and Continue',
  'private chat',
  'quick calls',
  'first-week starters',
  'memory build',
  'routines',
] as const
type Feature = (typeof FEATURES)[number]
type Check = () => void | Promise<void>

const root = mkdtempSync(join(tmpdir(), 'atelier-parity-'))
configureDocumentsWorkspace(join(root, 'data'))

// ---- shared fakes ----

const caps = (over: Partial<ChatCapabilities> = {}): ChatCapabilities => ({ model: 'claude-opus-5-5', effort: 'medium', browser: false, webTools: false, memory: false, connectorIds: [], ...over })
const policy = (over: Partial<ChatCapabilities> = {}, extra: Partial<LaunchPolicyInput> = {}) =>
  launchPolicy({ caps: caps({ engine: 'claude-code', ...over }), system: 'Atelier system.', mcpConfigPath: join(root, 'mcp.json'), atelierTools: [], connectors: [], session: null, companionFolder: join(root, 'companion'), ...extra })
const flag = (args: readonly string[], name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const list = (args: readonly string[], name: string): string[] => (flag(args, name) ?? '').split(',').filter(Boolean)
const request = (over: Partial<ChatCapabilities> = {}, connectors: ResolvedConnector[] = [], c?: RichRequest) =>
  buildRequest({ capabilities: caps(over), system: 'Atelier system.', effort: 'medium', connectors, messages: [{ role: 'user', content: 'hi' }], ...(c ? { c } : {}) })
const noC: RichRequest = { documents: false, containerId: null, compaction: false, replyTools: [], localTools: [], mcpDisabled: {} }
const toolNames = (tools: readonly object[]): string[] => tools.map((t) => (t as { name?: string; type: string }).name ?? (t as { type: string }).type)

const ref = (id: string, kind: AttachmentRef['kind'], name: string, mediaType: string): AttachmentRef => ({ id, kind, name, state: 'ready', error: null, size: 7, mediaType, thumbnail: null })
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const imagePath = join(root, 'photo.png')
writeFileSync(imagePath, PNG)
const pdfPath = join(root, 'Report.pdf')
writeFileSync(pdfPath, Buffer.from('%PDF-1.7 parity'))
const docxPath = join(root, 'Notes.docx')
writeFileSync(
  docxPath,
  zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Parity words</w:t></w:r></w:p></w:body></w:document>'),
  }),
)
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const image: PreparedAttachment = { ref: ref('img', 'image', 'photo.png', 'image/png'), payload: { type: 'image', mediaType: 'image/png', path: imagePath } }
const pdf: PreparedAttachment = { ref: ref('pdf', 'pdf', 'Report.pdf', 'application/pdf'), payload: { type: 'pdf', path: pdfPath, pages: 2, text: 'PDF words' } }
const office: PreparedAttachment = { ref: ref('doc', 'office', 'Notes.docx', DOCX), payload: { type: 'office', path: docxPath, mediaType: DOCX } }
const apiCtx = (documents: boolean) => ({ chatId: 'parity', documents, files: null, fingerprint: null, cache: new RemoteFileCache(mkdtempSync(join(tmpdir(), 'atelier-remote-'))), skill: () => null })
const ccCtx = { skill: () => null }

const calendar: ResolvedConnector = { id: 'conn-cal', name: 'Calendar', url: 'https://mcp.calendar.example/mcp', token: null }

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

/** A Claude Code stand-in at the AgentBackend seam: records each turn and answers from `reply`. */
function fakeBackend(reply: (turn: BackendTurn, n: number) => BackendResult = () => ({ text: 'Done on Claude Code.', paused: false, error: null })) {
  const turns: BackendTurn[] = []
  const compactions: BackendTurn[] = []
  const backend: AgentBackend = {
    engine: 'claude-code',
    run: async (turn) => {
      turns.push(turn)
      return reply(turn, turns.length)
    },
    reset: () => undefined,
    discard: () => undefined,
    compact: async (turn) => {
      compactions.push(turn)
      turn.emit({ type: 'compaction', id: 'cc-compact', state: 'done', trigger: 'manual', summary: 'Condensed by Claude Code.' } as unknown as AgentEvent)
      return { text: '', paused: false, error: null }
    },
  }
  return { backend, turns, compactions }
}

/** An AgentHost on one engine: the smoke stand-in for the key, the fake backend for Claude Code. */
function harness(engine: EngineId, reply?: Parameters<typeof fakeBackend>[0]) {
  const dir = mkdtempSync(join(root, `host-${engine}-`))
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const events: ChatAgentEvent[] = []
  const smoke = createSmokeClient()
  const cc = fakeBackend(reply)
  const tabs = { find: () => undefined, active: () => null, activeId: () => null, rail: () => null, activate: () => undefined, all: () => [], info: () => ({ title: '', url: '' }), contentBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), setAgentControlled: () => undefined, setNeedsInput: () => undefined } as unknown as TabManager
  const host = new AgentHost({
    settings: { get: () => ({ model: 'claude-opus-5-5', effort: 'medium', webTools: false, memory: true, confirmConsequentialActions: true, engine, documents: false }), view: () => ({ hasApiKey: engine === 'api-key' }), apiKey: () => (engine === 'api-key' ? 'sk-test' : null) },
    tabs,
    bridge: {} as never,
    memory: { execute: async () => 'ok' },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions: new CompanionStore(dir, { presets: () => presets }),
    presets: { personality: () => undefined },
    client:
      engine === 'api-key'
        ? smoke.client
        : () => {
            throw new Error('A Claude Code chat must not reach the API key.')
          },
    backends: { 'claude-code': cc.backend },
    emit: (event) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const eventsOf = (id: string): AgentEvent[] => events.filter((e) => e.chatId === id).map((e) => e.event)
  const idle = (id: string) => until(() => !host.isRunning(id))
  return { host, chats, cc, eventsOf, idle }
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('Timed out')
}

/** Which engine answered: the smoke stand-in saw a request, or the fake backend a turn. */
function answeredOn(engine: EngineId, t: ReturnType<typeof harness>): void {
  if (engine === 'api-key') {
    expect(smokeRichChat.lastRequest).not.toBeNull()
    expect(t.cc.turns).toHaveLength(0)
  } else {
    expect(t.cc.turns.length).toBeGreaterThan(0)
    expect(t.cc.turns[0]?.capabilities.engine).toBe('claude-code')
  }
}

const chatTurn = (engine: EngineId): Check => async () => {
  smokeRichChat.reset()
  const t = harness(engine)
  const id = t.host.start('Hello there')
  await t.idle(id)
  answeredOn(engine, t)
  expect(t.chats.summary(id)?.status).toBe('finished')
  expect(t.eventsOf(id).some((e) => e.type === 'error')).toBe(false)
}

const stepCap = (engine: EngineId): Check => async () => {
  smokeRichChat.reset()
  // The key: a scripted reply that keeps calling memory past the cap. Claude Code: the bridge's stepLimit result.
  const trigger = `parity long task ${engine}`
  registerScenario(new RegExp(`^${trigger}`), [...Array.from({ length: MAX_STEPS + 1 }, () => ({ kind: 'tool' as const, name: 'memory', input: { command: 'view', path: '/memories' } })), { kind: 'text', text: 'All done.' }])
  const t = harness(engine, (_turn, n) => (n === 1 ? { text: '', paused: true, error: null, stepLimit: true, steps: MAX_STEPS } : { text: 'All done.', paused: false, error: null }))
  const id = t.host.start(trigger)
  await until(() => t.eventsOf(id).some((e) => e.type === 'step-limit') && !t.host.isRunning(id))
  expect(t.eventsOf(id).find((e) => e.type === 'step-limit')).toMatchObject({ steps: MAX_STEPS })
  expect(t.eventsOf(id).some((e) => e.type === 'error')).toBe(false)
  expect(t.chats.summary(id)?.needsInput).toBe(true)
  t.host.continue(id)
  await until(() => !t.host.isRunning(id) && t.chats.summary(id)?.needsInput !== true)
  if (engine === 'claude-code') expect(t.cc.turns).toHaveLength(2)
  expect(t.eventsOf(id).filter((e) => e.type === 'step-limit')).toHaveLength(1)
}

const compactNow = (engine: EngineId): Check => async () => {
  smokeRichChat.reset()
  const t = harness(engine)
  const id = t.host.start('first question')
  await t.idle(id)
  t.host.send(id, 'second question')
  await t.idle(id)
  expect(() => t.host.compact(id)).not.toThrow()
  await until(() => t.eventsOf(id).some((e) => e.type === 'compaction' && (e as { state?: string }).state !== 'running'))
  await t.idle(id)
  if (engine === 'api-key') expect(smokeRichChat.lastRequest?.compaction).toMatchObject({ type: 'summarize' })
  else {
    expect(t.cc.compactions).toHaveLength(1)
    // On Claude Code, Compact now is `/compact` on the chat's stdin.
    expect(JSON.parse(commandLine('/compact'))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } })
  }
  expect(t.eventsOf(id).some((e) => e.type === 'error')).toBe(false)
}

const privateChat = (engine: EngineId): Check => async () => {
  smokeRichChat.reset()
  const t = harness(engine)
  const id = t.host.start('A private question', { private: true })
  await t.idle(id)
  answeredOn(engine, t)
  expect(t.eventsOf(id).some((e) => e.type === 'error')).toBe(false)
  // Atelier itself keeps no copy of a private chat either.
  expect(t.chats.summary(id)).toBeUndefined()
  if (engine === 'claude-code') {
    expect(t.cc.turns[0]?.capabilities.private).toBe(true)
    // Claude Code keeps no copy of it under ~/.claude/projects, and never resumes one.
    const plan = policy({ private: true }, { session: { id: 'old-session' } as never })
    expect(plan.persist).toBe(false)
    expect(plan.args).toContain('--no-session-persistence')
    expect(plan.args).not.toContain('--resume')
  } else {
    expect(request({ private: true }).model).toBe('claude-opus-5-5')
  }
}

const routines = (engine: EngineId): Check => async () => {
  smokeRichChat.reset()
  const t = harness(engine)
  const run = await t.host.runBackground({ companionId: 'nova', prompt: 'Brief me on the news', kind: 'routine', title: 'Morning brief' })
  expect(run.ok).toBe(true)
  answeredOn(engine, t)
}

const memoryBuild = (engine: EngineId): Check => async () => {
  smokeRichChat.reset()
  const t = harness(engine)
  const first = t.host.start('I live in Ghent and I am vegetarian')
  await t.idle(first)
  const turnsBefore = t.cc.turns.length
  smokeRichChat.reset()
  const jobs = new MemoryJobs({
    file: join(mkdtempSync(join(root, 'jobs-')), 'memory-jobs.json'),
    chats: t.chats,
    memory: { list: () => [], read: () => '' },
    host: t.host,
    activeCompanion: () => t.chats.summary(first)?.companionId ?? FIRST_COMPANION_ID,
    companionName: () => 'Nova',
    engine: () => ({ engine, model: 'claude-opus-5-5' }),
    snapshot: () => undefined,
    broadcast: () => undefined,
    ownChats: new Set(),
  })
  const owner = t.chats.summary(first)?.companionId ?? FIRST_COMPANION_ID
  const estimate = jobs.estimateBuild(owner)
  expect(estimate.chats).toBe(1)
  // A dollar estimate only with the key; Claude Code runs on the person's own account.
  if (engine === 'api-key') expect(estimate.approxCostUsd).toEqual(expect.any(Number))
  else expect(estimate.approxCostUsd).toBeNull()
  const job = jobs.startJob('build', owner)
  await until(() => jobs.jobs().find((j) => j.id === job.id)?.state !== 'running')
  expect(jobs.jobs().find((j) => j.id === job.id)?.state).toBe('done')
  if (engine === 'api-key') expect(smokeRichChat.lastRequest).not.toBeNull()
  else expect(t.cc.turns.length).toBeGreaterThan(turnsBefore)
  // Tidy memory's readiness check follows the real engine status, not the setting alone.
  const ready = (state: EngineStatus['claudeCode']['state'], key: EngineStatus['apiKey']['state']) =>
    tidyEngineReady({
      settings: { get: () => ({ engine }), view: () => ({ hasApiKey: key !== 'missing' }) } as never,
      engineStatus: () => ({ engine, claudeCodeAvailable: true, apiKey: { state: key }, claudeCode: { state }, others: [{ id: 'claude-code', ready: state === 'ready' || state === 'unknown', checking: false, detail: '', badge: '', tone: 'success' }] } as unknown as EngineStatus),
    })
  expect(ready('ready', 'saved')).toBe(true)
  expect(ready('signed-out', 'missing')).toBe(false)
}

/** QuickModel on one engine: a scripted client with the key, a fake one-shot CLI for Claude Code. */
function quickOn(engine: EngineId, reply: string): { quick: QuickModel; seen: { params: unknown[]; args: Array<readonly string[]> } } {
  const seen = { params: [] as unknown[], args: [] as Array<readonly string[]> }
  const quick = createQuickModel({
    engine: () => engine,
    apiKey: () => (engine === 'api-key' ? 'sk-test' : null),
    client: () => ({
      messages: {
        create: async (params) => {
          seen.params.push(params)
          return { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }
        },
      },
    }),
    others:
      engine === 'claude-code'
        ? {
            'claude-code': claudeQuickEngine({
              ready: async () => ({ ok: true }),
              run: async (args) => {
                seen.args.push(args)
                return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: reply }), stderr: '' }
              },
            }),
          }
        : {},
  })
  return { quick, seen }
}

const PARITY: Record<Feature, Record<EngineId, Check>> = {
  'chat turn': { 'api-key': chatTurn('api-key'), 'claude-code': chatTurn('claude-code') },

  'web search': {
    'api-key': () => expect(toolNames(buildTools(caps({ webTools: true }), []))).toContain('web_search'),
    'claude-code': () => {
      const args = policy({ webTools: true }).args
      expect(list(args, '--tools')).toContain('WebSearch')
      expect(list(args, '--allowedTools')).toContain('WebSearch')
    },
  },

  'web fetch': {
    'api-key': () => expect(toolNames(buildTools(caps({ webTools: true }), []))).toContain('web_fetch'),
    'claude-code': () => {
      const on = policy({ webTools: true }).args
      expect(list(on, '--tools')).toContain('WebFetch')
      expect(list(on, '--disallowedTools')).not.toContain('WebFetch')
      // Off with web tools off, as on the key.
      expect(list(policy({ webTools: false }).args, '--tools')).not.toContain('WebFetch')
    },
  },

  'connectors (incl. tools switched off)': {
    'api-key': () => {
      const r = applyRichRequest(request({ connectorIds: [calendar.id] }, [calendar]), { ...noC, mcpDisabled: { Calendar: ['delete_event'] } })
      expect(r.mcp_servers?.[0]).toMatchObject({ name: 'Calendar', url: calendar.url })
      expect(r.tools?.find((t) => t.type === 'mcp_toolset')).toMatchObject({ configs: { delete_event: { enabled: false } } })
    },
    'claude-code': () => {
      const plan = policy({ connectorIds: [calendar.id], toolPolicies: { [calendar.id]: { delete_event: 'off', list_events: 'allow' } } } as Partial<ChatCapabilities>, { connectors: [calendar] })
      expect(plan.offTools).toEqual(['mcp__calendar__delete_event'])
      expect(list(plan.args, '--disallowedTools')).toContain('mcp__calendar__delete_event')
      expect(list(plan.args, '--allowedTools')).toContain('mcp__calendar')
    },
  },

  images: {
    'api-key': async () => expect((await apiBlocksFor(image, apiCtx(false)))[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } }),
    'claude-code': () => expect(claudeCodeBlocks([image], ccCtx)[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }),
  },

  PDFs: {
    'api-key': async () => expect((await apiBlocksFor(pdf, apiCtx(false)))[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } }),
    'claude-code': () => {
      // The real document, as on the key, with the text kept for one too large to send.
      expect(claudeCodeBlocks([pdf], ccCtx)[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } })
      expect(pdfBlock({ title: 'Report.pdf', pages: 2, text: 'PDF words', read: () => Buffer.from('%PDF-1.7') })).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } })
      expect(pdfBlock({ title: 'Big.pdf', pages: 5000, text: 'Many words', read: () => Buffer.from('%PDF') })).toMatchObject({ type: 'text' })
      expect(JSON.parse(userLine([pdfBlock({ title: 'Report.pdf', pages: 2, text: 'PDF words', read: () => Buffer.from('%PDF') })])).message.content[0].type).toBe('document')
    },
  },

  'office files': {
    // The key sends them to the code container (Files and documents on); Claude Code reads their text locally.
    'api-key': async () => {
      const uploads: string[] = []
      const ctx = { ...apiCtx(true), files: { upload: async () => ({ id: 'file_doc' }) } as never, fingerprint: 'fp', onRemote: (_id: string, fileId: string) => uploads.push(fileId) }
      expect((await apiBlocksFor(office, ctx))[0]).toMatchObject({ type: 'container_upload' })
    },
    'claude-code': () => {
      const [block] = claudeCodeBlocks([office], ccCtx)
      expect(block).toMatchObject({ type: 'text' })
      expect((block as { text: string }).text).toContain('Parity words')
    },
  },

  'Files and documents': {
    'api-key': () => {
      const r = applyRichRequest(request({ documents: true } as Partial<ChatCapabilities>), { ...noC, documents: true })
      expect(r.tools).toContainEqual(CODE_EXECUTION_TOOL)
      expect(r.container).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ skill_id: 'docx' })]) })
    },
    'claude-code': () => {
      const folder = documentsWorkspace('parity-docs')
      const plan = policy({ documents: true } as Partial<ChatCapabilities>, { documentsFolder: folder })
      expect(plan.cwd).toBe(folder)
      expect(plan.documents).toBe(true)
      expect(flag(plan.args, '--add-dir')).toBe(folder)
      expect(list(plan.args, '--tools')).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'Skill']))
      // An ordinary chat gets none of them.
      expect(list(policy().args, '--tools')).not.toContain('Bash')
      // What the reply saves in outputs/ is collected, as the API container's files are.
      const before = snapshotOutputs('parity-docs')
      mkdirSync(join(folder, OUTPUTS_FOLDER), { recursive: true })
      writeFileSync(join(folder, OUTPUTS_FOLDER, 'Summary.docx'), 'x')
      expect(changedOutputs('parity-docs', before).map((f) => f.name)).toEqual(['Summary.docx'])
    },
  },

  'compaction (automatic)': {
    'api-key': () => {
      const r = applyRichRequest(request(), { ...noC, compaction: true })
      expect(r.context_management).toEqual({ edits: [{ type: 'compact_20260112' }] })
    },
    'claude-code': () => {
      // Claude Code condenses on its own; its compact_boundary becomes the same card.
      const events = new StreamJsonReader().read(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150_000 } }))
      expect(events).toEqual([{ kind: 'compacting', active: false, boundary: { trigger: 'auto', preTokens: 150_000 } }])
    },
  },

  'compaction (Compact now)': {
    'api-key': compactNow('api-key'),
    'claude-code': async () => {
      expect(typeof ClaudeCodeBackend.prototype.compact).toBe('function')
      await compactNow('claude-code')()
    },
  },

  'step cap and Continue': { 'api-key': stepCap('api-key'), 'claude-code': stepCap('claude-code') },

  'private chat': { 'api-key': privateChat('api-key'), 'claude-code': privateChat('claude-code') },

  'quick calls': Object.fromEntries(
    ENGINES.map((engine) => [
      engine,
      async () => {
        const { quick, seen } = quickOn(engine, 'A short label')
        expect(await quick.ready()).toMatchObject({ ok: true, engine })
        expect(await quick.text({ system: 'Label this.', prompt: 'words', kind: 'draft', effort: 'low' })).toBe('A short label')
        if (engine === 'api-key') expect(seen.params[0]).toMatchObject({ output_config: { effort: 'low' } })
        else {
          expect(flag(seen.args[0] ?? [], '--effort')).toBe('low')
          expect(flag(seen.args[0] ?? [], '--tools')).toBe('')
          expect(seen.args[0]).toContain('--no-session-persistence')
        }
      },
    ]),
  ) as Record<EngineId, Check>,

  'first-week starters': Object.fromEntries(
    ENGINES.map((engine) => [
      engine,
      async () => {
        const reply = JSON.stringify({ starters: curatedStarters().slice(0, 5).map(({ title, description, prompt, glyph }) => ({ title, description, prompt, glyph })) })
        const { quick, seen } = quickOn(engine, reply)
        const starters = await generateStarters(quick, { userName: 'Sam', companionName: 'Pip', instructions: '', memoryNotes: [], connectors: [], recentSites: [] })
        expect(starters).toHaveLength(5)
        if (engine === 'api-key') expect(seen.params[0]).toMatchObject({ output_config: { effort: 'low', format: { type: 'json_schema' } } })
        else {
          expect(flag(seen.args[0] ?? [], '--effort')).toBe('low')
          expect(flag(seen.args[0] ?? [], '--json-schema')).toBeTruthy()
        }
      },
    ]),
  ) as Record<EngineId, Check>,

  'memory build': { 'api-key': memoryBuild('api-key'), 'claude-code': memoryBuild('claude-code') },

  routines: { 'api-key': routines('api-key'), 'claude-code': routines('claude-code') },
}

describe('engine parity', () => {
  it('lists every model feature, each with a path on both engines', () => {
    expect(Object.keys(PARITY).sort()).toEqual([...FEATURES].sort())
    for (const feature of FEATURES) expect(Object.keys(PARITY[feature]).sort()).toEqual([...ENGINES].sort())
  })

  for (const feature of FEATURES) {
    describe(feature, () => {
      for (const engine of ENGINES) it(`works on ${engine === 'api-key' ? 'the API key' : 'Claude Code'}`, async () => await PARITY[feature][engine]())
    })
  }
})
