/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// The platform feature asks Electron for paths as it starts; here every Electron API is a no-op.
vi.mock('electron', () => {
  const noop: unknown = new Proxy(function () {}, {
    get: (_t, key) => {
      if (key === 'isPackaged') return false
      if (key === 'getAppPath' || key === 'getPath') return () => '/nonexistent/atelier-d0'
      return key === 'then' || key === Symbol.toPrimitive ? undefined : noop
    },
    apply: () => noop,
    construct: () => noop as object,
  })
  return new Proxy({}, { get: (_t, key) => (key === 'then' || key === '__esModule' ? undefined : noop), has: () => true })
})
import { ALWAYS_ASK, scopeExplanation } from '@shared/agentTools'
import { CHAT_SUMMARY_LINK_DEFAULTS } from '@shared/chats'
import { approxCostUsd } from '@shared/pricing'
import { SETTINGS, settingScope } from '@shared/settingsRegistry'
import { appRunUrl, internalQuery, isAppRunUrl, parseInternalUrl, routineUrl, skillUrl, workspaceUrl, INTERNAL_PAGES, DESTINATIONS, SETTINGS_PAGES } from '@shared/url'
import { MEMORY_JOBS_SCHEMAS, MEMORY_UPKEEP_SCHEMAS } from '../src/main/activity/schemas'
import { createMemoryFeatures } from '../src/main/activity/feature'
import { AGENT_TOOLS_CAPABILITY_DEFAULTS, normalizeAgentToolsCapabilities, normalizeGrants, normalizeSummaryLinks } from '../src/main/agent/chatFormatAgentTools'
import { createAgentFeatures } from '../src/main/agent/feature'
import { AGENT_TOOLS_SCHEMAS, AGENT_TOOLS_METHOD_SCHEMAS, PRIVATE_CHATS_SCHEMAS, agentRequestResponse } from '../src/main/agent/agentToolsSchemas'
import { clientToolsFor, registerClientTool, resetClientToolsForTests, type ClientTool, type ToolSetup } from '../src/main/agent/tools/registry'
import { PLATFORM_SCHEMAS } from '../src/main/apps/schemas'
import { createPlatformFeatures } from '../src/main/apps/feature'
import { CHAT_TOOLS_SCHEMAS, CHATS_PROJECT_SCHEMAS, createChatFeatures } from '../src/main/chatFeatures'
import { normalizeSummary } from '../src/main/chats'
import { exportSource, registerExportSource } from '../src/main/exporter'
import type { AppContext, Feature } from '../src/main/features/types'
import { COMPANIONS_SETUP_SCHEMAS, FIRST_RUN_SCHEMAS, ONBOARDING_SCHEMAS } from '../src/main/guides/schemas'
import { createFirstRunFeatures } from '../src/main/guides/feature'
import { ROUTINES_SCHEMAS, SKILLS_SCHEMAS, routineSchedule } from '../src/main/routines/schemas'
import { createSkillRoutineFeatures } from '../src/main/routines/feature'
import { CHATS_SCHEMA_ADDITIONS } from '../src/main/schemas/chat'
import { SettingsStore } from '../src/main/settings'
import { registerScenario, scenarioFor } from '../src/main/smokeClient'
import { WORKSPACE_SCHEMAS, fileRef } from '../src/main/workspace/schemas'
import { createWorkspaceFeatures } from '../src/main/workspace/feature'
import { FakeHost } from './helpers/fakeHost'

// The service contracts: every service method of these features has a
// schema and a feature method behind it, the chat file normalizers fill
// their defaults, and the shared registries, routes and settings hold.

const FIXTURES = join(__dirname, 'fixtures/chats/formats')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>

