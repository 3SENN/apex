/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '../src/shared/branding'
import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS } from '@shared/chats'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EngineStatus } from '@shared/engine'
import { IDLE_UPDATE, type ClaudeCodeStatus } from '../src/engines/claude-code/shared/status'
import { ChatStore, engineSessionOf } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID, engineOrNull, sanitizeStoredCompanion } from '../src/main/companions'
import { DEFAULT_SETTINGS, migrateSettings, settingsPatchSchema } from '../src/main/settings'
import { engineBadge, engineCanSend, keyBadge } from '../src/renderer/src/settings/logic/engine'
import { accountLine, claudeBadge, cliLine, limitLine, shouldRecheckOnFocus } from '../src/engines/claude-code/renderer/logic'

// Engine settings, the companion override, the chat record and the words
// Settings shows for each state (ST-58).

describe('engine settings', () => {
  it('default to the API key with outside access off', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ engine: 'api-key', claudeCodePath: null, externalAccess: false, externalTabs: 'own' })
    expect(migrateSettings({})).toMatchObject({ engine: 'api-key', externalAccess: false })
  })

  it('keep valid saved values and drop bad ones one by one', () => {
    const migrated = migrateSettings({ engine: 'claude-code', claudeCodePath: '/opt/homebrew/bin/claude', externalAccess: true, externalTabs: 'any' })
    expect(migrated).toMatchObject({ engine: 'claude-code', claudeCodePath: '/opt/homebrew/bin/claude', externalAccess: true, externalTabs: 'any' })
    const bad = migrateSettings({ engine: 'gpt', claudeCodePath: 'claude', externalTabs: 'some', theme: 'dark' })
    expect(bad).toMatchObject({ engine: 'api-key', claudeCodePath: null, externalTabs: 'own', theme: 'dark' })
  })

  it('accept only absolute paths from the chrome', () => {
    expect(settingsPatchSchema.safeParse({ claudeCodePath: '/usr/local/bin/claude' }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ claudeCodePath: null }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ claudeCodePath: 'relative/claude' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ engine: 'other' }).success).toBe(false)
  })
})

describe('companion engine override', () => {
  it('is saved, cleared and reset like the model', () => {
    const store = new CompanionStore(mkdtempSync(join(tmpdir(), 'atelier-eng-')))
    const id = store.list()[0]?.id ?? FIRST_COMPANION_ID
    expect(store.get(id).engine).toBeNull()
    expect(store.update(id, { engine: 'claude-code' }).engine).toBe('claude-code')
    expect(store.update(id, { engine: 'nonsense' }).engine).toBeNull()
    store.update(id, { engine: 'api-key' })
    expect(store.reset(id).engine).toBeNull()
    expect(engineOrNull('claude-code')).toBe('claude-code')
    expect(engineOrNull(5)).toBeNull()
    expect(sanitizeStoredCompanion({ id: 'companion-9', engine: 'claude-code' }, [])?.engine).toBe('claude-code')
  })
})

describe('chat record', () => {
  it('keeps the engine session, and a duplicate forks it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-eng-chats-'))
    const chats = new ChatStore(dir, FIRST_COMPANION_ID)
    const id = '7d2c1a52-3f6e-4b8a-9c1d-2e5f8a7b6c4d'
    const now = Date.now()
    chats.save(
      { id, capabilities: { model: 'claude-opus-5-5', browser: true, webTools: true, memory: true, connectorIds: [], engine: 'claude-code' }, system: 's', messages: [{ role: 'user', content: 'hi' }], log: [], details: {}, feedback: {}, engineSession: { id: 'aaaaaaaa-1111-4222-8333-444444444444' } },
      { created: { id, title: 'Hi', createdAt: now, updatedAt: now, lastActiveAt: now, routineId: null, companionId: FIRST_COMPANION_ID, model: 'claude-opus-5-5', status: 'idle', unread: false, pinned: false, archived: false, needsInput: false, draft: false, ...CHAT_SUMMARY_FLAG_DEFAULTS, ...CHAT_SUMMARY_LINK_DEFAULTS } },
    )
    const loaded = new ChatStore(dir, FIRST_COMPANION_ID).load(id)
    expect(loaded.engineSession).toEqual({ id: 'aaaaaaaa-1111-4222-8333-444444444444' })
    expect(loaded.capabilities.engine).toBe('claude-code')
    const copy = chats.duplicate(id)
    expect(chats.load(copy.id).engineSession).toEqual({ id: 'aaaaaaaa-1111-4222-8333-444444444444', fork: true })
    expect(engineSessionOf({ id: '../../etc' })).toBeNull()
    expect(engineSessionOf(null)).toBeNull()
  })
})

