/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'
import type { ExportFormat } from '@shared/exportFormat'
import { chatUrl } from '@shared/url'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// Chat: request and inline cards, find in chat, export and import, bulk actions, the preview pane, the chat-list popover, tips and sounds.
// Offline only: chats come from importTranscript (no model turn), the
// exporter is asked for text and formats (never a save dialog), and every
// check removes what it made. Shots cover the imported banner, find, All
// chats in selection mode, the preview pane and the sounds card, in light
// and dark.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function imported(ctx: SmokeContext, title: string): ChatSummary {
  return ctx.chats.importTranscript({
    title,
    companionId: ctx.chats.list()[0]?.companionId ?? 'default',
    imported: { source: 'apex', originalTitle: title, originalCreatedAt: Date.UTC(2026, 0, 2), importedAt: 0 },
    messages: [
      { role: 'user', text: 'Which beaches near Lisbon are quiet in May?', at: Date.UTC(2026, 0, 2, 9) },
      { role: 'assistant', text: 'Try **Praia da Ursa** and Adraga; both are calm on weekdays.', at: Date.UTC(2026, 0, 2, 9, 1) },
    ],
  })
}

export const checks: SmokeCheck[] = [
  {
    name: 'an imported transcript is listed, searchable, exportable as text and leaves the default list when asked',
    async run(ctx) {
      const chat = imported(ctx, 'Smoke chat import')
      try {
        const formats = await ctx.chrome.invoke<ExportFormat[]>('exporter', 'formats', 'chat')
        assert(['text', 'markdown', 'html', 'pdf'].every((f) => formats.includes(f as ExportFormat)), `formats: ${formats.join(', ')}`)
        const text = await ctx.chrome.invoke<string>('exporter', 'copyText', 'chat', chat.id)
        assert(text.includes('Praia da Ursa') && text.includes('Which beaches'), 'the copied text misses the messages')
        const found = await ctx.chrome.invoke<ChatSummary[]>('chats', 'list', { query: 'adraga' })
        assert(found.some((c) => c.id === chat.id), 'the imported chat is not searchable')
        const without = await ctx.chrome.invoke<ChatSummary[]>('chats', 'list', { imported: 'exclude' })
        assert(!without.some((c) => c.id === chat.id), 'imported: exclude still lists it')
        let refused = false
        await ctx.chrome.invoke('exporter', 'reveal', '/etc/hosts').catch(() => (refused = true))
        assert(refused, 'reveal opened a path this session never saved')
      } finally {
        ctx.chats.remove([chat.id])
      }
    },
  },
  {
    name: 'Move to project and the children listing',
    async run(ctx) {
      const chat = imported(ctx, 'Smoke chat project')
      try {
        await ctx.chrome.invoke('chats', 'setProject', [chat.id], 'smoke-project')
        const inProject = await ctx.chrome.invoke<ChatSummary[]>('chats', 'list', { projectId: 'smoke-project' })
        assert(inProject.length === 1 && inProject[0]?.id === chat.id, 'setProject did not move the chat')
        await ctx.chrome.invoke('chats', 'setProject', chat.id, null)
        assert(ctx.chats.summary(chat.id)?.projectId === null, 'setProject(null) did not clear it')
        const children = await ctx.chrome.invoke<ChatSummary[]>('chats', 'children', chat.id)
        assert(Array.isArray(children) && children.length === 0, 'a chat without sub-tasks lists children')
      } finally {
        ctx.chats.remove([chat.id])
      }
    },
  },
  {
    name: '⌘F on a chat page opens the find bar and counts matches; the composer is hidden for a transcript',
    async run(ctx) {
      const chat = imported(ctx, 'Smoke chat find')
      try {
        ctx.tabs.openInternal(chatUrl(chat.id))
        await ctx.chrome.until(`return document.querySelector('.cd-banner--imported')`, 8000, 'the imported banner')
        assert(!(await ctx.chrome.js<boolean>(`return !!document.querySelector('.chat-view--page .chat-composer')`)), 'an imported chat shows a composer')
        await ctx.chrome.js(`document.querySelector('.chat-view--page')?.focus(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: false, bubbles: true }))`)
        await ctx.chrome.until(`return document.querySelector('.cd-find .cd-find__field')`, 5000, 'the find bar')
        await ctx.chrome.js(`const f = document.querySelector('.cd-find__field'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(f, 'adraga'); f.dispatchEvent(new Event('input', { bubbles: true }))`)
        await ctx.chrome.until(`return /1/.test(document.querySelector('.cd-find__count')?.textContent ?? '')`, 5000, 'the match count')
      } finally {
        ctx.chats.remove([chat.id])
      }
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'chat-imported',
    async run(ctx) {
      const chat = imported(ctx, 'Smoke chat shot')
      try {
        ctx.tabs.openInternal(chatUrl(chat.id))
        await ctx.chrome.until(`return document.querySelector('.cd-banner--imported')`, 8000, 'the imported banner')
        await ctx.shot('chat-imported')
      } finally {
        ctx.chats.remove([chat.id])
      }
    },
  },
  {
    name: 'allchats-select',
    async run(ctx) {
      const a = imported(ctx, 'Smoke chat select one')
      const b = imported(ctx, 'Smoke chat select two')
      try {
        ctx.tabs.openInternal('apex://chats')
        await ctx.chrome.until(`return document.querySelector('.chats-row')`, 8000, 'All chats')
        // DS-101: selection lives in the page's more menu.
        await ctx.chrome.js(`document.querySelector('.chats-page__more')?.click(); return true`)
        await ctx.chrome.click(/^Select chats$/)
        await ctx.chrome.until(`return document.querySelector('.cd-bulk')`, 5000, 'the selection bar')
        await ctx.chrome.click(/^Select all$/)
        await ctx.shot('allchats-select')
        await ctx.chrome.click(/^Done$/)
        await ctx.chrome.js(`document.querySelector('.chats-row')?.click()`)
        await ctx.chrome.until(`return document.querySelector('.cd-preview .cd-preview__msg') || document.querySelector('.cd-preview__empty')`, 5000, 'the preview pane').catch(() => null)
        await ctx.shot('allchats-preview')
      } finally {
        ctx.chats.remove([a.id, b.id])
      }
    },
  },
  {
    name: 'sounds-card',
    async run(ctx) {
      ctx.tabs.openInternal('apex://settings/notifications')
      await ctx.chrome.until(`return document.querySelector('.cd-sounds__cues')`, 8000, 'the chat sounds card')
      await ctx.shot('sounds-card')
    },
  },
]
