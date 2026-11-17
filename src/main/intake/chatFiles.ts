/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachmentKind, AttachmentRef } from '@shared/attachments'
import { CHAT_FILE_FOLDERS, type ChatFileEntry, type ChatFileFolder } from '@shared/chatContext'
import type { LibraryFileRef } from '@shared/files'
import type { AgentEvent } from '@shared/ipc'
import { mainT } from '../i18n/mainT'
import { previewableOf } from './detect'
import { cleanName, excerpt } from './text'
import type { ChatFilesReader } from './types'

// The chat files browser's data (CH-28): virtual folders computed from the
// chat record and the stores, never copied. tabs holds page text the agent
// read; attachments the files, images, pastes, selections, chats and
// meetings; messages one .md per message; tool-results one file per result;
// context the attached tabs, skills and connector records; generated the
// Library files the chat produced. Only attachments are real files.

/** Text over this is cut, with `truncated` set; binary files over the other cap aren't sent at all. */
export const READ_TEXT_MAX = 1_000_000
export const READ_BINARY_MAX = 10_000_000

export interface ChatFilesDeps {
  /** The saved chat: its API history and event log; null for a draft or a missing chat. */
  load(chatId: string): { messages: readonly unknown[]; log: readonly AgentEvent[]; updatedAt: number } | null
  attachments(chatId: string): { ref: AttachmentRef; messageId: string | null; createdAt: number; folder: string; hasOriginal: boolean }[]
  attachmentText(chatId: string, id: string): string | null
  generated(chatId: string): LibraryFileRef[]
}

/** One virtual file and how to get its content. */
interface VirtualFile {
  entry: ChatFileEntry
  text?: () => string
  /** A real file on disk: read for binary previews, and revealable. */
  path?: string
}

const CONTEXT_KINDS: ReadonlySet<AttachmentKind> = new Set(['tab', 'skill', 'connector-record'])

const pad = (n: number): string => String(n).padStart(2, '0')

function textEntry(folder: ChatFileFolder, path: string, name: string, text: string, mediaType: string, modifiedAt: number): VirtualFile {
  const size = Buffer.byteLength(text)
  return {
    entry: { path, name, folder, kind: 'file', size, chars: text.length, mediaType, previewable: previewableOf(mediaType, size), revealable: false, modifiedAt },
    text: () => text,
  }
}

type Block = Record<string, unknown>
const blocksOf = (message: unknown): Block[] => {
  const content = (message as { content?: unknown })?.content
  return Array.isArray(content) ? (content.filter((b) => typeof b === 'object' && b !== null) as Block[]) : []
}