describe('engine status words', () => {
  const claude = (patch: Partial<ClaudeCodeStatus>): ClaudeCodeStatus => ({ state: 'ready', path: '/x/claude', source: 'login-shell', version: '2.1.266', account: 'subscription', detail: 'Signed in and ready.', nextStep: null, overrideInvalid: false, rateLimit: null, checkedAt: 1, installs: [], tooOld: null, update: IDLE_UPDATE, ...patch })

  it('badges every state', () => {
    expect(claudeBadge(claude({ state: 'checking' })).label).toBe('Checking…')
    expect(claudeBadge(claude({})).tone).toBe('success')
    expect(claudeBadge(claude({ state: 'signed-out' })).label).toBe('Not signed in')
    expect(claudeBadge(claude({ state: 'not-found' })).label).toBe('Not found')
    expect(claudeBadge(claude({ state: 'unknown' })).tone).toBe('info')
    expect(keyBadge('missing').label).toBe('Needs a key')
    expect(keyBadge('environment').tone).toBe('info')
    // Main sends each engine's badge with its summary (ClaudeCodeEngine.summary, from the same words).
    const badge = claudeBadge(claude({ state: 'signed-out' }))
    const status = { apiKey: { state: 'saved' }, claudeCode: claude({ state: 'signed-out' }), others: [{ id: 'claude-code', ready: false, checking: false, detail: '', badge: badge.label, tone: badge.tone }] } as unknown as EngineStatus
    expect(engineBadge(status, 'api-key').label).toBe('Ready')
    expect(engineBadge(status, 'claude-code').label).toBe('Not signed in')
  })

  it('says where the CLI came from and how it signs in', () => {
    expect(cliLine(claude({}))).toBe('Version 2.1.266, from your shell’s PATH.')
    expect(cliLine(claude({ source: 'bundled', version: null }))).toBe(`Installed, from the copy that comes with ${BRAND_NAME}.`)
    expect(cliLine(claude({ state: 'not-found', path: null, detail: 'Not here.' }))).toBe('Not here.')
    expect(accountLine(claude({}))).toBe('Signed in with your Claude subscription.')
    expect(accountLine(claude({ account: 'api-key' }))).toContain('API key you gave Claude Code')
    expect(accountLine(claude({ state: 'signed-out', detail: 'Not signed in.' }))).toBe('Not signed in.')
  })

  it('describes an account limit and when to look again', () => {
    expect(limitLine(null, String)).toBeNull()
    expect(limitLine({ status: 'limited', resetsAt: 5, at: 1 }, () => '3:40 PM')).toContain('at its limit until 3:40 PM')
    expect(limitLine({ status: 'warning', resetsAt: null, at: 1 }, String)).toBe('Your Claude account is close to its limit.')
    expect(shouldRecheckOnFocus(claude({ state: 'signed-out' }))).toBe(true)
    expect(shouldRecheckOnFocus(claude({}))).toBe(false)
  })

  it('lets a Claude Code chat send without an API key', () => {
    expect(engineCanSend('claude-code', false)).toBe(true)
    expect(engineCanSend('api-key', false)).toBe(false)
    expect(engineCanSend(undefined, true)).toBe(true)
  })
})