describe('service schemas are strict and capped', () => {
  it('validates request responses', () => {
    expect(agentRequestResponse.safeParse({ kind: 'approval', allowed: true, scope: 'site' }).success).toBe(true)
    expect(agentRequestResponse.safeParse({ kind: 'approval', allowed: true, scope: 'forever' }).success).toBe(false)
    expect(agentRequestResponse.safeParse({ kind: 'question', answers: null }).success).toBe(true)
    expect(agentRequestResponse.safeParse({ kind: 'question', answers: [{ id: 'q1', answer: ['a', 'b'] }] }).success).toBe(true)
    expect(agentRequestResponse.safeParse({ kind: 'auto-approval', action: 'stop', extra: 1 }).success).toBe(false)
  })

  it('never lets approval mode store dont-ask', () => {
    expect(AGENT_TOOLS_METHOD_SCHEMAS.setApprovalMode.safeParse(['dont-ask']).success).toBe(true)
    expect(SETTINGS.approvalMode.schema.safeParse('dont-ask').success).toBe(false)
  })

  it('validates file refs and schedules', () => {
    expect(fileRef.safeParse({ kind: 'folder', folderId: 'f1', path: 'notes/a.md' }).success).toBe(true)
    expect(fileRef.safeParse({ kind: 'folder', folderId: 'f1', path: '../secret' }).success).toBe(false)
    expect(fileRef.safeParse({ kind: 'library', id: 'x', path: 'y' }).success).toBe(false)
    expect(routineSchedule.safeParse({ kind: 'interval', minutes: 60, between: { start: 540, end: 1020 } }).success).toBe(true)
    expect(routineSchedule.safeParse({ kind: 'interval', hours: 2 }).success).toBe(false)
    expect(routineSchedule.safeParse({ kind: 'cron', expr: '0 9 * * 1-5' }).success).toBe(true)
  })

  it('registers the approval, sound, tip and flag settings with app scope', () => {
    for (const key of ['approvalMode', 'siteAccessDefault', 'chatSounds', 'introSounds', 'chatTips', 'flags'] as const) {
      expect(settingScope(key)).toBe('app')
    }
    expect(SETTINGS.flags.schema.safeParse({ 'new-app-flow': 'on' }).success).toBe(true)
    expect(SETTINGS.flags.schema.safeParse({ 'Bad Key': 'on' }).success).toBe(false)
  })
})

describe('chat file normalizers (private chats, delegation, grants)', () => {
  it('fills the defaults for older chats', () => {
    const raw = fixture('before-summary-fields.json')
    expect(normalizeSummaryLinks(raw)).toEqual(CHAT_SUMMARY_LINK_DEFAULTS)
    expect(normalizeSummary(raw, 'pip')).toMatchObject(CHAT_SUMMARY_LINK_DEFAULTS)
    expect(normalizeAgentToolsCapabilities(raw.capabilities as Record<string, unknown>)).toEqual(AGENT_TOOLS_CAPABILITY_DEFAULTS)
    expect(normalizeGrants(raw.grants)).toEqual([])
  })

  it('keeps the newer fields and drops malformed ones', () => {
    const raw = fixture('summary-fields.json')
    expect(normalizeSummaryLinks(raw)).toEqual({
      private: false,
      parentChatId: '33333333-2222-4333-8444-555555555555',
      delegationStatus: 'done',
      projectId: 'p1',
      imported: { source: 'chatgpt', originalTitle: 'Trip ideas', originalCreatedAt: 1700000000000, importedAt: 1795000000000 },
      routineRun: { runId: 'run1', scheduledFor: 1795000000000, trigger: 'catch-up' },
    })
    expect(normalizeAgentToolsCapabilities(raw.capabilities as Record<string, unknown>)).toEqual({ clientTools: ['list_routines', 'update_plan'], private: false })
    expect(normalizeGrants(raw.grants)).toEqual([{ origin: 'https://shop.example', action: 'purchase', at: 1795000030000 }])
    expect(normalizeSummaryLinks({ delegationStatus: 'weird', imported: { source: 'other' } })).toMatchObject({ delegationStatus: null, imported: null })
  })
})

describe('client-tool registry', () => {
  afterEach(() => resetClientToolsForTests())

  const setup: ToolSetup = {
    companionId: 'pip',
    browser: true,
    memory: true,
    routine: false,
    private: false,
    flags: {},
    workspace: { folders: false, tables: false, apps: false, calendar: false, activity: false },
  }
  const tool = (name: string, enabled: (s: ToolSetup) => boolean = () => true): ClientTool<{ a: string }> => ({
    name,
    group: 'chat',
    description: name,
    inputSchema: { type: 'object' },
    parse: z.object({ a: z.string() }).strict(),
    enabled,
    run: async () => ({ content: 'ok' }),
  })

  it('sorts by name, filters by setup and refuses duplicates', () => {
    registerClientTool(tool('update_plan'))
    registerClientTool(tool('ask_user_questions', (s) => !s.routine))
    registerClientTool(tool('delegate_task', (s) => !s.routine))
    expect(clientToolsFor(setup).map((t) => t.name)).toEqual(['ask_user_questions', 'delegate_task', 'update_plan'])
    expect(clientToolsFor({ ...setup, routine: true }).map((t) => t.name)).toEqual(['update_plan'])
    expect(() => registerClientTool(tool('update_plan'))).toThrow('already registered')
    expect(() => registerClientTool(tool('bad name'))).toThrow('Invalid client tool name')
  })
})

