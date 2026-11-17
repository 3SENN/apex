/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { AttachmentRef } from '@shared/attachments'
import type { MessageAttachmentInput } from '@shared/chats'
import type { EngineId } from '@shared/engine'
import type { Skill } from '@shared/services'
import type { AgentEvent } from '@shared/ipc'
import type { ConnectorRuntime, ResolvedConnector as ServerConnector } from '../connectors/runtime'
import type { LibraryFiles } from '../files/types'
import type { AttachmentStore, ChatContextRegistry, PreparedAttachment } from '../intake/types'
import { log } from '../log'
import type { ChatCapabilities, ChatContent } from '../chats'
import type { ResolvedConnector } from '../stores'
import type { ResultBlock, ToolCall, ToolHandler } from './browserTool'
import { RICH_CHAT_CAPABILITY_DEFAULTS, type RichChatCapabilities } from './chatFormatRichChat'
import { ArtifactReports, beginArtifact, failArtifact, runReplyTool, type ReplyToolContext, type DirectoryView } from './replyToolRun'
import { REPLY_TOOLS, replyToolNames, replyToolSpecs, isReplyTool } from './replyTools'
import { CompactionWatch, manualOutcome, supportsCompaction, turnInput } from './compaction'
import { apiBlocks, assertRequestSize, keyFingerprint, type FilesApi, RemoteFileCache } from './content'
import type { AgentBackend } from '../engines/backend'
import { CONTAINER_EXPIRED_NOTICE, isContainerGone, producedFileIds, saveGeneratedFiles } from './documents'
import { callLocalTool, ConnectorApprovals, resultText, snapshotLocalTools, type ApprovalResponse } from './localTools'
import type { PdfTabReader } from './pdfTab'
import { memoryChangeEvent, openedTabIds, partialReason } from './replyEvents'
import type { RichRequest } from './richRequest'

// Part of one chat's session: attachments into requests, compaction,
// documents, the client tools, local connector tools and the reply
// events, on every engine. session.ts calls in through small hooks;
// everything else lives here so the core loop stays readable.

/** Main-side APIs from the attachment, files and connector features, read when used (those features fill ctx.content in order). */
export interface RichChatDeps {
  attachments(): AttachmentStore
  chatContext(): ChatContextRegistry
  libraryFiles(): LibraryFiles
  connectors(): ConnectorRuntime
  remoteFiles: RemoteFileCache
  pdf: PdfTabReader
  /** The connector directory and what is connected (CH-41); null while unavailable. */
  directory(): DirectoryView | null
  /** Built-in skills (brand-kit) by name or id. */
  builtinSkill(nameOrId: string): Skill | undefined
}

export interface SessionRichChatHost {
  chatId: string
  companionId(): string
  routine(): boolean
  emit(event: AgentEvent): void
  /** The chat waits for you (an open connector approval). */
  awaiting(on: boolean): void
  /** A user skill by id. */
  skill(id: string): { name: string; instructions: string } | undefined
  tabInfo(tabId: string): { url: string; title: string; favicon: string | null } | null
  /** A connector's name for approval cards. */
  connectorName(connectorId: string): string
}

/** What a message carries besides its text: refs to resolve, or blocks kept from the message it replaces (edit, retry). */
export interface OutgoingAttachments {
  refs: AttachmentRef[]
  prepared: PreparedAttachment[]
  kept: BetaContentBlockParam[]
}

const tryGet = <T>(get: () => T): T | null => {
  try {
    return get()
  } catch {
    return null
  }
}

export class SessionRichChat {
  readonly approvals = new ConnectorApprovals()
  readonly #host: SessionRichChatHost
  readonly #deps: () => RichChatDeps | undefined
  #turnId = ''
  #reports: ArtifactReports | null = null
  #watch: CompactionWatch | null = null
  #lastInput: number | null = null
  #output = false
  #partialSent = false
  #retry = false

  constructor(host: SessionRichChatHost, deps: () => RichChatDeps | undefined) {
    this.#host = host
    this.#deps = deps
  }

  get deps(): RichChatDeps | undefined {
    return this.#deps()
  }

  // ---- setup ----

