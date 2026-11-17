/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LogItem } from '../../agentLog'
import { markdownText, parseMarkdown, type Block, type Inline, type ListItem } from './markdown'

// DS-63: when a finished reply ends by asking you something in plain text,
// the question block under it offers a typed or spoken answer. The question
// is lifted out of the reply's text, so it shows once: in the block, as the
// turn's last content. Pure, so the rules are tested.

/** Longest question the block repeats; longer ones are not lifted out. */
export const ASK_MAX = 240
/** Longest lead-in that moves under the question as its description. */
export const ASK_DETAIL_MAX = 240

/** The reply's closing question (its last sentence, ending in "?"), or null. */
export function trailingQuestion(plainText: string): string | null {
  const text = plainText.trim()
  if (!text.endsWith('?')) return null
  const lastLine = text.split('\n').filter((l) => l.trim()).pop()?.trim() ?? ''
  // The last sentence: after the final ., ! or ? that closes an earlier sentence.
  const match = /(?:^|[.!?]\s+)([^.!?]*\?)$/.exec(lastLine)
  const question = (match?.[1] ?? lastLine).replace(/^[-*>\d.\s]+/, '').trim()
  return question.length > 1 && question.length <= ASK_MAX ? question : null
}

/** Whether the block shows: the chat's last reply, nothing running, and no card already asking (a question card, or an error). Next steps follow the block. */
export function showsAskBlock(input: { last: boolean; running: boolean; items: readonly LogItem[] }): boolean {
  if (!input.last || input.running) return false
  return !input.items.some((i) => i.kind === 'question' || (i.kind === 'notice' && i.tone === 'error'))
}

export interface LiftedQuestion {
  question: string
  /** The closing paragraph's lead-in, shown muted under the question; null when it stays in the text. */
  detail: string | null
  /** The reply's blocks without the question. */
  blocks: Block[]
}

const inlineText = (nodes: readonly Inline[]): string => markdownText([{ kind: 'paragraph', children: [...nodes] }])

const hasLink = (nodes: readonly Inline[]): boolean => nodes.some((n) => n.kind === 'link' || ((n.kind === 'strong' || n.kind === 'em' || n.kind === 'del') && hasLink(n.children)))

/** Drops the last `count` characters of plain text from an inline tree. */
function dropTail(nodes: readonly Inline[], count: number): { nodes: Inline[]; left: number } {
  const out = [...nodes]
  let left = count
  while (out.length > 0 && left > 0) {
    const node = out[out.length - 1] as Inline
    if (node.kind === 'text' || node.kind === 'code') {
      if (node.text.length <= left) {
        left -= node.text.length
        out.pop()
      } else {
        out[out.length - 1] = { ...node, text: node.text.slice(0, node.text.length - left) }
        left = 0
      }
    } else if (node.kind === 'br') {
      left -= 1
      out.pop()
    } else {
      const inner = dropTail(node.children, left)
      left = inner.left
      if (inner.nodes.length === 0) out.pop()
      else out[out.length - 1] = { ...node, children: inner.nodes }
    }
  }
  // Trailing spaces and line breaks the cut leaves behind.
  for (;;) {
    const tail = out[out.length - 1]
    if (tail?.kind === 'br') out.pop()
    else if (tail?.kind === 'text' && !tail.text.trimEnd()) out.pop()
    else if (tail?.kind === 'text' && tail.text !== tail.text.trimEnd()) out[out.length - 1] = { ...tail, text: tail.text.trimEnd() }
    else break
  }
  return { nodes: out, left }
}

/** Splits a paragraph's closing question off: what stays, the lead-in text, and the question. */
function splitParagraph(children: readonly Inline[]): { question: string; lead: string; rest: Inline[] } | null {
  const plain = inlineText(children)
  const question = trailingQuestion(plain)
  if (!question) return null
  const trimmed = plain.trimEnd()
  if (!trimmed.endsWith(question)) return null
  const lead = trimmed.slice(0, trimmed.length - question.length).trim()
  const rest = dropTail(children, plain.length - trimmed.length + question.length).nodes
  return { question, lead, rest }
}

/**
 * Lifts a finished reply's closing question out of its Markdown. A closing
 * paragraph's short lead-in becomes the description, unless the paragraph is
 * the whole reply or holds a link. A question in a list's last item is cut
 * from that item. Anything else (code, a table, a heading) is left alone.
 */
export function liftClosingQuestion(blocks: readonly Block[]): LiftedQuestion | null {
  const last = blocks[blocks.length - 1]
  const before = blocks.slice(0, -1)
  if (last?.kind === 'paragraph') {
    const split = splitParagraph(last.children)
    if (!split) return null
    const movesLead = split.lead === '' || (before.length > 0 && split.lead.length <= ASK_DETAIL_MAX && !split.lead.includes('\n') && !hasLink(last.children))
    if (movesLead) return { question: split.question, detail: split.lead || null, blocks: before }
    return { question: split.question, detail: null, blocks: [...before, { kind: 'paragraph', children: split.rest }] }
  }
  if (last?.kind === 'list') {
    const item = last.items[last.items.length - 1]
    const para = item?.children[item.children.length - 1]
    if (!item || para?.kind !== 'paragraph') return null
    const split = splitParagraph(para.children)
    if (!split) return null
    const children: Block[] = split.rest.length > 0 ? [...item.children.slice(0, -1), { kind: 'paragraph', children: split.rest }] : item.children.slice(0, -1)
    const items: ListItem[] = children.length > 0 ? [...last.items.slice(0, -1), { ...item, children }] : last.items.slice(0, -1)
    return { question: split.question, detail: null, blocks: items.length > 0 ? [...before, { ...last, items }] : before }
  }
  return null
}

export interface ClosingAsk extends LiftedQuestion {
  /** The assistant item whose text the question came from. */
  itemId: string
}

/** The question block a finished reply ends with: its question, description and the trimmed text of the item it came from. */
export function closingAsk(input: { last: boolean; running: boolean; items: readonly LogItem[] }): ClosingAsk | null {
  if (!showsAskBlock(input)) return null
  for (let i = input.items.length - 1; i >= 0; i--) {
    const item = input.items[i]
    if (item?.kind !== 'assistant' || !item.text.trim()) continue
    const lifted = liftClosingQuestion(parseMarkdown(item.text))
    return lifted ? { ...lifted, itemId: item.id } : null
  }
  return null
}
