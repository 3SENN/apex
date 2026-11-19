/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import type { PreparedAttachment } from '../../../../src/main/intake/types'
import type { UserBlock } from '../../../../src/main/agent/attachments'
import { readAttachment as read, skillText } from '../../../../src/main/agent/content'
import { log } from '../../../../src/main/log'
import { mainT } from '../../../../src/main/i18n/mainT'
import { extractOfficeText, officeKindOf } from './officeText'
import { pdfBlock, type LineBlock } from './streamJson' // PDFs as documents

// A message's prepared attachments as Claude Code's stream-json input
// (AgentBackend.attachmentBlocks): images as base64, everything else as
// extracted text, office files included (read on this computer, see
// officeText.ts); with Files and documents on, a copy of each file also goes
// into the chat's own folder for code to use (documentsWorkspace.ts).

const escapeAttr = (value: string): string => value.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c] ?? c)

export interface ClaudeCodeBlockContext {
  skill(skillId: string): { name: string; instructions: string } | null
  readFile?(path: string): Buffer
  /**
   * Set for chats with Files and documents on. Copies an attachment
   * into the chat's folder and returns its path there (`inputs/Name.docx`).
   */
  toWorkspace?(name: string, sourcePath: string): string
}

/** The name a file's workspace copy gets: images carry the extension of the format the intake saved them in. */
function workspaceName(name: string, payload: PreparedAttachment['payload']): string {
  if (payload.type !== 'image') return name || (payload.type === 'pdf' ? 'Document.pdf' : 'File')
  const ext = payload.mediaType === 'image/png' ? '.png' : '.jpg'
  const stem = (name || 'Image').replace(/\.[A-Za-z0-9]{1,5}$/, '')
  return `${stem}${ext}`
}

/** The attachment's copy in the chat's folder, or null (no folder, or the copy failed: the message still goes). */
function workspaceCopy(ctx: ClaudeCodeBlockContext, name: string, sourcePath: string): string | null {
  if (!ctx.toWorkspace) return null
  try {
    return ctx.toWorkspace(name, sourcePath)
  } catch (err) {
    log.warn('agent', 'Could not copy an attachment into the documents folder', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** An office file as a titled <document> with its text, read on this computer. */
function officeBlock(ref: PreparedAttachment['ref'], payload: { path: string; mediaType: string }, ctx: ClaudeCodeBlockContext, copy: string | null): UserBlock {
  const name = ref.name || 'Document'
  const kind = officeKindOf(payload.mediaType, name)
  let attrs = ''
  let body: string
  try {
    if (!kind) throw new Error('unknown office kind')
    const office = extractOfficeText(read(ctx, payload.path), kind)
    attrs = ` kind="${kind}"${kind === 'xlsx' ? ` sheets="${office.parts}"` : kind === 'pptx' ? ` slides="${office.parts}"` : ''}`
    body = office.text || '(empty)'
  } catch (err) {
    log.warn('agent', 'Could not read an office file’s text', { error: err instanceof Error ? err.message : String(err) })
    // Without a folder copy there is nothing the model could use.
    if (!copy) throw new Error(mainT('engines.intake.reason.officeUnreadable', { name }))
    body = `(${BRAND_NAME} couldn’t read this file’s text here. Open the copy in your working folder with code instead.)`
  }
  return { type: 'text', text: `<document title="${escapeAttr(name)}"${attrs}${copy ? ` path="${escapeAttr(copy)}"` : ''}>\n${body}\n</document>` }
}

/**
 * The same attachments for Claude Code's stream-json input: images as
 * base64 image blocks, PDFs and text as extracted text in a titled
 * <document> wrapper, office files as their text read on this computer.
 * With Files and documents on (ctx.toWorkspace), images, PDFs and office
 * files are also copied into the chat's folder, as the API key puts them in
 * the code container.
 */
export function claudeCodeBlocks(prepared: readonly PreparedAttachment[], ctx: ClaudeCodeBlockContext): LineBlock[] /* PDFs as document blocks */ {
  const out: LineBlock[] = []
  for (const { ref, payload } of prepared) {
    const copy = payload.type === 'image' || payload.type === 'pdf' || payload.type === 'office' ? workspaceCopy(ctx, workspaceName(ref.name, payload), payload.path) : null
    switch (payload.type) {
      case 'image':
        // The intake re-encodes every image as JPEG or PNG.
        out.push({ type: 'image', source: { type: 'base64', media_type: payload.mediaType === 'image/png' ? 'image/png' : 'image/jpeg', data: read(ctx, payload.path).toString('base64') } })
        break
      case 'pdf':
        // The PDF itself, as on the API key; its extracted text when it is very large or can't be read.
        out.push(pdfBlock({ title: ref.name || 'Document.pdf', pages: payload.pages, text: payload.text, read: () => read(ctx, payload.path) }))
        break
      case 'text': {
        const url = payload.sourceUrl ?? ref.source?.url ?? null
        const quoted = ref.kind === 'selection' ? ' kind="quote from a page the user selected"' : ''
        out.push({ type: 'text', text: `<document title="${escapeAttr(payload.title || ref.name || 'Text')}"${url ? ` source="${escapeAttr(url)}"` : ''}${quoted}>\n${payload.text}\n</document>` })
        break
      }
      case 'office':
        out.push(officeBlock(ref, payload, ctx, copy))
        break
      case 'skill':
        out.push({ type: 'text', text: skillText(ctx.skill(payload.skillId), ref.name) })
        break
    }
    // Office files name their copy in the <document> itself.
    if (copy && payload.type !== 'office') out.push({ type: 'text', text: `(A copy of “${ref.name || copy}” is in your working folder at ${copy}.)` })
  }
  return out
}

