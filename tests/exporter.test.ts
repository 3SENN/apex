/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, BrowserWindow: class {}, dialog: {}, shell: {} }))

import type { ChatView } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import { ATELIER_CHAT_EXPORT_VERSION, chatMessages, chatToMarkdown, chatToText, parseAtelierChatMarkdown } from '@shared/exportFormat'
import { MAILTO_MAX, createExporter, mailtoUrl, registerExportSource, uniqueName, type ExporterDeps } from '../src/main/exporter'
import { escapeHtml, htmlDocument, markdownDocument } from '../src/main/exportTemplates/html'
import { chatNotificationSilent, chatsProjectMethods, registerChatExportSource } from '../src/main/chatFeatures'
import { parseAtelierExport } from '../src/main/conversationImport/parsers'
import { exportActions, exportedName } from '../src/renderer/src/chat/logic/exportDialog'

// CH-36: the Markdown chat format the importer reads back (golden), the HTML
// template, the exporter service on fake Electron deps, the mail draft's
// limits, and the dialog's choices.

type View = Pick<ChatView, 'summary' | 'log' | 'details'>

const CREATED = Date.UTC(2026, 9, 1, 9, 30)
const REPLIED = Date.UTC(2026, 9, 1, 9, 31)

function view(log: AgentEvent[], patch: Partial<ChatView['summary']> = {}): View {
  return {
    summary: { id: 'c1', title: 'Lisbon weekend', createdAt: CREATED, companionId: 'pip', draft: false, ...patch } as ChatView['summary'],
    log,
    details: { t1: { turnId: 't1', at: REPLIED, model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: null, memoryPaths: [] } },
  }
}

const CHAT = view([
  { type: 'user-message', id: 'u1', text: 'Plan a relaxed weekend' },
  { type: 'tool', id: 'x', name: 'search', label: 'Searching', state: 'done' } as unknown as AgentEvent,
  { type: 'text-delta', turnId: 't1', text: 'Here is a plan:\n\n- Alfama\n- Belém' },
  { type: 'user-message', id: 'u2', text: 'And food?\n### You\nis a heading in my text' },
  { type: 'text-delta', turnId: 't2', text: 'Try **pastéis**.' },
])

