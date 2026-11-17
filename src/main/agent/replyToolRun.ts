/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import type { DirectoryEntry } from '@shared/connectors'
import type { LibraryFileRef } from '@shared/files'
import type { AgentEvent } from '@shared/ipc'
import type { LibraryFiles } from '../files/types'
import {
  ARTIFACT_FORMATS,
  artifactFileName,
  artifactMediaType,
  REPLY_TOOLS,
  inputError,
  isArtifactFormat,
  saveArtifactInput,
  suggestConnectorInput,
  suggestNextStepsInput,
  type ArtifactFormat,
} from './replyTools'

// Runs the chat's client tools (suggest_next_steps, save_artifact,
// suggest_connector) for both engines. Each call is validated with zod
// (an invalid one is an error result naming the field) and produces the
// event its card draws: 'suggestions', 'file-produced' or 'connector-needed'.
// save_artifact streams: the report starts as soon as its title and format
// have streamed in, so the card shows the file being written.

export interface DirectoryView {
  entries: DirectoryEntry[]
  /** Directory ids already connected. */
  connected: string[]
}

export interface ReplyToolContext {
  chatId: string
  companionId: string
  turnId: string
  emit(event: AgentEvent): void
  library(): LibraryFiles
  /** The connector directory, or null while it isn't available. */
  directory(): DirectoryView | null
  reports: ArtifactReports
}

interface Pending {
  json: string
  ref: LibraryFileRef | null
  format: ArtifactFormat | null
}

const TITLE = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/
const FORMAT = new RegExp(`"format"\\s*:\\s*"(${ARTIFACT_FORMATS.join('|')})"`)

/** save_artifact reports per tool_use id, started while the input streams. */
export class ArtifactReports {
  readonly #byIndex = new Map<number, string>()
  readonly #pending = new Map<string, Pending>()
  readonly #begin: (callId: string, title: string, format: ArtifactFormat) => LibraryFileRef | null

  /** `begin` starts a report (the library's beginReport) and emits it; null when the library isn't available. */
  constructor(begin: (callId: string, title: string, format: ArtifactFormat) => LibraryFileRef | null) {
    this.#begin = begin
  }

  /** A save_artifact tool_use block started streaming at this index. */
  start(index: number, callId: string): void {
    this.#byIndex.set(index, callId)
    this.#pending.set(callId, { json: '', ref: null, format: null })
  }

  /** More of its input arrived; begins the report once the title and format are known. */
  delta(index: number, partialJson: string): void {
    const callId = this.#byIndex.get(index)
    const pending = callId ? this.#pending.get(callId) : undefined
    if (!callId || !pending) return
    pending.json += partialJson
    if (pending.ref) return
    const title = TITLE.exec(pending.json)?.[1]
    const format = FORMAT.exec(pending.json)?.[1] as ArtifactFormat | undefined
    if (title === undefined || !format) return
    let clean: string
    try {
      clean = JSON.parse(`"${title}"`) as string
    } catch {
      return
    }
    if (!clean.trim()) return
    pending.format = format
    pending.ref = this.#begin(callId, clean, format)
  }

  /** The report begun for a call, if any (the run finishes it). */
  take(callId: string): LibraryFileRef | null {
    const pending = this.#pending.get(callId)
    this.#pending.delete(callId)
    return pending?.ref ?? null
  }