describe('routes and helpers', () => {
  it('adds the workspace, guides and flags pages, destinations and settings page', () => {
    expect(INTERNAL_PAGES).toMatchObject({ workspace: 'Workspace', guides: 'Guides', flags: 'Experiments' })
    expect(DESTINATIONS).toEqual(expect.arrayContaining(['workspace', 'guides']))
    const ids = SETTINGS_PAGES.map((p) => p.id) as string[]
    expect(ids.indexOf('activity')).toBe(ids.indexOf('memory') + 1)
  })

  it('parses the routine, workspace, guides and flags routes', () => {
    expect(parseInternalUrl(routineUrl('r1', true))).toEqual({ page: 'routines', id: 'r1', section: 'edit', item: null })
    expect(parseInternalUrl('atelier://routines/new')).toEqual({ page: 'routines', id: 'new', section: null, item: null })
    expect(parseInternalUrl('atelier://routines/r1/other')).toBeNull()
    expect(parseInternalUrl(workspaceUrl('projects', 'p1'))).toEqual({ page: 'workspace', section: 'projects', id: 'p1', item: null })
    expect(parseInternalUrl('atelier://workspace/elsewhere')).toBeNull()
    expect(parseInternalUrl('atelier://workspace')).toEqual({ page: 'workspace', section: null, id: null, item: null })
    expect(parseInternalUrl('atelier://guides/first-steps')).toEqual({ page: 'guides', id: 'first-steps', section: null, item: null })
    expect(parseInternalUrl('atelier://flags')).toEqual({ page: 'flags', section: null, id: null, item: null })
    expect(internalQuery(skillUrl('s1', 'docs/a b.md'), 'file')).toBe('docs/a b.md')
    expect(internalQuery('atelier://routines?view=runs', 'view')).toBe('runs')
  })

  it('keeps apps off atelier:// pages', () => {
    expect(appRunUrl('a1')).toBe('atelier-app://a1/')
    expect(isAppRunUrl(appRunUrl('a1'))).toBe(true)
    expect(parseInternalUrl(appRunUrl('a1'))).toBeNull()
  })
})