describe('the Markdown chat format', () => {
  it('writes front matter, then You and companion sections with ISO times (golden)', () => {
    expect(chatToMarkdown(CHAT, { companionName: 'Pip' })).toBe(
      [
        '---',
        'atelier_export: chat',
        `version: ${ATELIER_CHAT_EXPORT_VERSION}`,
        'title: "Lisbon weekend"',
        'createdAt: "2026-10-01T09:30:00.000Z"',
        'companion: "Pip"',
        '---',
        '',
        '# Lisbon weekend',
        '',
        '### You · 2026-10-01T09:30:00.000Z',
        '',
        'Plan a relaxed weekend',
        '',
        '### Pip · 2026-10-01T09:31:00.000Z',
        '',
        'Here is a plan:',
        '',
        '- Alfama',
        '- Belém',
        '',
        '### You',
        '',
        'And food?',
        '\\### You',
        'is a heading in my text',
        '',
        '### Pip',
        '',
        'Try **pastéis**.',
        '',
      ].join('\n'),
    )
  })

  it('round-trips through the parser and the Atelier importer', () => {
    const markdown = chatToMarkdown(CHAT, { companionName: 'Pip' })
    const parsed = parseAtelierChatMarkdown(markdown)
    expect(parsed).toEqual({
      title: 'Lisbon weekend',
      createdAt: CREATED,
      companion: 'Pip',
      messages: chatMessages(CHAT).map((m) => ({ role: m.role, text: m.text, at: m.at })),
    })
    const imported = parseAtelierExport(markdown)
    expect(imported?.source).toBe('atelier')
    expect(imported?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(imported?.messages[2]?.text).toBe('And food?\n### You\nis a heading in my text')
  })

  it('refuses text that is not an Atelier export, or from a newer version', () => {
    expect(parseAtelierChatMarkdown('# Just notes')).toBeNull()
    expect(parseAtelierChatMarkdown('---\natelier_export: skill\nversion: 1\n---\n')).toBeNull()
    expect(parseAtelierChatMarkdown(`---\natelier_export: chat\nversion: ${ATELIER_CHAT_EXPORT_VERSION + 1}\n---\n`)).toBeNull()
  })

  it('shows an expanded skill as its /command, and copies as plain text', () => {
    const skill = view([{ type: 'user-message', id: 'u', text: '<skill name="tidy">Do the tidy steps</skill> my tabs' }, { type: 'text-delta', turnId: 't1', text: 'Done.' }])
    expect(chatMessages(skill)[0]?.text).toBe('/tidy my tabs')
    expect(chatToText(skill, { companionName: 'Pip' })).toBe('Lisbon weekend\n\nYou:\n/tidy my tabs\n\nPip:\nDone.\n')
  })
})

describe('the HTML template', () => {
  it('is a script-free document with escaped text and a strict policy', () => {
    const html = htmlDocument({ title: 'A <b> & "c"', meta: 'Pip', sections: [{ heading: 'You', markdown: '<script>alert(1)</script> **hi**', tone: 'you' }] })
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true)
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`)
    expect(html).toContain('<title>A &lt;b&gt; &amp; &quot;c&quot;</title>')
    expect(html).toContain('<section class="you"><h2>You</h2>')
    expect(html).toContain('<strong>hi</strong>')
    expect(html).not.toMatch(/<script>/i)
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;')
    expect(markdownDocument('Skill', 'Body')).not.toContain('<h2></h2>')
  })
})

function fakeDeps(over: Partial<ExporterDeps> = {}): ExporterDeps & { files: Map<string, string | Uint8Array>; opened: string[]; revealed: string[] } {
  const files = new Map<string, string | Uint8Array>()
  const opened: string[] = []
  const revealed: string[] = []
  return {
    files,
    opened,
    revealed,
    documentsDir: () => '/docs',
    saveDialog: async ({ defaultPath }) => defaultPath,
    folderDialog: async () => '/out',
    writeFile: (path, data) => void files.set(path, data),
    exists: (path) => files.has(path) || path === '/out' || path === join('/out', 'Taken.md'),
    pdf: async (html) => new TextEncoder().encode(`PDF:${html.length}`),
    print: async () => undefined,
    openExternal: (url) => void opened.push(url),
    showItemInFolder: (path) => void revealed.push(path),
    ...over,
  }
}

describe('the exporter service', () => {
  registerExportSource('skill', { title: (id) => (id === 'two' ? 'Taken' : `Skill ${id}`), markdown: (id) => `# Skill ${id}\n\nSteps.` })

  it('offers formats only for kinds with a source', () => {
    const exporter = createExporter(fakeDeps())
    expect(exporter.formats('skill')).toEqual(['text', 'markdown', 'html', 'pdf'])
    expect(exporter.formats('transcript')).toEqual([])
    expect(() => exporter.copyText('transcript', 'x')).toThrow()
  })

  it('saves one item through the save dialog, and reveals only what it saved', async () => {
    const deps = fakeDeps()
    const exporter = createExporter(deps)
    const path = await exporter.save('skill', ['one'], 'markdown')
    expect(dirname(path ?? '')).toBe(join('/docs'))
    expect(basename(path ?? '')).toMatch(/.+\.md$/)
    expect(deps.files.get(path ?? '')).toBe('# Skill one\n\nSteps.')
    exporter.reveal(path ?? '')
    expect(deps.revealed).toEqual([path])
    expect(() => exporter.reveal('/etc/passwd')).toThrow()
    const pdf = await exporter.save('skill', ['one'], 'pdf')
    expect(new TextDecoder().decode(deps.files.get(pdf ?? '') as Uint8Array)).toMatch(/^PDF:\d+$/)
  })

  it('resolves null when the dialog is cancelled', async () => {
    const exporter = createExporter(fakeDeps({ saveDialog: async () => null, folderDialog: async () => null }))
    expect(await exporter.save('skill', ['one'], 'html')).toBeNull()
    expect(await exporter.save('skill', ['one', 'two'], 'html')).toBeNull()
  })

  it('saves several items into a folder, one file each, never overwriting', async () => {
    const deps = fakeDeps()
    const exporter = createExporter(deps)
    expect(await exporter.save('skill', ['one', 'two', 'one'], 'markdown')).toBe('/out')
    expect([...deps.files.keys()].sort()).toEqual(['Skill one 2.md', 'Skill one.md', 'Taken 2.md'].map((name) => join('/out', name)))
  })

  it('opens a mail draft with the text inline, shortened past the limit with a note', () => {
    const deps = fakeDeps()
    createExporter(deps).mailDraft('skill', 'one')
    expect(deps.opened[0]).toBe(`mailto:?subject=${encodeURIComponent('Skill one')}&body=${encodeURIComponent('# Skill one\n\nSteps.')}`)
    const long = mailtoUrl('Long', 'word '.repeat(2000), '[Shortened]')
    expect(long.length).toBeLessThanOrEqual(MAILTO_MAX)
    expect(decodeURIComponent(long)).toMatch(/word\n\n\[Shortened\]$/)
    expect(mailtoUrl('Short', 'hi', '[x]')).toBe('mailto:?subject=Short&body=hi')
  })

  it('names files without clashing', () => {
    const taken = new Set(['a.md', 'a 2.md'])
    expect(uniqueName('a.md', (n) => taken.has(n))).toBe('a 3.md')
    expect(uniqueName('b.md', (n) => taken.has(n))).toBe('b.md')
  })
})

describe('the chat export source', () => {
  it('exports saved chats with the companion’s name, and refuses drafts', () => {
    const views: Record<string, View> = { c1: CHAT, d1: view([], { draft: true, title: 'New chat' }) }
    registerChatExportSource({ view: (id) => views[id] as View, companionName: () => 'Pip' })
    const exporter = createExporter(fakeDeps())
    expect(exporter.copyText('chat', 'c1')).toBe(chatToText(CHAT, { companionName: 'Pip' }))
    expect(() => exporter.copyText('chat', 'd1')).toThrow()
  })

  it('lists children oldest first and moves chats into a project', () => {
    const update = vi.fn()
    const chats = [
      { id: 'b', parentChatId: 'p', createdAt: 2 },
      { id: 'a', parentChatId: 'p', createdAt: 1 },
      { id: 'c', parentChatId: null, createdAt: 0 },
    ] as unknown as ReturnType<Parameters<typeof chatsProjectMethods>[0]['list']>
    const methods = chatsProjectMethods({ list: () => chats, update })
    expect(methods.children('p').map((c) => c.id)).toEqual(['a', 'b'])
    methods.setProject('a', 'proj')
    methods.setProject(['a', 'b'], null)
    expect(update.mock.calls).toEqual([[['a'], { projectId: 'proj' }], [['a', 'b'], { projectId: null }]])
  })

  it('silences chat notifications while chat sounds play', () => {
    expect(chatNotificationSilent({ chatSounds: true }, 'needs-you')).toBe(true)
    expect(chatNotificationSilent({ chatSounds: true }, 'chat-updates')).toBe(true)
    expect(chatNotificationSilent({ chatSounds: false }, 'needs-you')).toBe(false)
    expect(chatNotificationSilent({ chatSounds: true }, 'downloads' as never)).toBe(false)
  })
})

describe('the export dialog’s choices', () => {
  it('gives one item every action, several only the saves', () => {
    const all = ['text', 'markdown', 'html', 'pdf'] as const
    expect(exportActions(all, 1)).toEqual({ saves: ['markdown', 'html', 'pdf'], copy: true, print: true, mail: true })
    expect(exportActions(all, 3)).toEqual({ saves: ['markdown', 'html', 'pdf'], copy: false, print: false, mail: false })
    expect(exportActions([], 1)).toEqual({ saves: [], copy: false, print: false, mail: false })
    expect(exportedName('/Users/me/Documents/Lisbon weekend.md')).toBe('Lisbon weekend.md')
  })
})