  /** Reports whose call never ran (cut off, stopped): marked failed. */
  pending(): LibraryFileRef[] {
    const refs = [...this.#pending.values()].flatMap((p) => (p.ref ? [p.ref] : []))
    this.#pending.clear()
    this.#byIndex.clear()
    return refs
  }

  /** A new model turn: stream indexes start again. */
  nextTurn(): void {
    this.#byIndex.clear()
  }
}

/** Starts a report and emits its 'writing' card. */
export function beginArtifact(ctx: Pick<ReplyToolContext, 'chatId' | 'companionId' | 'turnId' | 'emit' | 'library'>, title: string, format: ArtifactFormat): LibraryFileRef | null {
  let ref: LibraryFileRef
  try {
    ref = ctx.library().beginReport({ chatId: ctx.chatId, companionId: ctx.companionId, name: artifactFileName(title, format), mediaType: artifactMediaType(format) })
  } catch {
    return null
  }
  const file = { ...ref, artifact: ref.artifact || isArtifactFormat(format) }
  ctx.emit({ type: 'file-produced', turnId: ctx.turnId, file })
  return file
}

/** Marks a begun report failed and updates its card. */
export function failArtifact(ctx: Pick<ReplyToolContext, 'turnId' | 'emit' | 'library'>, ref: LibraryFileRef, message: string): void {
  try {
    ctx.library().fail(ref.id, message)
  } catch {
    // The card still shows the failure.
  }
  ctx.emit({ type: 'file-produced', turnId: ctx.turnId, file: { ...ref, state: 'failed' } })
}

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The directory entry a service name refers to ("Google Calendar", "linear", "notion.so"). */
export function matchDirectory(service: string, entries: readonly DirectoryEntry[]): DirectoryEntry | null {
  const wanted = normalize(service)
  if (!wanted) return null
  const exact = entries.find((e) => normalize(e.name) === wanted || normalize(e.id) === wanted || normalize(e.site) === wanted)
  if (exact) return exact
  return entries.find((e) => {
    const name = normalize(e.name)
    return name.length >= 3 && (wanted.includes(name) || name.includes(wanted))
  }) ?? null
}

/** Runs one of these client tools. Returns the tool result text; throws for an error result. */
export async function runReplyTool(name: string, input: unknown, callId: string, ctx: ReplyToolContext): Promise<string> {
  switch (name) {
    case REPLY_TOOLS.suggestNextSteps: {
      const parsed = suggestNextStepsInput.safeParse(input)
      if (!parsed.success) throw new Error(inputError(parsed.error))
      ctx.emit({ type: 'suggestions', id: randomUUID(), turnId: ctx.turnId, heading: parsed.data.heading ?? null, items: parsed.data.steps })
      return 'Shown to the user under your reply. Don’t repeat the steps in your text.'
    }
    case REPLY_TOOLS.saveArtifact: {
      const begun = ctx.reports.take(callId)
      const parsed = saveArtifactInput.safeParse(input)
      if (!parsed.success) {
        const message = inputError(parsed.error)
        if (begun) failArtifact(ctx, begun, message)
        throw new Error(message)
      }
      const { title, format, content } = parsed.data
      const ref = begun ?? beginArtifact(ctx, title, format)
      if (!ref) throw new Error('Library › Files isn’t available right now, so the file wasn’t saved. Give the user the content in your reply instead.')
      let done: LibraryFileRef
      try {
        done = ctx.library().finishReport(ref.id, content)
      } catch (err) {
        failArtifact(ctx, ref, err instanceof Error ? err.message : String(err))
        throw new Error('The file couldn’t be saved. Give the user the content in your reply instead.')
      }
      ctx.emit({ type: 'file-produced', turnId: ctx.turnId, file: { ...done, artifact: done.artifact || isArtifactFormat(format) } })
      return `Saved “${done.name}” to the user’s Library › Files. A card in the chat opens it; don’t paste the content again.`
    }
    case REPLY_TOOLS.suggestConnector: {
      const parsed = suggestConnectorInput.safeParse(input)
      if (!parsed.success) throw new Error(inputError(parsed.error))
      const { service, reason } = parsed.data
      const directory = ctx.directory()
      if (!directory) {
        ctx.emit({ type: 'connector-needed', id: randomUUID(), turnId: ctx.turnId, directoryId: null, service, reason })
        return 'The user sees a card to connect it. Carry on with what you can do without it.'
      }
      const entry = matchDirectory(service, directory.entries)
      if (!entry) return `${BRAND_NAME} has no ready-made connector for ${service}. The user can add any MCP server for it in Connectors (apex://connectors). Mention that briefly if it helps.`
      if (directory.connected.includes(entry.id)) return `${entry.name} is already connected, but this chat started without it. The user can continue in a new chat to use it.`
      ctx.emit({ type: 'connector-needed', id: randomUUID(), turnId: ctx.turnId, directoryId: entry.id, service: entry.name, reason })
      return `The user sees a card to connect ${entry.name}. Carry on with what you can do without it.`
    }
    default:
      throw new Error(`Unknown tool "${name}".`)
  }
}