describe('shared registries and helpers', () => {
  it('scripts smoke scenarios, latest first', () => {
    registerScenario(/^d0 contract/, [{ kind: 'text', text: 'first' }])
    registerScenario(/^d0 contract two/, [{ kind: 'text', text: 'second' }])
    expect(scenarioFor('d0 contract two')).toEqual([{ kind: 'text', text: 'second' }])
    expect(scenarioFor('d0 contract')).toEqual([{ kind: 'text', text: 'first' }])
    expect(scenarioFor('anything else')).toBeNull()
  })

  it('registers export sources and trash adapters', async () => {
    registerExportSource('transcript', { title: () => 't', markdown: () => '# t' })
    expect(exportSource('transcript')?.markdown('x')).toBe('# t')
    // A fresh copy of the registry: the features below register the real adapters.
    vi.resetModules()
    const { registerTrashAdapter, trashAdapter } = await import('../src/main/workspace/adapters')
    registerTrashAdapter({ kind: 'table', title: () => 'T', snapshot: () => ({ payload: null }), restore: () => 'T' })
    expect(trashAdapter('table')?.title('x')).toBe('T')
    expect(() => registerTrashAdapter({ kind: 'table', title: () => 'T', snapshot: () => ({ payload: null }), restore: () => 'T' })).toThrow('already registered')
  })

  it('keeps the always-ask kinds and the estimate helpers', () => {
    expect([...ALWAYS_ASK].sort()).toEqual(['payment', 'security'])
    expect(scopeExplanation('purchase', 'https://a.example', 'site')).toContain('a.example')
    expect(scopeExplanation('payment', 'https://a.example', 'site')).not.toContain('a.example')
    expect(approxCostUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(4)
    expect(approxCostUsd('some-other-model', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
  })

  it('records calls on the FakeHost', async () => {
    const host = new FakeHost()
    host.completeReplies = ['one', 'two']
    expect(await host.complete({ system: 's', prompt: 'p', kind: 'draft' })).toBe('one')
    expect(await host.complete({ system: 's', prompt: 'p', kind: 'draft' })).toBe('two')
    expect(await host.complete({ system: 's', prompt: 'p', kind: 'draft' })).toBe('two')
    const run = await host.runBackground({ companionId: 'pip', prompt: 'p', kind: 'routine' })
    expect(run).toMatchObject({ ok: true, status: 'finished' })
    const chatId = host.startChat('hi', { context: 'ctx' })
    host.appendEvent(chatId, { type: 'plan', items: [] })
    expect(host.log(chatId)).toEqual([{ type: 'plan', items: [] }])
    expect(host.startedChats[0]?.options?.context).toBe('ctx')
  })
})

type Parts = Record<string, Record<string, unknown>>
const keysOf = (map: Record<string, object>): string[] => Object.entries(map).flatMap(([ns, m]) => Object.keys(m).map((k) => `${ns}.${k}`)).sort()

/** Anything a feature calls on a host it doesn't need here answers with another no-op. */
const inert = (): unknown => {
  const p: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === 'then' || key === Symbol.iterator || key === Symbol.toPrimitive ? undefined : p),
    apply: () => p,
    construct: () => p as object,
  })
  return p
}

// Runs last: the real features register tools, export sources and trash
// adapters as they start, which the registry tests above must not see.
describe('feature service schemas match every feature method', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-d0-'))
  const ctx = {
    dataDir,
    smoke: false,
    settings: new SettingsStore(join(dataDir, 'settings')),
    broadcast: () => undefined,
    agent: inert(),
    windows: inert(),
    tabsRegistry: inert(),
    commands: inert(),
    float: inert(),
    quick: inert(),
    notify: inert(),
    signal: inert(),
    personal: inert(),
    content: inert(),
    maintenance: inert(),
  } as unknown as AppContext
  const partsOf = (f: Feature): Parts => (f.app?.(ctx) ?? {}) as Parts
  afterAll(() => {
    resetClientToolsForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const cases: Array<[string, () => Feature, Record<string, object>]> = [
    // The agentTools feature takes over chats.continue so a stopped sub-task resumes too; the schema stays the base one.
    ['agentTools', createAgentFeatures, { ...AGENT_TOOLS_SCHEMAS, agent: AGENT_TOOLS_METHOD_SCHEMAS, chats: { ...PRIVATE_CHATS_SCHEMAS, continue: CHATS_SCHEMA_ADDITIONS.continue } }],
    ['chatTools', createChatFeatures, { ...CHAT_TOOLS_SCHEMAS, chats: CHATS_PROJECT_SCHEMAS }],
    ['skillsRoutines', createSkillRoutineFeatures, { skills: SKILLS_SCHEMAS, routines: ROUTINES_SCHEMAS }],
    ['memory', createMemoryFeatures, { ...MEMORY_UPKEEP_SCHEMAS, memory: MEMORY_JOBS_SCHEMAS }],
    ['workspace', createWorkspaceFeatures, WORKSPACE_SCHEMAS],
    ['platform', createPlatformFeatures, PLATFORM_SCHEMAS],
    ['firstRun', createFirstRunFeatures, { ...FIRST_RUN_SCHEMAS, onboarding: ONBOARDING_SCHEMAS, companions: COMPANIONS_SETUP_SCHEMAS }],
  ]

  it.each(cases)('%s', (name, create, schemas) => {
    const feature = create()
    expect(feature.name).toBe(name)
    const parts = partsOf(feature)
    expect(keysOf(parts)).toEqual(keysOf(schemas))
    for (const [ns, methods] of Object.entries(parts)) {
      for (const [method, fn] of Object.entries(methods)) expect(typeof fn, `${ns}.${method}`).toBe('function')
    }
  })
})
