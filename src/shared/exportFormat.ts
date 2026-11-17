/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The export contract: exporting chats, skills, transcripts
// and documents (CH-36), and the Apex chat Markdown format that
// re-imports as a read-only transcript. Front matter: `apex_export: chat`,
// `version: 1`.
import type { ChatSummary, ChatView } from './chats'

export type ExportKind = 'chat' | 'skill' | 'transcript' | 'document'
export const EXPORT_KINDS = ['chat', 'skill', 'transcript', 'document'] as const satisfies readonly ExportKind[]

export type ExportFormat = 'text' | 'markdown' | 'html' | 'pdf'
export const EXPORT_FORMATS = ['text', 'markdown', 'html', 'pdf'] as const satisfies readonly ExportFormat[]

export const APEX_CHAT_EXPORT_VERSION = 1

/** What parseApexChatMarkdown recovers from an exported chat. */
export interface ParsedApexChat {
  title: string
  createdAt: number | null
  companion: string | null
  messages: Array<{ role: 'user' | 'assistant'; text: string; at: number | null }>
}

/** `ChatStore.importTranscript` input (main side). */
export interface TranscriptImport {
  title: string
  companionId: string
  imported: NonNullable<ChatSummary['imported']>
  messages: Array<{ role: 'user' | 'assistant'; text: string; at: number | null }>
}

/** One message of an exported chat, in order. */
export interface ExportMessage {
  role: 'user' | 'assistant'
  text: string
  at: number | null
}

export interface ChatExportOptions {
  /** The companion's display name for the reply headings (default "Companion"). */
  companionName?: string
}

const SKILL_BLOCK = /<skill name="([^"]+)">[\s\S]*?<\/skill>/g

/**
 * Your messages and the replies' text, in order. A reply is every text turn
 * after one message of yours, joined by a blank line; tool steps and
 * thinking are left out. Expanded skills show as their /command.
 */
export function chatMessages(view: Pick<ChatView, 'summary' | 'log' | 'details'>): ExportMessage[] {
  const out: ExportMessage[] = []
  let reply: ExportMessage | null = null
  let turn = ''
  const flush = (): void => {
    if (reply && reply.text.trim()) out.push({ ...reply, text: reply.text.trim() })
    reply = null
  }
  for (const event of view.log) {
    if (event.type === 'reset') {
      out.length = 0
      reply = null
      continue
    }
    if (event.type === 'user-message') {
      flush()
      const text = event.text.replace(SKILL_BLOCK, '/$1').trim()
      // The first message is when the chat started; later ones carry no time of their own.
      out.push({ role: 'user', text, at: out.length === 0 ? view.summary.createdAt : null })
      continue
    }
    if (event.type !== 'text-delta') continue
    reply ??= { role: 'assistant', text: '', at: null }
    if (turn !== event.turnId && reply.text.trim()) reply.text = `${reply.text.trimEnd()}\n\n`
    turn = event.turnId
    reply.text += event.text
    reply.at = view.details[event.turnId]?.at ?? reply.at
  }
  flush()
  return out
}

const iso = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString())

/** A heading line that would start a section: "### You" or "### <companion>", with an optional " · <ISO time>". */
function speakerOf(line: string, names: readonly string[]): string | null {
  const match = /^### (.+?)(?: · (\d{4}-\d\d-\d\dT[\d:.]+Z))?$/.exec(line)
  const name = match?.[1]
  return name !== undefined && names.includes(name) ? name : null
}

/** Body lines that look like a section heading get one more leading backslash, so they never split a message. */
function escapeBody(text: string, names: readonly string[]): string {
  return text
    .split('\n')
    .map((line) => (speakerOf(line.replace(/^\\+/, ''), names) ? `\\${line}` : line))
    .join('\n')
}

function unescapeBody(line: string, names: readonly string[]): string {
  return /^\\+/.test(line) && speakerOf(line.replace(/^\\+/, ''), names) ? line.slice(1) : line
}

/** A one-line YAML value: JSON's double-quoted strings are valid YAML. */
const yaml = (value: string | number | null): string => (value === null ? 'null' : typeof value === 'number' ? String(value) : JSON.stringify(value))

