/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent } from '@shared/chats'
import type { LibraryFileRef } from '@shared/files'
import type { AgentEvent } from '@shared/ipc'
import { RemoteFileCache } from '../src/main/agent/content'
import { DOCUMENT_SKILLS } from '../src/main/agent/documents'
import {
  inWorkspace,
  beginWorkspaceTurn,
  changedOutputs,
  configureDocumentsWorkspace,
  copyDocumentsWorkspace,
  copyIntoWorkspace,
  DOCUMENTS_ALLOWED_TOOLS,
  DOCUMENTS_PLUGIN_NAME,
  documentsLaunch,
  documentsPluginDir,
  documentsRoot,
  documentsWorkspace,
  existingWorkspace,
  OUTPUT_LIMITS,
  outputMediaType,
  removeDocumentsWorkspace,
  safeFileName,
  saveWorkspaceOutputs,
  snapshotOutputs,
} from '../src/engines/claude-code/main/documentsWorkspace'
import { AgentHost } from '../src/main/agent/host'
import { PdfTabReader } from '../src/main/agent/pdfTab'
import { SessionRichChat, type RichChatDeps, type SessionRichChatHost } from '../src/main/agent/sessionRichChat'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import type { AgentBackend, BackendTurn } from '../src/main/engines/backend'
import type { LibraryFiles } from '../src/main/files/types'
import type { AttachmentStore } from '../src/main/intake/types'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'
import { linkFile } from './helpers/links'

// Files and documents on Claude Code. A private folder per chat under
// Atelier's data folder, Atelier's own document skills as a session-only plugin,
// copies of attachments in inputs/, and what a reply saves in outputs/
// collected into Library › Files. The engine is a fake; no `claude` runs.

const root = mkdtempSync(join(tmpdir(), 'atelier-docs-ws-'))
configureDocumentsWorkspace(root)
// A file outside Atelier's data folder, for the links a chat's folder may hold.
const outsideFile = join(mkdtempSync(join(tmpdir(), 'atelier-docs-outside-')), 'hosts')
writeFileSync(outsideFile, '127.0.0.1 localhost\n')

function fakeLibrary(): { library: LibraryFiles; added: Array<{ name: string; mediaType: string; bytes: string; chatId: string }> } {
  const added: Array<{ name: string; mediaType: string; bytes: string; chatId: string }> = []
  const library = {
    addGenerated: (input: { chatId: string; companionId: string; name: string; mediaType: string; bytes: Buffer }): LibraryFileRef => {
      added.push({ name: input.name, mediaType: input.mediaType, bytes: input.bytes.toString(), chatId: input.chatId })
      return { id: `lib-${added.length}`, name: input.name, mediaType: input.mediaType, size: input.bytes.length, kind: 'generated', chatId: input.chatId, companionId: input.companionId, createdAt: 1, state: 'ready', artifact: false } as LibraryFileRef
    },
  } as unknown as LibraryFiles
  return { library, added }
}

describe('the chat’s folder', () => {
  it('lives under the data folder, is made on demand and refuses ids that could climb out', () => {
    expect(documentsRoot()).toBe(join(root, 'documents'))
    expect(existingWorkspace('chat-a')).toBeNull()
    const dir = documentsWorkspace('chat-a')
    expect(dir).toBe(join(root, 'documents', 'chats', 'chat-a'))
    expect(readdirSync(dir).sort()).toEqual(['inputs', 'outputs'])
    expect(existingWorkspace('chat-a')).toBe(dir)
    for (const bad of ['../x', 'a/b', '', '.', 'a b']) expect(() => documentsWorkspace(bad)).toThrow()
    expect(existingWorkspace('../x')).toBeNull()
  })

  it('is removed with its chat and copied with a duplicate, links left behind', () => {
    const dir = documentsWorkspace('chat-rm')
    writeFileSync(join(dir, 'outputs', 'Plan.docx'), 'plan')
    const linked = linkFile(outsideFile, join(dir, 'outputs', 'link'))
    copyDocumentsWorkspace('chat-rm', 'chat-copy')
    expect(readFileSync(join(existingWorkspace('chat-copy') ?? '', 'outputs', 'Plan.docx'), 'utf8')).toBe('plan')
    if (linked) expect(existsSync(join(existingWorkspace('chat-copy') ?? '', 'outputs', 'link'))).toBe(false)
    removeDocumentsWorkspace('chat-rm')
    expect(existingWorkspace('chat-rm')).toBeNull()
    expect(existingWorkspace('chat-copy')).not.toBeNull()
    // Nothing to do for a chat without a folder.
    expect(() => removeDocumentsWorkspace('never-made')).not.toThrow()
    expect(() => copyDocumentsWorkspace('never-made', 'other')).not.toThrow()
  })
})

