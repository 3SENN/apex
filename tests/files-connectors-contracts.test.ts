/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ATTACHMENT_LIMITS, attachmentViewToRef, attachmentsReady, isLongPaste, type AttachmentRef } from '@shared/attachments'
import { connectRequestOf, connectorConnectUrl } from '@shared/connectors'
import { isWebStoreUrl } from '@shared/extensions'
import { fileViewerUrl, parseFileViewerUrl, type ViewerTarget } from '@shared/files'
import { defaultProfile, profilePartition } from '@shared/profiles'
import { SETTINGS, defineSettings, settingScope, settingsOfScope } from '@shared/settingsRegistry'
import type { AgentEvent } from '@shared/ipc'
import { normalizeRichChatCapabilities, normalizeAttachmentLog, RICH_CHAT_CAPABILITY_DEFAULTS } from '../src/main/agent/chatFormatRichChat'
import { REPLY_TOOL_INPUTS } from '../src/main/agent/replyTools'
import { approveConnectorArgs, messageAttachmentsSchema } from '../src/main/agent/richChatSchemas'
import { CONNECTORS_SCHEMAS } from '../src/main/connectors/schemas'
import { setupConnectors } from '../src/main/connectors/service'
import { EXTENSIONS_SCHEMAS } from '../src/main/extensions/schemas'
import { setupExtensions } from '../src/main/extensions/service'
import { FILES_SCHEMAS, viewerTargetSchema } from '../src/main/files/schemas'
import { setupFiles } from '../src/main/files/service'
import { INTAKE_SCHEMAS, attachmentSourceSchema } from '../src/main/intake/schemas'
import { setupIntake } from '../src/main/intake/service'
import { PROFILES_SCHEMAS } from '../src/main/profiles/schemas'

// The service contracts for intake, files, connectors, extensions and
// profiles: every method has a schema, and the chat format normalizers hold.

const UUID = '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e'
const CHAT = '11111111-2222-4333-8444-555555555555'

function methodsOf(services: object): string[] {
  return Object.entries(services as Record<string, object>).flatMap(([ns, impl]) => Object.keys(impl).map((m) => `${ns}.${m}`)).sort()
}
function schemasOf(schemas: object): string[] {
  return Object.entries(schemas as Record<string, object>).flatMap(([ns, map]) => Object.keys(map).map((m) => `${ns}.${m}`)).sort()
}

