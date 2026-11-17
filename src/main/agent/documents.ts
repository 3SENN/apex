/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import Anthropic from '@anthropic-ai/sdk'
import type { BetaContentBlock, BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { LibraryFileRef } from '@shared/files'
import type { LibraryFiles } from '../files/types'
import { log } from '../log'
import type { FilesApi } from './content'

// The optional Files and documents ability. A chat that
// starts with it gets code execution with Anthropic's document skills (pptx,
// xlsx, docx, pdf), reuses its container between turns, and uses the basic
// web tools (the dynamic _20260209 ones run code themselves, and two code
// environments confuse the model). Files the code writes come back as
// file ids, which Atelier downloads into Library › Files. Another engine may
// run the same ability its own way (AgentBackend in engines/backend.ts).

export const CODE_EXECUTION_BETA = 'code-execution-2025-08-25'
export const DOCUMENT_SKILLS = ['pptx', 'xlsx', 'docx', 'pdf'] as const
export const CONTAINER_EXPIRED_NOTICE = `The earlier code workspace had expired, so files made in it before are gone. ${BRAND_NAME} started a fresh one.`

export const CODE_EXECUTION_TOOL: BetaToolUnion = { type: 'code_execution_20260521', name: 'code_execution' }

/** The request's container: the chat's last one when it has one, always with the document skills. */
export function containerParam(containerId: string | null): { id?: string; skills: Array<{ type: 'anthropic'; skill_id: string; version: string }> } {
  return {
    ...(containerId ? { id: containerId } : {}),
    skills: DOCUMENT_SKILLS.map((id) => ({ type: 'anthropic' as const, skill_id: id, version: 'latest' })),
  }
}

/**
 * The tool list with documents on: the dynamic web tools swapped for the
 * basic ones (same names, same positions, so the prefix order is kept) and
 * code execution added after the server tools.
 */
export function withDocuments(tools: readonly BetaToolUnion[]): BetaToolUnion[] {
  const out = tools.map((tool): BetaToolUnion => {
    if (tool.type === 'web_search_20260209') return { type: 'web_search_20250305', name: 'web_search' }
    if (tool.type === 'web_fetch_20260209') return { type: 'web_fetch_20250910', name: 'web_fetch' }
    return tool
  })
  // After the browser, web and memory tools; before connectors and client tools.
  const firstAfter = out.findIndex((tool) => tool.type === 'mcp_toolset' || !('type' in tool) || tool.type === 'custom')
  if (firstAfter === -1) out.push(CODE_EXECUTION_TOOL)
  else out.splice(firstAfter, 0, CODE_EXECUTION_TOOL)
  return out
}

/** File ids the code wrote this turn, in order, without repeats. */
export function producedFileIds(content: readonly BetaContentBlock[]): string[] {
  const ids: string[] = []
  for (const block of content) {
    if (block.type !== 'bash_code_execution_tool_result') continue
    const result = block.content
    if (result.type !== 'bash_code_execution_result') continue
    for (const output of result.content) if (output.type === 'bash_code_execution_output' && !ids.includes(output.file_id)) ids.push(output.file_id)
  }
  return ids
}

/** A request that named a container which no longer exists. */
export function isContainerGone(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false
  if (err.status !== 400 && err.status !== 404) return false
  return /container/i.test(err.message) && /expired|not found|no longer|does not exist|unknown/i.test(err.message)
}

export interface GeneratedFilesContext {
  files: FilesApi
  library: LibraryFiles
  chatId: string
  companionId: string
  /** Each saved file, as it lands. */
  onFile(file: LibraryFileRef): void
}

/** Downloads each generated file into Library › Files. A file that fails is logged and skipped; the reply goes on. */
export async function saveGeneratedFiles(fileIds: readonly string[], ctx: GeneratedFilesContext): Promise<LibraryFileRef[]> {
  const saved: LibraryFileRef[] = []
  for (const fileId of fileIds) {
    try {
      const meta = await ctx.files.retrieveMetadata(fileId)
      const response = await ctx.files.download(fileId)
      const bytes = Buffer.from(await response.arrayBuffer())
      const file = ctx.library.addGenerated({ chatId: ctx.chatId, companionId: ctx.companionId, name: meta.filename || 'file', mediaType: meta.mime_type || 'application/octet-stream', bytes })
      saved.push(file)
      ctx.onFile(file)
    } catch (err) {
      log.warn('agent', 'Could not save a generated file', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return saved
}