  /**
   * The draft's documents and compaction: documents with the setting on, on
   * every engine; compaction on the API key with supporting models (another
   * engine condenses its own copy).
   */
  draftSetup(engine: EngineId, model: string, documentsSetting: boolean): { documents: boolean; compaction: boolean } {
    const api = engine === 'api-key'
    return { documents: documentsSetting, compaction: api && supportsCompaction(model) }
  }

  /** The chat's capability fields, fixed at the first message. */
  startCapabilities(setup: { documents: boolean; compaction: boolean; connectorIds: readonly string[] }): RichChatCapabilities {
    const runtime = tryGet(() => this.#deps()?.connectors() ?? null)
    const local = runtime ? (tryGet(() => runtime.localTools(setup.connectorIds)) ?? []) : []
    const localTools = snapshotLocalTools(local, (id) => this.#host.connectorName(id))
    const toolPolicies: RichChatCapabilities['toolPolicies'] = {}
    for (const tool of localTools) {
      const policy = tryGet(() => runtime?.livePolicy(tool.connectorId, tool.toolName) ?? 'ask') ?? 'ask'
      ;(toolPolicies[tool.connectorId] ??= {})[tool.toolName] = policy
    }
    // Remote tools that are off now stay off for the chat's whole life (mcp_toolset configs).
    for (const server of runtime ? (tryGet(() => runtime.resolveServer(setup.connectorIds)) ?? []) : []) {
      for (const tool of server.disabledTools) (toolPolicies[server.connectorId] ??= {})[tool] = 'off'
    }
    return {
      ...RICH_CHAT_CAPABILITY_DEFAULTS,
      documents: setup.documents,
      compaction: setup.compaction,
      localTools,
      toolPolicies,
      cClientTools: replyToolNames({ routine: this.#host.routine() }),
    }
  }

  // ---- attachments ----

  /** Resolves a message's refs; throws "Wait for attachments to finish preparing" while one isn't ready. Inline images and meetings go to their own hook. */
  resolve(attachments: readonly MessageAttachmentInput[] | undefined): PreparedAttachment[] {
    const ids = (attachments ?? []).flatMap((a) => (a.kind === 'ref' ? [a.id] : []))
    if (ids.length === 0) return []
    const deps = this.#deps()
    if (!deps) throw new Error('Attachments aren’t available yet.')
    return deps.attachments().resolve(this.#host.chatId, ids)
  }

  outgoing(attachments: readonly MessageAttachmentInput[] | undefined, kept?: { blocks: BetaContentBlockParam[]; refs: AttachmentRef[] }): OutgoingAttachments {
    const prepared = this.resolve(attachments)
    return { prepared, refs: [...(kept?.refs ?? []), ...prepared.map((p) => p.ref)], kept: kept?.blocks ?? [] }
  }

  /** Freezes the sent attachments with their message, so edit and duplicate find them. */
  bind(out: OutgoingAttachments, userMessageId: string): void {
    if (out.prepared.length === 0) return
    tryGet(() => this.#deps()?.attachments().bindToMessage(this.#host.chatId, out.prepared.map((p) => p.ref.id), userMessageId))
  }

  /**
   * Puts the attachment blocks into the user message before its typed text
   * (the last block) and checks the 32 MB request cap. API-key chats upload
   * images and PDFs; another engine makes its own blocks (`backend`).
   */
  async addBlocks(blocks: BetaContentBlockParam[], out: OutgoingAttachments, content: ChatContent, files: FilesApi | null, apiKey: string | null, backend: AgentBackend | null = null): Promise<void> {
    if (out.prepared.length === 0 && out.kept.length === 0) return
    const engine = content.capabilities.engine ?? 'api-key'
    const skill = (id: string): { name: string; instructions: string } | null => this.#host.skill(id) ?? this.#deps()?.builtinSkill(id) ?? null
    const deps = this.#deps()
    const added: BetaContentBlockParam[] =
      engine === 'api-key' || !backend?.attachmentBlocks
        ? await apiBlocks(out.prepared, {
            chatId: this.#host.chatId,
            documents: content.capabilities.documents === true,
            files,
            fingerprint: keyFingerprint(apiKey),
            cache: deps?.remoteFiles ?? new RemoteFileCache(''),
            onRemote: (id, fileId) => {
              const fp = keyFingerprint(apiKey)
              if (fp) tryGet(() => deps?.attachments().setRemoteFile(this.#host.chatId, id, fp, fileId))
            },
            skill,
          })
        : (backend.attachmentBlocks(out.prepared, { chatId: this.#host.chatId, documents: content.capabilities.documents === true, skill }) as BetaContentBlockParam[])
    const all = [...out.kept, ...added]
    assertRequestSize(content.messages, all)
    blocks.splice(Math.max(0, blocks.length - 1), 0, ...all)
  }

  // ---- the request ----

  richRequest(content: ChatContent, manual = false): RichRequest {
    const caps = content.capabilities
    const mcpDisabled: Record<string, string[]> = {}
    for (const server of this.#servers(caps.connectorIds)) {
      const off = Object.entries(caps.toolPolicies?.[server.connectorId] ?? {}).flatMap(([tool, policy]) => (policy === 'off' ? [tool] : []))
      if (off.length > 0) mcpDisabled[server.serverName] = off
    }
    return {
      documents: caps.documents === true,
      containerId: caps.containerId ?? null,
      compaction: caps.compaction === true,
      manual,
      replyTools: caps.cClientTools ?? [],
      localTools: caps.localTools ?? [],
      mcpDisabled,
    }
  }

  /** Remote servers from the connector runtime in the request's connector shape, or null to keep the saved connector store. */
  remoteConnectors(ids: readonly string[]): ResolvedConnector[] | null {
    const servers = this.#servers(ids)
    return servers.length > 0 ? servers.map((s) => ({ id: s.connectorId, name: s.serverName, url: s.url, token: s.authorizationToken })) : null
  }

  #servers(ids: readonly string[]): ServerConnector[] {
    if (ids.length === 0) return []
    return tryGet(() => this.#deps()?.connectors().resolveServer(ids) ?? []) ?? []
  }

  // ---- one run and its model turns ----

  /** A new run: the reply events of this run share a turn id until the first model turn sets its own. */
  beginRun(): void {
    this.#turnId = randomUUID()
    this.#output = false
    this.#partialSent = false
    this.#retry = false
    this.#reports = null
  }

  /** A model turn starts streaming. */
  beginTurn(turnId: string, content: ChatContent): void {
    this.#turnId = turnId
    this.#watch = content.capabilities.compaction ? new CompactionWatch(this.#lastInput) : null
    this.#reports?.nextTurn()
  }

  get turnId(): string {
    return this.#turnId
  }

  /**
   * The model turn's stream, passed through: each event also feeds
   * compaction and streamed artifacts. A request that named an expired
   * container ends the stream quietly and sets takeRetry().
   */
  async *watch<E extends BetaRawMessageStreamEvent>(stream: AsyncIterable<E>, content: ChatContent): AsyncGenerator<E> {
    this.#retry = false
    try {
      for await (const event of stream) {
        this.onStreamEvent(event)
        yield event
      }
    } catch (err) {
      if (!this.containerGone(err, content)) throw err
      this.#retry = true
    }
  }

  /** True once after a stream ended for an expired container. */
  takeRetry(): boolean {
    const retry = this.#retry
    this.#retry = false
    return retry
  }

  /** Stream events: compaction starts and save_artifact's streamed input. */
  onStreamEvent(event: BetaRawMessageStreamEvent): void {
    const started = this.#watch?.onEvent(event)
    if (started) this.#host.emit(started)
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use' && event.content_block.name === REPLY_TOOLS.saveArtifact) {
      this.#artifactReports().start(event.index, event.content_block.id)
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'input_json_delta') this.#reports?.delta(event.index, event.delta.partial_json)
      else if (event.delta.type === 'text_delta' && event.delta.text) this.#output = true
    }
  }

  /** After a model turn: compaction results, the container to reuse, and files the code wrote. */
  async afterMessage(message: BetaMessage, content: ChatContent, files: FilesApi | null): Promise<void> {
    for (const event of this.#watch?.finish(message) ?? []) this.#host.emit(event)
    this.#watch = null
    this.#lastInput = turnInput(message.usage)
    if (message.content.some((b) => b.type === 'text' && b.text.trim())) this.#output = true
    const container = (message as { container?: { id?: string } | null }).container
    if (content.capabilities.documents && container?.id) content.capabilities.containerId = container.id
    const ids = producedFileIds(message.content)
    const deps = this.#deps()
    if (ids.length === 0 || !files || !deps) return
    const library = tryGet(() => deps.libraryFiles())
    if (!library) return
    const turnId = this.#turnId
    await saveGeneratedFiles(ids, {
      files,
      library,
      chatId: this.#host.chatId,
      companionId: this.#host.companionId(),
      onFile: (file) => this.#host.emit({ type: 'file-produced', turnId, file }),
    })
  }

  /** A request named an expired container: forget it, say so, and let the loop retry with a fresh one. */
  containerGone(err: unknown, content: ChatContent): boolean {
    if (!content.capabilities.containerId || !isContainerGone(err)) return false
    content.capabilities.containerId = null
    this.#host.emit({ type: 'error', message: CONTAINER_EXPIRED_NOTICE })
    return true
  }

  /**
   * The client handlers added to a turn: its own tools (the call id comes
   * from the turn's calls, since save_artifact finishes the report it
   * started while streaming) and the chat's local connector tools.
   */
  handlers(content: ChatContent, signal: AbortSignal, calls: readonly ToolCall[]): Record<string, ToolHandler> {
    const out: Record<string, ToolHandler> = {}
    const callIds = new Map<unknown, string>(calls.map((call) => [call.input, call.id]))
    for (const name of content.capabilities.cClientTools ?? []) {
      out[name] = { execute: (_name, input) => runReplyTool(name, input, callIds.get(input) ?? randomUUID(), this.#toolContext()) }
    }
    for (const tool of content.capabilities.localTools ?? []) {
      out[tool.apiName] = {
        execute: async (_name, input) => {
          const result = await this.#callLocal(tool.apiName, input, content, signal)
          if (result.isError) throw new Error(resultText(result.content))
          return typeof result.content === 'string' ? result.content : (result.content ?? []).filter((b): b is BetaTextBlockParam | BetaImageBlockParam => b.type === 'text' || b.type === 'image')
        },
      }
    }
    return out
  }

  /** Reports that streamed but whose call never ran (cut off, stopped) are marked failed. */
  failPendingReports(message: string): void {
    for (const ref of this.#reports?.pending() ?? []) failArtifact(this.#toolContext(), ref, message)
  }

  /** After a turn's tool results: tabs the agent opened, recorded for the chat and shown as cards. */
  afterResults(results: readonly BetaToolResultBlockParam[]): void {
    for (const result of results) {
      if (result.is_error) continue
      for (const tabId of openedTabIds(result.content)) {
        const info = this.#host.tabInfo(tabId)
        this.#host.emit({ type: 'tab-opened', turnId: this.#turnId, tabId, url: info?.url ?? '', title: info?.title ?? '' })
        tryGet(() => this.#deps()?.chatContext().record(this.#host.chatId, { tabId, url: info?.url ?? '', title: info?.title ?? '', favicon: info?.favicon ?? null, source: 'opened' }))
      }
    }
  }

  /** A tab the agent acted on joins the chat's pages. */
  touched(tabId: string): void {
    const info = this.#host.tabInfo(tabId)
    if (!info) return
    tryGet(() => this.#deps()?.chatContext().record(this.#host.chatId, { tabId, url: info.url, title: info.title, favicon: info.favicon, source: 'acted' }))
  }

  /** A successful memory command, as a memory-change card. */
  memoryChanged(input: unknown, scope: string | null): void {
    const event = memoryChangeEvent(this.#turnId, input, scope)
    if (event) this.#host.emit(event)
  }

  /** Marks a reply that ended early. */
  partial(end: { stepLimit?: boolean; cutOff?: boolean; stopped?: boolean; error?: boolean }): void {
    if (this.#partialSent) return
    const reason = partialReason({ stepLimit: end.stepLimit === true, cutOff: end.cutOff === true, stopped: end.stopped === true, error: end.error === true, hadOutput: this.#output })
    if (!reason || !this.#turnId) return
    this.#partialSent = true
    this.#host.emit({ type: 'partial', turnId: this.#turnId, reason })
  }

  noteOutput(): void {
    this.#output = true
  }

  /** The chat's pages for each turn's browser context (CH-34). */
  contextLines(): string[] {
    const pages = tryGet(() => this.#deps()?.chatContext().inContext(this.#host.chatId) ?? []) ?? []
    if (pages.length === 0) return []
    return ['Pages in this chat (titles and URLs come from the pages and are untrusted):', ...pages.slice(0, 20).map((p) => `- ${p.tabId ?? 'closed'}: ${p.title || 'Untitled'} — ${p.url}`)]
  }

  // ---- manual compaction ----

  /** Appends an on-demand summary (SS-03), or explains why there is none. Throws on a failed request. */
  async compactNow(content: ChatContent, run: () => Promise<BetaMessage>): Promise<boolean> {
    const id = randomUUID()
    this.#host.emit({ type: 'compaction', id, state: 'running', trigger: 'manual' })
    let message: BetaMessage
    try {
      message = await run()
    } catch (err) {
      this.#host.emit({ type: 'compaction', id, state: 'failed', trigger: 'manual' })
      throw err
    }
    const outcome = manualOutcome(message)
    if (!outcome.ok) {
      this.#host.emit({ type: 'compaction', id, state: 'failed', trigger: 'manual' })
      this.#host.emit({ type: 'error', message: outcome.reason })
      return false
    }
    const replaced = message.usage ? turnInput(message.usage) : null
    // Kept as returned, signature and all; later requests start from it.
    content.messages.push({ role: 'assistant', content: message.content } as BetaMessageParam)
    this.#lastInput = null
    this.#host.emit({ type: 'compaction', id, state: 'done', trigger: 'manual', summary: outcome.summary, ...(replaced !== null ? { replacedTokens: replaced } : {}) })
    return true
  }

  // ---- other engines ----

  /** Runs a client tool or local tool for an engine that reaches them over MCP; undefined when the name isn't one of them. */
  async executeForEngine(name: string, input: unknown, signal: AbortSignal, content: ChatContent): Promise<ResultBlock[] | string | undefined> {
    const caps = content.capabilities
    if (isReplyTool(name) && (caps.cClientTools ?? []).includes(name)) {
      return runReplyTool(name, input, randomUUID(), this.#toolContext())
    }
    if ((caps.localTools ?? []).some((t) => t.apiName === name)) {
      const result = await this.#callLocal(name, input, content, signal)
      if (result.isError) throw new Error(resultText(result.content))
      return resultText(result.content) || 'Done.'
    }
    return undefined
  }

  /** CH-40: the person's answer to a connector approval. */
  respond(approvalId: string, response: ApprovalResponse): void {
    this.approvals.respond(approvalId, response)
  }

  async #callLocal(apiName: string, input: unknown, content: ChatContent, signal: AbortSignal): ReturnType<typeof callLocalTool> {
    const tool = (content.capabilities.localTools ?? []).find((t) => t.apiName === apiName)
    const runtime = tryGet(() => this.#deps()?.connectors() ?? null)
    if (!tool || !runtime) return { content: 'This connector isn’t available right now.', isError: true }
    try {
      return await callLocalTool(tool, input, {
        runtime,
        approvals: this.approvals,
        connectorName: (id) => this.#host.connectorName(id),
        emit: (event) => this.#host.emit(event),
        awaiting: (on) => this.#host.awaiting(on),
        routine: this.#host.routine(),
        signal,
      })
    } catch (err) {
      log.warn('agent', 'A local connector tool failed', { error: err instanceof Error ? err.message : String(err) })
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }

  #artifactReports(): ArtifactReports {
    this.#reports ??= new ArtifactReports((_callId, title, format) => beginArtifact(this.#toolContext(), title, format))
    return this.#reports
  }

  #toolContext(): ReplyToolContext {
    const deps = this.#deps()
    return {
      chatId: this.#host.chatId,
      companionId: this.#host.companionId(),
      turnId: this.#turnId,
      emit: (event) => this.#host.emit(event),
      library: () => {
        if (!deps) throw new Error('Library › Files isn’t available yet.')
        return deps.libraryFiles()
      },
      directory: () => (deps ? tryGet(() => deps.directory()) : null),
      reports: this.#artifactReports(),
    }
  }
}

/** The client tools and the chat's local tools as MCP tool specs for Atelier's local server (engines that reach them over MCP). */
export function replyMcpTools(caps: ChatCapabilities): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const local = (caps.localTools ?? []).map((tool) => ({
    name: tool.apiName,
    description: tool.description || tool.toolName,
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? (tool.inputSchema as Record<string, unknown>) : { type: 'object' },
  }))
  return [...replyToolSpecs(caps.cClientTools ?? []), ...local]
}