/** A chat as Markdown with Apex front matter (`apex_export: chat`, `version: 1`), then `### You` and `### <companion>` sections. */
export function chatToMarkdown(view: Pick<ChatView, 'summary' | 'log' | 'details'>, options: ChatExportOptions = {}): string {
  const companion = options.companionName?.trim() || 'Companion'
  const names = ['You', companion]
  const lines = [
    '---',
    'apex_export: chat',
    `version: ${APEX_CHAT_EXPORT_VERSION}`,
    `title: ${yaml(view.summary.title)}`,
    `createdAt: ${yaml(iso(view.summary.createdAt))}`,
    `companion: ${yaml(companion)}`,
    '---',
    '',
    `# ${view.summary.title.replace(/\n/g, ' ')}`,
  ]
  for (const message of chatMessages(view)) {
    const at = iso(message.at)
    lines.push('', `### ${message.role === 'user' ? 'You' : companion}${at ? ` · ${at}` : ''}`, '', escapeBody(message.text, names))
  }
  return `${lines.join('\n')}\n`
}

/** The chat as plain text, for Copy and the mail draft. */
export function chatToText(view: Pick<ChatView, 'summary' | 'log' | 'details'>, options: ChatExportOptions = {}): string {
  const companion = options.companionName?.trim() || 'Companion'
  const parts = [view.summary.title, '']
  for (const message of chatMessages(view)) parts.push(`${message.role === 'user' ? 'You' : companion}:`, message.text, '')
  return `${parts.join('\n').trimEnd()}\n`
}

function frontMatter(lines: readonly string[]): { values: Map<string, string>; end: number } | null {
  if (lines[0]?.trim() !== '---') return null
  const values = new Map<string, string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') return { values, end: i }
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (match?.[1]) values.set(match[1], match[2] ?? '')
  }
  return null
}

/** A YAML scalar as written by `yaml` (or plain). */
function scalar(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const value = raw.trim()
  if (value === '' || value === 'null' || value === '~') return null
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  return value.replace(/^'(.*)'$/, '$1')
}

const timeOf = (raw: string | null | undefined): number | null => {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/** Reads an Apex chat export back, or null when the text is not one (or from a newer version). */
export function parseApexChatMarkdown(text: string): ParsedApexChat | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const head = frontMatter(lines)
  if (!head || scalar(head.values.get('apex_export')) !== 'chat') return null
  const version = Number(scalar(head.values.get('version')))
  if (!Number.isInteger(version) || version < 1 || version > APEX_CHAT_EXPORT_VERSION) return null
  const companion = scalar(head.values.get('companion'))
  const names = ['You', companion?.trim() || 'Companion']
  const messages: ParsedApexChat['messages'] = []
  let current: { role: 'user' | 'assistant'; body: string[]; at: number | null } | null = null
  const flush = (): void => {
    if (!current) return
    const body = current.body.join('\n').trim()
    if (body) messages.push({ role: current.role, text: body, at: current.at })
    current = null
  }
  for (const line of lines.slice(head.end + 1)) {
    const speaker = speakerOf(line, names)
    if (speaker) {
      flush()
      const stamp = /· (\S+)$/.exec(line)?.[1]
      current = { role: speaker === 'You' ? 'user' : 'assistant', body: [], at: timeOf(stamp) }
    } else if (current) {
      current.body.push(unescapeBody(line, names))
    }
  }
  flush()
  const title = scalar(head.values.get('title'))?.trim() || 'Imported chat'
  return { title, createdAt: timeOf(scalar(head.values.get('createdAt'))), companion, messages }
}


export interface ExporterService {
  formats(kind: ExportKind): ExportFormat[]
  copyText(kind: ExportKind, id: string): string
  /** Saves through a save dialog (a folder for several ids); resolves to the path, or null when cancelled. */
  save(kind: ExportKind, ids: string[], format: ExportFormat): Promise<string | null>
  print(kind: ExportKind, id: string): Promise<void>
  mailDraft(kind: ExportKind, id: string): void
  reveal(path: string): void
}

/** Methods the export feature adds to the `chats` namespace. */
export interface ChatsProjectMethods {
  setProject(ids: string | string[], projectId: string | null): void
  /** A parent's delegated children, hidden from every other list. */
  children(parentId: string): ChatSummary[]
}

export interface ChatToolsServices {
  exporter: ExporterService
}