describe('service schemas cover every method', () => {
  it('intake, files, connectors and extensions', () => {
    expect(schemasOf(INTAKE_SCHEMAS)).toEqual(methodsOf(setupIntake({ dataDir: '/tmp/x', broadcast: () => {} }).services))
    expect(schemasOf(FILES_SCHEMAS)).toEqual(methodsOf(setupFiles({ dataDir: '/tmp/x', broadcast: () => {} }).services))
    expect(schemasOf(CONNECTORS_SCHEMAS)).toEqual(methodsOf(setupConnectors({ dataDir: '/tmp/x' }).services))
    expect(schemasOf(EXTENSIONS_SCHEMAS)).toEqual(methodsOf(setupExtensions({ dataDir: '/tmp/x', broadcast: () => {} }).services))
    expect(Object.keys(PROFILES_SCHEMAS.profiles).sort()).toEqual(['create', 'current', 'deletionSummary', 'list', 'remove', 'rename', 'setHue', 'switchTo'])
  })

  // The real services start empty, refuse attachment ids they never
  // issued and show an unknown library file as missing.
  it('real services start empty and refuse unknown ids', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-contracts-'))
    try {
      const intake = setupIntake({ dataDir, broadcast: () => {} })
      expect(intake.services.attachments.list(CHAT)).toEqual([])
      expect(intake.store.resolve(CHAT, [])).toEqual([])
      expect(() => intake.store.resolve(CHAT, [UUID])).toThrow()
      expect(await setupFiles({ dataDir, broadcast: () => {} }).services.viewer.open({ kind: 'library', id: UUID })).toMatchObject({ state: 'missing', deletable: false })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('validates attachment sources strictly and with caps', () => {
    expect(attachmentSourceSchema.safeParse({ type: 'paste', text: 'hello' }).success).toBe(true)
    expect(attachmentSourceSchema.safeParse({ type: 'paste', text: 'hello', extra: 1 }).success).toBe(false)
    expect(attachmentSourceSchema.safeParse({ type: 'file', name: 'a.png', base64: 'not base64!' }).success).toBe(false)
    expect(attachmentSourceSchema.safeParse({ type: 'paste', text: 'x'.repeat(ATTACHMENT_LIMITS.textBytes + 1) }).success).toBe(false)
    expect(INTAKE_SCHEMAS.chatFiles.read.safeParse([CHAT, '../etc/passwd']).success).toBe(false)
  })

  it('caps message attachments at 20 and checks the connector approval response', () => {
    const ref = { kind: 'ref', id: UUID }
    expect(messageAttachmentsSchema.safeParse(Array(20).fill(ref)).success).toBe(true)
    expect(messageAttachmentsSchema.safeParse(Array(21).fill(ref)).success).toBe(false)
    expect(approveConnectorArgs.safeParse([CHAT, UUID, { allowed: true, input: { title: 'x' } }]).success).toBe(true)
    expect(approveConnectorArgs.safeParse([CHAT, UUID, { allowed: false, message: 'x'.repeat(501) }]).success).toBe(false)
  })

  it('client tool inputs refuse invalid values', () => {
    expect(REPLY_TOOL_INPUTS.suggest_next_steps.safeParse({ steps: [] }).success).toBe(false)
    expect(REPLY_TOOL_INPUTS.suggest_next_steps.safeParse({ steps: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false)
    expect(REPLY_TOOL_INPUTS.save_artifact.safeParse({ title: 'T', format: 'pdf', content: 'x' }).success).toBe(false)
  })
})

describe('shared helpers', () => {
  it('viewer addresses round-trip and reject junk', () => {
    const target: ViewerTarget = { kind: 'memory', owner: 'shared', path: '/memories/über notes.md' }
    const url = fileViewerUrl(target, { edit: true })
    expect(url.startsWith('atelier://file?src=')).toBe(true)
    expect(parseFileViewerUrl(url)).toEqual({ target, edit: true })
    expect(viewerTargetSchema.safeParse(parseFileViewerUrl(url)?.target).success).toBe(true)
    expect(parseFileViewerUrl('atelier://file?src=%%%')).toBeNull()
    expect(viewerTargetSchema.safeParse({ kind: 'local', path: 'relative/path' }).success).toBe(false)
  })

  it('connect deep links and the exact Web Store origin', () => {
    expect(connectRequestOf(connectorConnectUrl('linear'))).toBe('linear')
    expect(connectRequestOf('atelier://connectors?connect=../x')).toBeNull()
    expect(isWebStoreUrl('https://chromewebstore.google.com/detail/x')).toBe(true)
    expect(isWebStoreUrl('https://chromewebstore.google.com.evil.test/')).toBe(false)
  })

  it('long pastes, readiness and profile partitions', () => {
    expect(isLongPaste('x'.repeat(1500))).toBe(true)
    expect(isLongPaste(Array(30).fill('a').join('\n'))).toBe(true)
    expect(isLongPaste('short\ntext')).toBe(false)
    const ref = (state: AttachmentRef['state']): AttachmentRef => ({ id: UUID, kind: 'text', name: 'a', state, error: null, size: 1, mediaType: 'text/plain', thumbnail: null })
    expect(attachmentsReady([ref('ready'), ref('preparing')])).toBe(false)
    expect(profilePartition('default')).toBe('persist:atelier-web')
    expect(profilePartition('abcd1234')).toBe('persist:atelier-profile-abcd1234')
    expect(defaultProfile('moss').isDefault).toBe(true)
  })

  it('the settings registry knows scopes and rejects bad defaults', () => {
    expect(settingScope('profileHue')).toBe('profile')
    expect(settingScope('documents')).toBe('app')
    expect(SETTINGS.documents.default).toBe(false)
    expect(settingsOfScope('profile')).toContain('sidebar.destinations.files')
    expect(() => defineSettings({ bad: { scope: 'app', schema: z.boolean(), default: 'yes' } })).toThrow(/default/)
  })
})

describe('chat format: attachment refs and capabilities', () => {
  const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, 'fixtures/chats/formats', name), 'utf8')) as Record<string, unknown>

  it('fills the newer capabilities with their defaults for older files', () => {
    const old = fixture('attachments.json')
    expect(normalizeRichChatCapabilities(old.capabilities as Record<string, unknown>)).toEqual(RICH_CHAT_CAPABILITY_DEFAULTS)
    const current = normalizeRichChatCapabilities(fixture('refs.json').capabilities as Record<string, unknown>)
    expect(current).toMatchObject({ documents: true, compaction: true, containerId: 'container_abc', toolPolicies: { c1: { read: 'allow' } } })
    expect(current.localTools).toHaveLength(1)
  })

  it('converts older attachment views to ready refs and leaves current refs alone', () => {
    const log = fixture('attachments.json').log as AgentEvent[]
    const next = normalizeAttachmentLog(log)
    const message = next[0] as { attachments?: AttachmentRef[] }
    expect(message.attachments).toEqual([
      attachmentViewToRef({ kind: 'image', thumbnail: 'data:image/jpeg;base64,/9j/AA==', label: 'Screen' }, 'aaaaaaaa-1111-4222-8333-444444444444', 0),
      attachmentViewToRef({ kind: 'meeting', meetingId: 'm-1', title: 'Weekly sync' }, 'aaaaaaaa-1111-4222-8333-444444444444', 1),
    ])
    expect(message.attachments?.[0]).toMatchObject({ kind: 'image', state: 'ready', thumbnail: 'data:image/jpeg;base64,/9j/AA==', mediaType: 'image/jpeg' })
    expect(message.attachments?.[1]).toMatchObject({ kind: 'meeting', sourceId: 'm-1', name: 'Weekly sync' })
    // Stable across loads.
    expect(normalizeAttachmentLog(log)).toEqual(next)
    const cLog = fixture('refs.json').log as AgentEvent[]
    expect(normalizeAttachmentLog(cLog)).toBe(cLog)
  })
})