/** A tool result's content as text, or as JSON when it is structured. */
function resultContent(content: unknown): { text: string; json: boolean } | null {
  if (typeof content === 'string') return content.trim() ? { text: content, json: false } : null
  if (Array.isArray(content)) {
    const texts = content.filter((b): b is Block => typeof b === 'object' && b !== null && (b as Block).type === 'text').map((b) => String(b.text ?? ''))
    if (texts.length > 0) return { text: texts.join('\n\n'), json: false }
    // Screenshots alone have no text to show here.
    if (content.every((b) => (b as Block)?.type === 'image')) return null
  }
  if (content === undefined || content === null) return null
  return { text: JSON.stringify(content, null, 2), json: true }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** Every virtual file of a chat, folder by folder. */
export function chatManifest(chatId: string, deps: ChatFilesDeps): VirtualFile[] {
  const files: VirtualFile[] = []
  const chat = deps.load(chatId)
  const updatedAt = chat?.updatedAt ?? 0

  // tabs and tool-results come from the API history, where results are whole.
  if (chat) {
    const uses = new Map<string, { name: string; toolset: string | null; input: Block }>()
    const tabUrls = new Map<string, string>()
    let tabN = 0
    let resultN = 0
    for (const message of chat.messages) {
      for (const block of blocksOf(message)) {
        const type = String(block.type ?? '')
        if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
          const input = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Block
          const name = String(block.name ?? 'tool')
          uses.set(String(block.id), { name, toolset: typeof block.toolset_name === 'string' ? block.toolset_name : null, input })
          if (name === 'navigate' && typeof input.url === 'string' && typeof input.tab_id === 'string') tabUrls.set(input.tab_id, input.url)
          continue
        }
        if (type !== 'tool_result' && !type.endsWith('_tool_result')) continue
        const use = uses.get(String(block.tool_use_id))
        const toolName = use?.name ?? type.replace(/_tool_result$/, '')
        const content = block.content as Block | undefined
        // A fetched page and page text are pages the chat read: the tabs folder.
        if (type === 'web_fetch_tool_result' && content?.type === 'web_fetch_result') {
          const doc = content.content as Block | undefined
          const data = (doc?.source as Block | undefined)?.data
          if (typeof data === 'string') {
            const url = String(content.url ?? '')
            files.push(textEntry('tabs', `tabs/${String(block.tool_use_id)}`, `${pad(++tabN)} ${cleanName(hostOf(url))}.txt`, `${url}\n\n${data}`, 'text/plain', updatedAt))
            continue
          }
        }
        const result = resultContent(block.content)
        if (!result) continue
        if (toolName === 'get_page_text' && use?.toolset) {
          const url = typeof use.input.tab_id === 'string' ? tabUrls.get(use.input.tab_id) : undefined
          const label = url ? hostOf(url) : mainT('intake.name.untitled')
          files.push(textEntry('tabs', `tabs/${String(block.tool_use_id)}`, `${pad(++tabN)} ${cleanName(label)}.txt`, url ? `${url}\n\n${result.text}` : result.text, 'text/plain', updatedAt))
          continue
        }
        const ext = result.json ? 'json' : 'txt'
        files.push(textEntry('tool-results', `tool-results/${String(block.tool_use_id)}`, `${pad(++resultN)} ${cleanName(toolName)}.${ext}`, result.text, result.json ? 'application/json' : 'text/plain', updatedAt))
      }
    }

    // messages: one Markdown file per message, from the event log.
    let n = 0
    let reply: { turnId: string; text: string } | null = null
    const flush = (): void => {
      if (reply && reply.text.trim()) files.push(textEntry('messages', `messages/${pad(++n)}`, `${pad(n)} ${mainT('intake.files.reply')}.md`, reply.text.trim(), 'text/markdown', updatedAt))
      reply = null
    }
    for (const event of chat.log) {
      if (event.type === 'user-message') {
        flush()
        const names = (event.attachments ?? []).map((a) => `- ${a.name}`)
        const text = names.length > 0 ? `${event.text}\n\n${names.join('\n')}` : event.text
        files.push(textEntry('messages', `messages/${pad(++n)}`, `${pad(n)} ${mainT('intake.files.you')}.md`, text, 'text/markdown', updatedAt))
      } else if (event.type === 'text-delta') {
        if (reply && reply.turnId !== event.turnId) flush()
        reply ??= { turnId: event.turnId, text: '' }
        reply.text += event.text
      }
    }
    flush()
  }

  // attachments and context: the store's own folders, the only real files.
  for (const a of deps.attachments(chatId)) {
    if (a.ref.state !== 'ready') continue
    const folder: ChatFileFolder = CONTEXT_KINDS.has(a.ref.kind) ? 'context' : 'attachments'
    const path = `${folder}/${a.ref.id}`
    const text = deps.attachmentText(chatId, a.ref.id)
    const textual = a.ref.kind !== 'image' && a.ref.kind !== 'pdf' && a.ref.kind !== 'office'
    if (textual) {
      const mediaType = a.ref.kind === 'text' ? a.ref.mediaType : a.ref.kind === 'chat' || a.ref.kind === 'skill' ? 'text/markdown' : 'text/plain'
      const name = a.ref.kind === 'text' ? a.ref.name : `${excerpt(a.ref.name, 80)}${mediaType === 'text/markdown' ? '.md' : '.txt'}`
      files.push(textEntry(folder, path, name, text ?? '', mediaType, a.createdAt))
      continue
    }
    const original = join(a.folder, 'original')
    let size = a.ref.size
    try {
      if (a.hasOriginal) size = statSync(original).size
    } catch {
      // Pruned or removed since: the ref's size stands.
    }
    files.push({
      entry: { path, name: a.ref.name, folder, kind: 'file', size, chars: null, mediaType: a.ref.mediaType, previewable: a.hasOriginal ? previewableOf(a.ref.mediaType, size) : 'unknown', revealable: a.hasOriginal, modifiedAt: a.createdAt },
      ...(a.hasOriginal ? { path: original } : {}),
    })
  }

  for (const g of deps.generated(chatId)) {
    files.push({ entry: { path: `generated/${g.id}`, name: g.name, folder: 'generated', kind: 'file', size: g.size, chars: null, mediaType: g.mediaType, previewable: previewableOf(g.mediaType, g.size), revealable: false, modifiedAt: g.createdAt } })
  }
  return files
}

/** The service and main-side reader over the manifest. */
export function chatFilesReader(deps: ChatFilesDeps, reveal: (path: string) => void): ChatFilesReader & { reveal(chatId: string, path: string): void; count(chatId: string): number } {
  const find = (chatId: string, path: string): VirtualFile => {
    const file = chatManifest(chatId, deps).find((f) => f.entry.path === path)
    if (!file) throw new Error(mainT('intake.files.missing'))
    return file
  }
  return {
    list(chatId, folder) {
      const files = chatManifest(chatId, deps)
      if (folder === '') {
        // The folders that hold something, in their fixed order.
        return CHAT_FILE_FOLDERS.flatMap((name): ChatFileEntry[] => {
          const inside = files.filter((f) => f.entry.folder === name)
          if (inside.length === 0) return []
          const size = inside.reduce((sum, f) => sum + f.entry.size, 0)
          const modifiedAt = Math.max(...inside.map((f) => f.entry.modifiedAt))
          return [{ path: name, name, folder: name, kind: 'folder', size, chars: null, mediaType: 'inode/directory', previewable: 'unknown', revealable: false, modifiedAt }]
        })
      }
      return files.filter((f) => f.entry.folder === folder).map((f) => f.entry)
    },
    read(chatId, path) {
      const file = find(chatId, path)
      if (file.entry.folder === 'generated') throw new Error(mainT('intake.files.generatedRead'))
      if (file.text) {
        const text = file.text()
        return text.length > READ_TEXT_MAX ? { text: text.slice(0, READ_TEXT_MAX), truncated: true } : { text, truncated: false }
      }
      if (!file.path || file.entry.size > READ_BINARY_MAX) return { truncated: file.entry.size > READ_BINARY_MAX }
      const bytes = readFileSync(file.path)
      return { dataUrl: `data:${file.entry.mediaType};base64,${bytes.toString('base64')}`, truncated: false }
    },
    physicalPath(chatId, path) {
      const file = chatManifest(chatId, deps).find((f) => f.entry.path === path)
      return file?.path ?? null
    },
    reveal(chatId, path) {
      const file = find(chatId, path)
      if (!file.path) throw new Error(mainT('intake.files.notPhysical'))
      reveal(file.path)
    },
    count(chatId) {
      return chatManifest(chatId, deps).length
    },
  }
}