describe('Atelier’s document skills for Claude Code', () => {
  it('writes a session-only plugin with one skill per skill the API container loads', () => {
    const dir = documentsPluginDir()
    const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string }
    expect(manifest.name).toBe(DOCUMENTS_PLUGIN_NAME)
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual([...DOCUMENT_SKILLS].sort())
    for (const skill of DOCUMENT_SKILLS) {
      const text = readFileSync(join(dir, 'skills', skill, 'SKILL.md'), 'utf8')
      expect(text.startsWith(`---\nname: ${skill}\ndescription: `)).toBe(true)
      // Finished files go where Atelier collects them; the person's originals stay untouched.
      expect(text).toContain('outputs/')
      expect(text).toMatch(/never overwrite the file in `inputs\/`/i)
    }
    // Written again only when the shipped text changes: a second call keeps the same version.
    expect(JSON.parse(readFileSync(join(documentsPluginDir(), '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe(manifest.version)
  })

  it('gives the launch policy the folder, the plugin, the tools and the prompt note', () => {
    const launch = documentsLaunch('chat-launch')
    expect(launch.cwd).toBe(documentsWorkspace('chat-launch'))
    expect(launch.addDirs).toEqual([launch.cwd])
    expect(launch.pluginDirs).toEqual([documentsPluginDir()])
    expect([...launch.allowedTools]).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Skill'])
    expect(DOCUMENTS_ALLOWED_TOOLS).toBe(launch.allowedTools)
    expect(launch.note).toContain(launch.cwd)
    expect(launch.note).toContain('inputs/')
    expect(launch.note).toContain('outputs/')
    expect(launch.note).toContain(DOCUMENTS_PLUGIN_NAME)
  })
})

describe('attachments into inputs/', () => {
  it('copies once, numbers a different file with the same name, and keeps names inside the folder', () => {
    const src = mkdtempSync(join(root, 'src-'))
    const a = join(src, 'a.docx')
    const b = join(src, 'b.docx')
    writeFileSync(a, 'first')
    writeFileSync(b, 'second')
    expect(copyIntoWorkspace('chat-in', 'Report.docx', a)).toBe('inputs/Report.docx')
    expect(copyIntoWorkspace('chat-in', 'Report.docx', a)).toBe('inputs/Report.docx')
    expect(copyIntoWorkspace('chat-in', 'Report.docx', b)).toBe('inputs/Report (2).docx')
    expect(readFileSync(join(documentsWorkspace('chat-in'), 'inputs', 'Report (2).docx'), 'utf8')).toBe('second')
    expect(copyIntoWorkspace('chat-in', '../../etc/passwd', a)).toBe('inputs/passwd')
    expect(safeFileName('..\\..\\x:y?.txt')).toBe('x_y_.txt')
    expect(safeFileName('...')).toBe('file')
  })
})

describe('outputs/ after a reply', () => {
  it('collects new and changed files only, skipping hidden files, links, empty and oversized files', () => {
    const out = join(documentsWorkspace('chat-out'), 'outputs')
    writeFileSync(join(out, 'old.csv'), 'a,b')
    writeFileSync(join(out, 'kept.md'), '# kept')
    const before = snapshotOutputs('chat-out')
    writeFileSync(join(out, 'old.csv'), 'a,b,c')
    utimesSync(join(out, 'old.csv'), new Date(), new Date(Date.now() + 5000))
    mkdirSync(join(out, 'charts'))
    writeFileSync(join(out, 'charts', 'q3.png'), 'png')
    writeFileSync(join(out, '.hidden'), 'x')
    writeFileSync(join(out, 'empty.txt'), '')
    linkFile(outsideFile, join(out, 'hosts'))
    expect(changedOutputs('chat-out', before).map((f) => [f.name, f.size])).toEqual([['q3.png', 3], ['old.csv', 5]])
    expect(changedOutputs('no-folder', new Map())).toEqual([])
  })

  it('caps the number of files one reply hands over', () => {
    const out = join(documentsWorkspace('chat-many'), 'outputs')
    for (let i = 0; i < OUTPUT_LIMITS.files + 5; i++) writeFileSync(join(out, `f${String(i).padStart(2, '0')}.txt`), 'x')
    expect(changedOutputs('chat-many', new Map())).toHaveLength(OUTPUT_LIMITS.files)
  })

  it('saves them to Library › Files with their media types, one event each', () => {
    const out = join(documentsWorkspace('chat-save'), 'outputs')
    const before = snapshotOutputs('chat-save')
    writeFileSync(join(out, 'Deck.pptx'), 'deck')
    writeFileSync(join(out, 'data.bin'), 'bin')
    const { library, added } = fakeLibrary()
    const events: string[] = []
    const saved = saveWorkspaceOutputs(before, { library, chatId: 'chat-save', companionId: 'nova', onFile: (f) => events.push(f.name) })
    expect(saved.map((f) => f.name)).toEqual(['Deck.pptx', 'data.bin'])
    expect(added.map((f) => f.mediaType)).toEqual(['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream'])
    expect(events).toEqual(['Deck.pptx', 'data.bin'])
    expect(outputMediaType('a.XLSX')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(outputMediaType('a.pdf')).toBe('application/pdf')
  })

  it('costs nothing for chats without documents, and waits when Library › Files isn’t there', () => {
    expect(beginWorkspaceTurn('chat-none', false)).toBeNull()
    expect(existingWorkspace('chat-none')).toBeNull()
    const turn = beginWorkspaceTurn('chat-wait', true)
    writeFileSync(join(documentsWorkspace('chat-wait'), 'outputs', 'a.txt'), 'a')
    expect(turn?.finish({ library: () => { throw new Error('not yet') }, companionId: 'nova', onFile: () => undefined })).toEqual([])
  })
})

describe('the draft setup', () => {
  it('turns documents on for Claude Code with the setting, and leaves compaction to the API key', () => {
    const c = new SessionRichChat({} as SessionRichChatHost, () => undefined)
    expect(c.draftSetup('claude-code', 'claude-opus-5-5', true)).toEqual({ documents: true, compaction: false })
    expect(c.draftSetup('claude-code', 'claude-opus-5-5', false)).toEqual({ documents: false, compaction: false })
    expect(c.draftSetup('api-key', 'claude-opus-5-5', true)).toEqual({ documents: true, compaction: true })
  })
})

// ---- a whole chat on a fake Claude Code backend ----

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

function chatOn(documents: boolean) {
  const dir = mkdtempSync(join(root, 'data-'))
  const events: ChatAgentEvent[] = []
  const turns: BackendTurn[] = []
  const { library, added } = fakeLibrary()
  const backend: AgentBackend = {
    engine: 'claude-code',
    // As ClaudeCodeBackend.run does, around the reply.
    run: (turn) =>
      inWorkspace(turn, async () => {
        turns.push(turn)
        // What a Claude Code reply does in its folder: a finished file in outputs/, a script beside it.
        const folder = documentsWorkspace(turn.chatId)
        writeFileSync(join(folder, 'outputs', 'Summary.docx'), 'docx bytes')
        writeFileSync(join(folder, 'make.py'), 'print(1)')
        return { text: 'I made Summary.docx.', paused: false, error: null }
      }),
    reset: () => undefined,
    discard: () => undefined,
  }
  const tabs = { find: () => undefined, active: () => null, activeId: () => null, rail: () => null, activate: () => undefined, all: () => [], info: () => ({ title: '', url: '' }), contentBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), setAgentControlled: () => undefined, setNeedsInput: () => undefined } as unknown as TabManager
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const host = new AgentHost({
    settings: { get: () => ({ model: 'claude-opus-5-5', effort: 'medium', webTools: false, memory: false, confirmConsequentialActions: true, engine: 'claude-code', documents }), view: () => ({ hasApiKey: false }), apiKey: () => null },
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
    backends: { 'claude-code': backend },
    emit: (event) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const unavailable = (): never => {
    throw new Error('not in this test')
  }
  const deps: RichChatDeps = {
    attachments: () => ({ resolve: () => [], bindToMessage: () => undefined }) as unknown as AttachmentStore,
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
  return { host, chats, eventsOf, added, turns }
}

async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}

describe('a documents chat on Claude Code', () => {
  it('hands over what the reply saved in outputs/ as file cards, and nothing else', async () => {
    const t = chatOn(true)
    const id = t.host.start('make me a summary document')
    await until(() => !t.host.isRunning(id) && t.eventsOf(id).some((e) => e.type === 'file-produced'))
    expect(t.chats.load(id).capabilities.documents).toBe(true)
    expect(t.added).toEqual([{ name: 'Summary.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 'docx bytes', chatId: id }])
    const cards = t.eventsOf(id).filter((e) => e.type === 'file-produced')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ type: 'file-produced', file: { name: 'Summary.docx' }, turnId: expect.any(String) })
  })

  it('leaves chats without documents alone', async () => {
    const t = chatOn(false)
    // The fake still writes into a folder; a chat without documents never collects it.
    const id = t.host.start('hello')
    await until(() => !t.host.isRunning(id) && t.turns.length === 1)
    await new Promise((r) => setTimeout(r, 30))
    expect(t.chats.load(id).capabilities.documents).toBe(false)
    expect(t.added).toEqual([])
    expect(t.eventsOf(id).some((e) => e.type === 'file-produced')).toBe(false)
  })
})
