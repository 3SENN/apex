/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Parsers for conversation exports from other assistants (CH-31, ON-10):
// ChatGPT's conversations.json (a mapping tree; the shown branch is the one
// that ends at `current_node`), Claude's conversations.json (`chat_messages`,
// with attachments), and Atelier's own Markdown chat exports. Everything here is
// pure; reading files and zips is in ./read.ts.
import type { ConversationSource } from '@shared/onboarding'
import { parseAtelierChatMarkdown } from '@shared/exportFormat'

export interface ParsedConversation {
  source: ConversationSource
  title: string
  createdAt: number | null
  messages: Array<{ role: 'user' | 'assistant'; text: string; at: number | null }>
}

/** An attachment's extracted text is kept up to this many characters. */
export const ATTACHMENT_TEXT_MAX = 4_000
const UNTITLED = 'Imported chat'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Seconds (ChatGPT), milliseconds, or an ISO string (Claude), as milliseconds. */
export function toMillis(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

// ── ChatGPT ──

interface GptNode {
  id?: unknown
  parent?: unknown
  children?: unknown
  message?: unknown
}

function gptText(message: Record<string, unknown>): string {
  const content = isObject(message.content) ? message.content : null
  if (!content) return ''
  const type = str(content.content_type)
  if (type === 'text' || type === 'multimodal_text') {
    const parts = Array.isArray(content.parts) ? content.parts : []
    return parts
      .map((p) => (typeof p === 'string' ? p : isObject(p) && typeof p.text === 'string' ? p.text : isObject(p) && str(p.content_type).includes('image') ? '[Image]' : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (type === 'code' && typeof content.text === 'string') return `\`\`\`\n${content.text}\n\`\`\``
  return ''
}

/** The branch the person last saw: from `current_node` up to the root, or the newest leaf when it is missing. */
function gptBranch(mapping: Record<string, GptNode>, current: string | null): GptNode[] {
  let leaf = current && mapping[current] ? current : null
  if (!leaf) {
    const root = Object.entries(mapping).find(([, n]) => !n.parent || !mapping[str(n.parent)])?.[0] ?? null
    let at = root
    const seen = new Set<string>()
    while (at && !seen.has(at)) {
      seen.add(at)
      const kids = Array.isArray(mapping[at]?.children) ? (mapping[at]?.children as unknown[]).map(str).filter((k) => mapping[k]) : []
      leaf = at
      at = kids[kids.length - 1] ?? null
    }
  }
  const branch: GptNode[] = []
  const seen = new Set<string>()
  let at = leaf
  while (at && mapping[at] && !seen.has(at)) {
    seen.add(at)
    const node = mapping[at] as GptNode
    branch.push(node)
    at = node.parent ? str(node.parent) : null
  }
  return branch.reverse()
}

export function parseChatGptConversation(raw: unknown): ParsedConversation | null {
  if (!isObject(raw) || !isObject(raw.mapping)) return null
  const mapping = raw.mapping as Record<string, GptNode>
  const messages: ParsedConversation['messages'] = []
  for (const node of gptBranch(mapping, typeof raw.current_node === 'string' ? raw.current_node : null)) {
    if (!isObject(node.message)) continue
    const message = node.message
    const role = isObject(message.author) ? str(message.author.role) : ''
    if (role !== 'user' && role !== 'assistant') continue
    const meta = isObject(message.metadata) ? message.metadata : {}
    if (meta.is_visually_hidden_from_conversation === true) continue
    const text = gptText(message).trim()
    if (!text) continue
    messages.push({ role, text, at: toMillis(message.create_time) })
  }
  return { source: 'chatgpt', title: str(raw.title).trim() || UNTITLED, createdAt: toMillis(raw.create_time), messages }
}

// ── Claude ──

function claudeText(message: Record<string, unknown>): string {
  const blocks = Array.isArray(message.content) ? message.content : []
  const fromBlocks = blocks
    .map((b) => (isObject(b) && b.type === 'text' ? str(b.text) : ''))
    .filter(Boolean)
    .join('\n\n')
  return fromBlocks || str(message.text)
}

function claudeAttachments(message: Record<string, unknown>): string {
  const lines: string[] = []
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  for (const a of attachments) {
    if (!isObject(a)) continue
    const name = str(a.file_name) || 'attachment'
    const body = str(a.extracted_content).trim()
    if (!body) {
      lines.push(`[Attached: ${name}]`)
      continue
    }
    const clipped = body.length > ATTACHMENT_TEXT_MAX ? `${body.slice(0, ATTACHMENT_TEXT_MAX)}\n…` : body
    lines.push(`[Attached: ${name}]\n\`\`\`\n${clipped}\n\`\`\``)
  }
  const files = Array.isArray(message.files) ? message.files : []
  for (const f of files) {
    const name = isObject(f) ? str(f.file_name) : ''
    if (name && !lines.some((l) => l.startsWith(`[Attached: ${name}]`))) lines.push(`[Attached: ${name}]`)
  }
  return lines.join('\n\n')
}

export function parseClaudeConversation(raw: unknown): ParsedConversation | null {
  if (!isObject(raw) || !Array.isArray(raw.chat_messages)) return null
  const messages: ParsedConversation['messages'] = []
  for (const m of raw.chat_messages) {
    if (!isObject(m)) continue
    const sender = str(m.sender)
    const role = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : null
    if (!role) continue
    const text = [claudeText(m).trim(), claudeAttachments(m)].filter(Boolean).join('\n\n')
    if (!text) continue
    messages.push({ role, text, at: toMillis(m.created_at) })
  }
  return { source: 'claude', title: str(raw.name).trim() || UNTITLED, createdAt: toMillis(raw.created_at), messages }
}

// ── Atelier ──

export function parseAtelierExport(text: string): ParsedConversation | null {
  const parsed = parseAtelierChatMarkdown(text)
  if (!parsed) return null
  return { source: 'atelier', title: parsed.title.trim() || UNTITLED, createdAt: parsed.createdAt, messages: parsed.messages.filter((m) => m.text.trim()) }
}

// ── Detection ──

/** Which assistant a conversations.json came from, by its shape. */
export function detectJsonSource(raw: unknown): 'chatgpt' | 'claude' | null {
  const list = Array.isArray(raw) ? raw : isObject(raw) ? [raw] : []
  const first = list.find(isObject)
  if (!first) return null
  if (isObject(first.mapping)) return 'chatgpt'
  if (Array.isArray(first.chat_messages)) return 'claude'
  return null
}

/** Every conversation in a parsed conversations.json; `bad` counts entries that couldn't be read. */
export function parseConversationsJson(raw: unknown): { conversations: ParsedConversation[]; bad: number } {
  const source = detectJsonSource(raw)
  if (!source) return { conversations: [], bad: 0 }
  const list = Array.isArray(raw) ? raw : [raw]
  const conversations: ParsedConversation[] = []
  let bad = 0
  for (const item of list) {
    const parsed = source === 'chatgpt' ? parseChatGptConversation(item) : parseClaudeConversation(item)
    if (parsed) conversations.push(parsed)
    else bad++
  }
  return { conversations, bad }
}
