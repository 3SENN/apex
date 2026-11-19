/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageDetails, TurnUsage } from '@shared/chats'
import { MCP_SERVER_NAME } from '@shared/engine'
import type { RateLimitNote } from '../shared/status'
import { describeToolCall, errorMessage } from '../../../../src/main/agent/browserTool'
import { memoryCommandPaths } from '../../../../src/main/memory'
import type { McpRoute, McpTool } from '../../../../src/main/mcp/server'
import { browserToolSpecs, BROWSER_TOOL_NAMES, errorResult, MEMORY_TOOL, qualified, toMcpResult, unqualified } from '../../../../src/main/mcp/tools'
export { engineNote } from './launchPolicy'
import { writeAtomic } from '../../../../src/main/settings'
import type { ResolvedConnector } from '../../../../src/main/stores'
import { MAX_STEPS, transcriptOf, type AgentBackend, type AttachmentBlockContext, type BackendResult, type BackendTurn, type TurnBlock } from '../../../../src/main/engines/backend'
import type { ChatErrorCode } from '@shared/chatErrors'
import type { PreparedAttachment } from '../../../../src/main/intake/types'
import { claudeCodeBlocks } from './blocks'
import { looksSignedOut, type CliLookup } from './cli'
import { classifyClaudeCodeFailure, claudeCodeErrorCode, parseCliApiError, tooOldFacts } from './errors'
import { connectorServerList, launchPolicy } from './launchPolicy'
import { ClaudeProcess, type ProcessExit, type SpawnSpec } from './process'
// CH-19
import type { AgentEvent } from '@shared/ipc'
import { summarizeInput, summarizeResult, toolKind } from '../../../../src/main/agent/toolEvents'
import type { BridgeEvent } from './streamJson'
// The same registry as the API-key engine, over Atelier's MCP server
import { webSearchSources } from './webSearch'
import { clientToolSpecs, MCP_TOOL_TIMEOUT_MS } from '../../../../src/main/agent/tools/registry'
import { replyMcpTools } from '../../../../src/main/agent/sessionRichChat'
import { copyDocumentsWorkspace, copyIntoWorkspace, documentsLaunch, inWorkspace, removeDocumentsWorkspace, type DocumentsLaunch } from './documentsWorkspace'
import { mainT } from '../../../../src/main/i18n/mainT'
import type { Effort } from '@shared/ipc' // DC-15

// The Claude subscription engine (ST-59): one long-lived `claude` process per chat
// that is working, started at the chat's first message and resumed by its
// stored session id after an idle shutdown or a restart. Its only tools are
// Atelier's, served by the local MCP server under a per-chat token, and every
// browser action runs through the chat's own executor, guard and approvals.

export const IDLE_MS = 10 * 60_000
export const MAX_PROCESSES = 8
/** How long an interrupted turn may take to wind down before its process is stopped. */
const INTERRUPT_GRACE_MS = 1500

export interface ClaudeCodeDeps {
  /** The CLI to run; null when it isn't on this Mac. */
  cli(): Promise<CliLookup | null>
  /** The environment for the child (see childEnv). */
  env(): Promise<Record<string, string>>
  /** The companion's own folder, which the process runs in. */
  folder(companionId: string): string
  /** Where per-chat MCP config files go (inside Atelier's data folder). */
  configDir: string
  /** Starts the MCP server if needed; the URL and bearer token for one chat. */
  endpoint(chatId: string): Promise<{ url: string; token: string }>
  /** Status worth showing in Settings: rate limits, a sign-in that failed, live process counts. */
  onNote(note: { rateLimit?: RateLimitNote | null; signedOut?: boolean; processes?: number; /** A model's minimum Claude Code version, from a version error. */ minimum?: { model: string; version: string } }): void
  /** Tests wrap or replace the spawn. */
  spawn?(spec: SpawnSpec): ClaudeProcess
  // ── launch policy ──
  /** A Files and documents chat's workspace launch (documentsLaunch: folder, plugin with the document skills, note); tests replace it. */
  documents?(chatId: string): Pick<DocumentsLaunch, 'cwd' | 'addDirs' | 'pluginDirs' | 'note'>
  /** The app's effort setting, for chats from before per-chat effort. */
  effort?(): import('@shared/ipc').Effort
  idleMs?: number
  maxProcesses?: number
}

interface ActiveTurn {
  turn: BackendTurn
  /** Model message id to the chat's turnId. */
  turnIds: Map<string, string>
  details: Map<string, MessageDetails>
  toolLabels: Map<string, string>
  /** Each step's start, kind and connector, for its done event. */
  toolStarts: Map<string, Pick<Extract<AgentEvent, { type: 'tool' }>, 'kind' | 'startedAt' | 'input' | 'connector'>>
  text: string
  memoryPaths: Set<string>
  rateLimit: RateLimitNote | null
  /** The CLI's API error message for this turn, kept for the error card (never shown as reply text). */
  apiError: Extract<BridgeEvent, { kind: 'api-error' }> | null
  /** Anything reached the chat yet (a resume that fails before this can be retried afresh). */
  started: boolean
  // ── steps and Compact now ──
  /** Model messages that asked for tools: one step each, as the API-key loop counts them. */
  steps: Set<string>
  /** The latest step's tool calls still waiting for their results. */
  stepTools: Set<string>
  /** This turn is Compact now (`/compact`), not a message. */
  compact: boolean
  finish(result: BackendResult | Error): void
}

interface ChatProcess {
  chatId: string
  proc: ClaudeProcess
  tools: McpTool[]
  /** The chat's client tools when it launched; a chat whose list grew since (Creator mode, a pack installed) relaunches. */
  clientTools: string
  configPath: string
  /** MCP server names of the chat's connectors, for the steps' connector icons. */
  connectorServers: Map<string, { id: string; name: string }>
  turn: ActiveTurn | null
  /** Set while an interrupted turn winds down; `done` ends the wait. */
  draining: { promise: Promise<void>; done(): void } | null
  idleTimer: NodeJS.Timeout | null
  lastUsed: number
  sessionId: string | null
  /** False for a private chat, whose session Claude Code doesn't keep (so Atelier doesn't store its id). */
  persist: boolean
  /** The version of the CLI this process runs, as Atelier read it. */
  cliVersion: string | null
  // ── DC-15 effort per message ──
  /** The chat's effort, which the process was started with. */
  chatEffort: Effort
  /** The effort the session runs at now; a message a quick decision moved changes it until the next one sets it back. */
  effort: Effort
  /** The last change asked for, until the CLI answers; one it refuses (an older CLI) stops the changes for this process. */
  effortRequest: { id: string; previous: Effort } | null
  effortRefused: boolean
}

export class ClaudeCodeBackend implements AgentBackend {
  readonly engine = 'claude-code' as const
  readonly #deps: ClaudeCodeDeps
  readonly #chats = new Map<string, ChatProcess>()
  /** CH-26: the compaction card of each chat that is condensing now. */
  readonly #compactions = new Map<string, string>()

  constructor(deps: ClaudeCodeDeps) {
    this.#deps = deps
    mkdirSync(deps.configDir, { recursive: true })
  }

  get processes(): number {
    return [...this.#chats.values()].filter((c) => c.proc.alive).length
  }

  /** The MCP route for a chat's token: its tools always, its calls only while one of its turns runs. */
  route(chatId: string): McpRoute | null {
    const entry = this.#chats.get(chatId)
    if (!entry) return null
    return {
      name: BRAND_NAME,
      tools: () => entry.tools,
      call: async (name, args, signal) => {
        const active = entry.turn
        // Fail closed: no turn of this chat is running, so nothing may act for it.
        if (!active) return errorResult(`This chat is not working on anything right now, so ${BRAND_NAME} refused the action.`)
        const merged = AbortSignal.any([signal, active.turn.signal])
        try {
          const output = await active.turn.tools.execute(name, args, merged)
          if (name === 'memory') for (const path of memoryCommandPaths(args)) active.memoryPaths.add(path)
          return toMcpResult(output)
        } catch (err) {
          return errorResult(merged.aborted ? 'Not done: the user stopped the chat.' : `Error: ${errorMessage(err)}`)
        }
      },
    }
  }

  run(turn: BackendTurn): Promise<BackendResult> {
    // What this reply makes in the chat's folder goes to Library › Files.
    return inWorkspace(turn, () => this.#run(turn))
  }

  /** A message's attachments for the stream-json input; documents chats also get copies in their own folder. */
  attachmentBlocks(prepared: readonly PreparedAttachment[], ctx: AttachmentBlockContext): TurnBlock[] {
    return claudeCodeBlocks(prepared, {
      skill: ctx.skill,
      // Documents chats get copies in their own folder, as the API key puts them in the container.
      ...(ctx.documents ? { toWorkspace: (name: string, path: string) => copyIntoWorkspace(ctx.chatId, name, path) } : {}),
    })
  }

  errorCode(message: string): ChatErrorCode {
    return claudeCodeErrorCode(message)
  }

  /** The copy's forked session finds its files. */
  duplicated(fromChatId: string, toChatId: string): void {
    copyDocumentsWorkspace(fromChatId, toChatId)
  }

  /** The chat's documents folder goes with it. */
  removed(chatId: string): void {
    removeDocumentsWorkspace(chatId)
  }

  async #run(turn: BackendTurn): Promise<BackendResult> {
    turn.signal.throwIfAborted()
    const cli = await this.#deps.cli()
    if (!cli) return { text: '', paused: false, error: MESSAGES.notFound }
    const session = turn.capabilities.private === true ? null : turn.session
    let result = await this.#attempt(turn, cli, session, false)
    // A stored session Claude Code no longer has: start afresh with the chat so far as context.
    if (result === 'missing-session') {
      turn.setSession(null)
      result = await this.#attempt(turn, cli, null, false)
    }
    return result === 'missing-session' ? { text: '', paused: false, error: MESSAGES.crashed('the stored conversation could not be opened') } : result
  }

  /**
   * SS-03, CH-26: Compact now. `/compact` goes in on the chat's stdin
   * (Claude Code runs slash commands sent as prompts in stream-json mode);
   * its compact_boundary closes the card. A chat whose process idled out is
   * resumed first; one with no conversation in Claude Code has nothing to condense.
   */
  async compact(turn: BackendTurn): Promise<BackendResult> {
    turn.signal.throwIfAborted()
    const live = this.#chats.get(turn.chatId)
    const session = turn.capabilities.private === true ? null : turn.session
    if (!live?.proc.alive && !session) throw new Error(MESSAGES.nothingToCompact)
    const cli = await this.#deps.cli()
    if (!cli) return { text: '', paused: false, error: MESSAGES.notFound }
    const result = await this.#attempt(turn, cli, session, true)
    if (result === 'missing-session') {
      turn.setSession(null)
      throw new Error(MESSAGES.nothingToCompact)
    }
    return result
  }

  reset(chatId: string): void {
    void this.#drop(chatId)
  }

  discard(chatId: string): void {
    void this.#drop(chatId)
  }

  /** Stops every process (Atelier is quitting). */
  async dispose(): Promise<void> {
    await Promise.all([...this.#chats.keys()].map((id) => this.#drop(id)))
  }

  async #attempt(turn: BackendTurn, cli: CliLookup, session: BackendTurn['session'], compact: boolean): Promise<BackendResult | 'missing-session'> {
    let entry = this.#chats.get(turn.chatId)
    if (entry && !entry.proc.alive) {
      await this.#drop(turn.chatId)
      entry = undefined
    }
    if (entry?.draining) await entry.draining.promise
    if (entry && !entry.proc.alive) entry = undefined
    // Claude Code takes its tools at launch: tools that joined the chat need a fresh process, which resumes the conversation.
    if (entry && entry.clientTools !== (turn.capabilities.clientTools ?? []).join(' ')) {
      await this.#drop(turn.chatId)
      entry = undefined
    }
    turn.signal.throwIfAborted()
    const fresh = !entry
    if (!entry) entry = await this.#launch(turn, cli, session)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    entry.lastUsed = Date.now()

    // DC-15: a message whose effort a quick decision moved runs at it; the next one sets the chat's back.
    if (!compact) this.#applyEffort(entry, turn.effort ?? entry.chatEffort)

    const blocks = compact ? [] : [...turn.blocks]
    // A new conversation for a chat that already has messages gets them as context.
    if (!compact && fresh && !session) {
      const transcript = transcriptOf(turn.history)
      if (transcript) blocks.unshift({ type: 'text', text: transcript })
    }

    const target = entry
    const outcome = await new Promise<BackendResult | Error | 'missing-session'>((resolve) => {
      const active: ActiveTurn = {
        turn,
        turnIds: new Map(),
        details: new Map(),
        toolLabels: new Map(),
        toolStarts: new Map(),
        text: '',
        memoryPaths: new Set(),
        rateLimit: null,
        apiError: null,
        started: false,
        steps: new Set(),
        stepTools: new Set(),
        compact,
        finish: (result) => {
          if (target.turn !== active) return
          target.turn = null
          turn.signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
      }
      const onAbort = (): void => {
        if (target.turn !== active) return
        this.#interrupt(target)
        active.finish(turn.signal.reason instanceof Error ? turn.signal.reason : new Error('Stopped.'))
      }
      target.turn = active
      turn.signal.addEventListener('abort', onAbort, { once: true })
      if (compact) {
        // The card shows at once; the boundary closes it, a result without one fails it.
        const id = randomUUID()
        this.#compactions.set(target.chatId, id)
        turn.emit({ type: 'compaction', id, state: 'running', trigger: 'manual' })
      }
      const sent = compact ? target.proc.command('/compact') : target.proc.send(blocks)
      if (!sent) active.finish({ text: '', paused: false, error: MESSAGES.crashed('it could not be reached') })
      // A process that dies before answering ends the turn; a resume Claude Code can't find is retried afresh.
      void target.proc.exited.then((exit) => {
        if (target.turn !== active) return
        if (!active.started && session && /no conversation found|session.*not found/i.test(exit.stderr)) {
          target.turn = null
          turn.signal.removeEventListener('abort', onAbort)
          resolve('missing-session')
          return
        }
        active.finish(this.#exitResult(exit, active, target))
      })
    })
    if (outcome === 'missing-session') {
      await this.#drop(turn.chatId)
      return outcome
    }
    this.#scheduleIdle(target)
    if (outcome instanceof Error) throw outcome
    return outcome
  }

  async #launch(turn: BackendTurn, cli: CliLookup, session: BackendTurn['session']): Promise<ChatProcess> {
    await this.#makeRoom()
    const caps = turn.capabilities
    const clientSpecs = clientToolSpecs(caps.clientTools ?? [])
    const cSpecs = replyMcpTools(caps) // The extra client tools and local connector tools, with the same approvals
    const names = [...(caps.browser ? BROWSER_TOOL_NAMES : []), ...(caps.memory ? ['memory'] : []), ...clientSpecs.map((t) => t.name), ...cSpecs.map((t) => t.name)]
    const tools = [...(caps.browser ? browserToolSpecs() : []), ...(caps.memory ? [MEMORY_TOOL] : []), ...clientSpecs, ...cSpecs]
    const { url, token } = await this.#deps.endpoint(turn.chatId)
    // Bearer tokens (Atelier's and the connectors') live in a 0600 file, never in the process arguments.
    const servers = mcpServers({ url, token }, turn.connectors)
    const configPath = join(this.#deps.configDir, `${turn.chatId}.json`)
    writeAtomic(configPath, JSON.stringify({ mcpServers: servers }, null, 2))
    // What the chat may do, from its capabilities (web reading, connector tools that are off, private, documents).
    const documents = caps.documents === true ? (this.#deps.documents ?? documentsLaunch)(turn.chatId) : null
    const plan = launchPolicy({
      caps,
      settings: { effort: this.#deps.effort?.() },
      system: turn.system,
      mcpConfigPath: configPath,
      atelierTools: qualified(names),
      connectors: turn.connectors,
      session,
      companionFolder: this.#deps.folder(turn.companionId),
      documentsFolder: documents?.cwd ?? null,
      addDirs: documents?.addDirs ?? [],
      pluginDirs: documents?.pluginDirs ?? [],
      documentsNote: documents?.note ?? '',
    })
    mkdirSync(plan.cwd, { recursive: true })
    const spec: SpawnSpec = {
      path: cli.path,
      cwd: plan.cwd,
      // Questions and approvals can wait on the person far longer than Claude Code's default tool timeout.
      env: { ...(await this.#deps.env()), MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) },
      args: plan.args,
    }
    const proc = this.#deps.spawn ? this.#deps.spawn(spec) : new ClaudeProcess(spec)
    const entry: ChatProcess = { chatId: turn.chatId, proc, tools, clientTools: (caps.clientTools ?? []).join(' '), configPath, connectorServers: connectorServerNames(turn.connectors), turn: null, draining: null, idleTimer: null, lastUsed: Date.now(), sessionId: plan.persist ? (session?.id ?? null) : null, persist: plan.persist, cliVersion: cli.version ?? null, chatEffort: plan.options.effort, effort: plan.options.effort, effortRequest: null, effortRefused: false }
    this.#chats.set(turn.chatId, entry)
    proc.on('event', (event) => this.#onEvent(entry, event))
    proc.on('exit', () => {
      if (this.#chats.get(entry.chatId) === entry) this.#forget(entry)
    })
    this.#deps.onNote({ processes: this.processes })
    return entry
  }

  /** DC-15: asks the session for another effort from the next message on (apply_flag_settings), when it isn't at it already. */
  #applyEffort(entry: ChatProcess, effort: Effort): void {
    if (effort === entry.effort || entry.effortRefused) return
    const id = randomUUID()
    if (!entry.proc.setEffort(id, effort)) return
    entry.effortRequest = { id, previous: entry.effort }
    entry.effort = effort
  }

  #onEvent(entry: ChatProcess, event: BridgeEvent): void {
    const active = entry.turn
    // DC-15: a CLI that refuses the change keeps the effort it had, and isn't asked again.
    if (event.kind === 'control-response' && event.requestId === entry.effortRequest?.id) {
      if (!event.ok) {
        entry.effort = entry.effortRequest.previous
        entry.effortRefused = true
      }
      entry.effortRequest = null
      return
    }
    if (event.kind === 'init' && event.sessionId && event.sessionId !== entry.sessionId) {
      entry.sessionId = event.sessionId
      // Even an interrupted turn's session is worth keeping; a private chat's isn't kept anywhere.
      if (entry.persist) (active?.turn ?? null)?.setSession({ id: event.sessionId })
    }
    if (event.kind === 'rate-limit') {
      const note: RateLimitNote | null = event.status === 'allowed' ? null : { status: event.status, resetsAt: event.resetsAt, at: Date.now() }
      if (active) active.rateLimit = note
      this.#deps.onNote({ rateLimit: note })
      return
    }
    if (!active) {
      // Leftovers of an interrupted turn: its result means it has wound down.
      if (event.kind === 'result') this.#drained(entry)
      return
    }
    const { turn } = active
    switch (event.kind) {
      case 'init': {
        const atelier = event.mcpServers.find((s) => s.name === 'atelier')
        if (entry.tools.length > 0 && atelier && atelier.status === 'failed') {
          active.finish({ text: '', paused: false, error: MESSAGES.toolsFailed })
          void this.#drop(entry.chatId)
        }
        return
      }
      case 'api-error':
        // The CLI's own report of an API error: the result that follows fails, and the card explains it.
        active.apiError = event
        return
      case 'text':
        active.started = true
        active.text += event.text
        turn.emit({ type: 'text-delta', turnId: this.#turnId(active, event.messageId), text: event.text })
        return
      case 'thinking':
        active.started = true
        turn.emit({ type: 'thinking-delta', turnId: this.#turnId(active, event.messageId), text: event.text })
        return
      case 'tool-use': {
        active.started = true
        // CH-14: one step per model message that asks for tools; a step past the cap isn't run.
        const step = event.messageId ?? `tool-${event.id}`
        if (!active.steps.has(step)) {
          if (active.steps.size >= this.#maxSteps(active)) {
            this.#stopAtStepLimit(entry, active)
            return
          }
          active.steps.add(step)
          active.stepTools.clear()
        }
        active.stepTools.add(event.id)
        const label = toolLabel(event.name, event.input)
        active.toolLabels.set(event.id, label)
        // The same step fields as the API-key engine.
        const server = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(event.name)?.[1] ?? null
        const connector = server && server !== MCP_SERVER_NAME ? entry.connectorServers.get(server) : undefined
        const input = summarizeInput(event.input)
        const start = { kind: toolKind(unqualified(event.name) ?? BUILT_IN_KINDS[event.name] ?? event.name, connector !== undefined), startedAt: Date.now(), ...(input ? { input } : {}), ...(connector ? { connector } : {}) }
        active.toolStarts.set(event.id, start)
        turn.emit({ type: 'tool', id: event.id, label, state: 'running', ...start })
        return
      }
      case 'tool-result': {
        const label = active.toolLabels.get(event.id) ?? 'Tool'
        const detail = event.isError ? event.text.trim().slice(0, 300) : ''
        const start = active.toolStarts.get(event.id) ?? { kind: 'other' as const, startedAt: Date.now() }
        active.toolStarts.delete(event.id)
        const result = event.isError ? undefined : summarizeResult(event.text)
        turn.emit({ type: 'tool', id: event.id, label, state: event.isError ? 'error' : 'done', ...start, endedAt: Date.now(), ...(detail ? { detail } : {}), ...(result ? { result } : {}) })
        if (!event.isError) for (const source of webSearchSources(event.text)) turn.emit({ type: 'source', ...source }) // Web sources, as on the API key
        // CH-14: the cap's last step has all its results: stop before the next model step, as the API-key loop does.
        if (active.stepTools.delete(event.id) && active.stepTools.size === 0 && active.steps.size >= this.#maxSteps(active)) this.#stopAtStepLimit(entry, active)
        return
      }
      case 'usage': {
        const turnId = this.#turnId(active, event.messageId)
        const details: MessageDetails = {
          turnId,
          at: Date.now(),
          model: event.model ?? turn.capabilities.model,
          usage: event.usage,
          stopReason: event.stopReason,
          memoryPaths: [],
          engine: 'claude-code',
        }
        active.details.set(turnId, details)
        turn.details(details)
        return
      }
      case 'compacting': {
        // CH-26: Claude Code condenses on its own; the chat shows it as a compaction card.
        const running = this.#compactions.get(entry.chatId)
        if (event.active) {
          if (running) return
          const id = randomUUID()
          this.#compactions.set(entry.chatId, id)
          turn.emit({ type: 'compaction', id, state: 'running', trigger: active.compact ? 'manual' : 'auto' })
          return
        }
        if (!event.boundary) return
        this.#compactions.delete(entry.chatId)
        turn.emit({ type: 'compaction', id: running ?? randomUUID(), state: 'done', trigger: event.boundary.trigger, ...(event.boundary.preTokens !== null ? { replacedTokens: event.boundary.preTokens } : {}) })
        return
      }
      case 'result': {
        // A condensing that never reached its boundary failed.
        const running = this.#compactions.get(entry.chatId)
        if (running) {
          this.#compactions.delete(entry.chatId)
          turn.emit({ type: 'compaction', id: running, state: 'failed', trigger: active.compact ? 'manual' : 'auto' })
        }
        const result = this.#resultOf(entry, active, event)
        active.finish(result)
        // A CLI too old for the model: the next message starts a new process, from an updated CLI.
        if (result.errorCode === 'cc-too-old') void this.#drop(entry.chatId)
        return
      }
      default:
        return
    }
  }

  #turnId(active: ActiveTurn, messageId: string): string {
    let id = active.turnIds.get(messageId)
    if (!id) {
      id = randomUUID()
      active.turnIds.set(messageId, id)
    }
    return id
  }

  #resultOf(entry: ChatProcess, active: ActiveTurn, event: Extract<BridgeEvent, { kind: 'result' }>): BackendResult {
    this.#closeDetails(active, event.costUsd)
    // Compact now's reply is the card, not text.
    const text = active.compact ? '' : (event.text || active.text).trim()
    if (event.ok) return { text, paused: false, error: null }
    // CH-14: the step cap is a notice with Continue, not an error.
    if (event.subtype === 'error_max_turns') return { text, paused: true, error: null, stepLimit: true, steps: active.steps.size || event.numTurns || MAX_STEPS }
    // A failed result's text is the CLI's error ("API Error: 400 {…}"), never part of the reply.
    const reason = [...new Set([active.apiError?.text ?? '', event.text, ...event.errors].map((r) => r.trim()).filter(Boolean))].join('\n')
    return { text: active.compact ? '' : active.text.trim(), paused: false, ...this.#failure(entry, active, reason) }
  }

  /** Cost and memory changes belong to the last model turn of the reply. */
  #closeDetails(active: ActiveTurn, costUsd: number | null): void {
    const last = [...active.details.values()].at(-1)
    if (!last) return
    active.turn.details({
      ...last,
      ...(costUsd !== null ? { costUsd } : {}),
      memoryPaths: [...active.memoryPaths],
    })
  }

  /** CH-14: the run's step cap right now; none with Settings › Model and key › No step limit. */
  #maxSteps(active: ActiveTurn): number {
    return active.turn.maxSteps?.() ?? MAX_STEPS
  }

  /**
   * CH-14: the step cap was reached. The turn is interrupted (its leftovers
   * are drained before the next message) and ends as the step-limit notice,
   * whose Continue sends CONTINUE_PROMPT as the next message.
   */
  #stopAtStepLimit(entry: ChatProcess, active: ActiveTurn): void {
    if (entry.turn !== active) return
    this.#interrupt(entry)
    this.#closeDetails(active, null)
    const running = this.#compactions.get(entry.chatId)
    if (running) {
      this.#compactions.delete(entry.chatId)
      active.turn.emit({ type: 'compaction', id: running, state: 'failed', trigger: 'auto' })
    }
    active.finish({ text: active.text.trim(), paused: true, error: null, stepLimit: true, steps: active.steps.size })
  }

  #exitResult(exit: ProcessExit, active: ActiveTurn, entry: ChatProcess): BackendResult {
    const reason = [active.apiError?.text ?? '', exit.stderr || active.text].filter(Boolean).join('\n')
    // A sign-in, version or API failure on the way out gets its own card; anything else is a crash.
    if (looksSignedOut(reason) || active.apiError || tooOldFacts(reason) || parseCliApiError(exit.stderr)) return { text: '', paused: false, ...this.#failure(entry, active, reason) }
    const code = exit.code !== null ? mainT('engines.chat.mainClaudeCode.exitCode', { code: exit.code }) : exit.signal ? `signal ${exit.signal}` : mainT('engines.chat.mainClaudeCode.noExitCode')
    return { text: active.text.trim(), paused: false, error: MESSAGES.crashed(exit.stderr ? `${code}: ${exit.stderr}` : code) }
  }

  /**
   * A failure in words that say what to do about it, with its card's code,
   * facts and the CLI's raw text for Details. Signing out and a model's
   * minimum version are passed on to the engine status.
   */
  #failure(entry: ChatProcess, active: ActiveTurn, reason: string): Pick<BackendResult, 'error' | 'errorCode' | 'errorDetails' | 'errorFacts' | 'retryAfterMs'> {
    const api = active.apiError
    const error = classifyClaudeCodeFailure({
      text: reason,
      kind: api?.error ?? null,
      apiError: api?.apiError ?? null,
      status: api?.status ?? null,
      limited: active.rateLimit?.status === 'limited',
      resetsAt: active.rateLimit?.resetsAt ?? null,
      model: active.turn.capabilities.model,
      version: entry.cliVersion,
    })
    if (error.code === 'cc-signed-out') this.#deps.onNote({ signedOut: true })
    if (error.code === 'cc-too-old' && error.facts?.required && error.facts.model) this.#deps.onNote({ minimum: { model: error.facts.model, version: error.facts.required } })
    return {
      error: error.message,
      errorCode: error.code,
      ...(error.details ? { errorDetails: error.details } : {}),
      ...(error.facts ? { errorFacts: error.facts } : {}),
      ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
    }
  }

  /** Stops every chat's process that isn't working on a reply, so the next message starts the CLI Atelier finds now (after an update). */
  restartIdle(): void {
    for (const entry of [...this.#chats.values()]) if (!entry.turn && !entry.draining) void this.#drop(entry.chatId)
  }

  #interrupt(entry: ChatProcess): void {
    if (!entry.proc.alive) return
    entry.proc.interrupt(randomUUID())
    let done: () => void = () => undefined
    const promise = new Promise<void>((resolve) => {
      done = resolve
    })
    const draining = { promise, done }
    entry.draining = draining
    // A turn that doesn't wind down in time takes its process with it; the next message resumes.
    const timer = setTimeout(() => {
      if (entry.draining === draining) void this.#drop(entry.chatId)
      this.#drained(entry)
    }, INTERRUPT_GRACE_MS)
    void promise.then(() => clearTimeout(timer))
    void entry.proc.exited.then(() => this.#drained(entry))
  }

  #drained(entry: ChatProcess): void {
    const draining = entry.draining
    entry.draining = null
    draining?.done()
  }

  #scheduleIdle(entry: ChatProcess): void {
    if (this.#chats.get(entry.chatId) !== entry || !entry.proc.alive) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => void this.#drop(entry.chatId), this.#deps.idleMs ?? IDLE_MS)
    entry.idleTimer.unref?.()
  }

  /** Keeps the number of live processes under the cap by stopping the least recently used idle ones. */
  async #makeRoom(): Promise<void> {
    const max = this.#deps.maxProcesses ?? MAX_PROCESSES
    const idle = [...this.#chats.values()].filter((c) => !c.turn).sort((a, b) => a.lastUsed - b.lastUsed)
    while (this.#chats.size >= max && idle.length > 0) {
      const oldest = idle.shift()
      if (oldest) await this.#drop(oldest.chatId)
    }
  }

  async #drop(chatId: string): Promise<void> {
    const entry = this.#chats.get(chatId)
    if (!entry) return
    this.#forget(entry)
    entry.turn?.finish(new Error('Stopped.'))
    await entry.proc.stop()
  }

  #forget(entry: ChatProcess): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    if (this.#chats.get(entry.chatId) === entry) this.#chats.delete(entry.chatId)
    rmSync(entry.configPath, { force: true })
    this.#deps.onNote({ processes: this.processes })
  }
}

/**
 * The chat's MCP servers: Atelier's own, plus each enabled connector as a remote
 * HTTP server under a name Claude Code accepts. A connector can't take Atelier's name.
 */
export function mcpServers(atelier: { url: string; token: string }, connectors: readonly ResolvedConnector[]): Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> {
  const servers: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> = {
    [MCP_SERVER_NAME]: { type: 'http', url: atelier.url, headers: { Authorization: `Bearer ${atelier.token}` } },
  }
  for (const [name, connector] of connectorServerList(connectors)) {
    servers[name] = { type: 'http', url: connector.url, ...(connector.token ? { headers: { Authorization: `Bearer ${connector.token}` } } : {}) }
  }
  return servers
}

/** Server name to connector, for the steps' connector field. */
export function connectorServerNames(connectors: readonly ResolvedConnector[]): Map<string, { id: string; name: string }> {
  return new Map(connectorServerList(connectors).map(([name, c]) => [name, { id: c.id, name: c.name }]))
}

/** Claude Code's built-ins under the API-key engine's tool names, for the steps' kinds. */
const BUILT_IN_KINDS: Record<string, string> = { WebSearch: 'web_search', WebFetch: 'web_fetch' }

/** The chat's label for a tool call: Atelier's own browser tools read like the API-key engine's. */
export function toolLabel(name: string, input: unknown): string {
  const member = unqualified(name)
  if (member) return describeToolCall(member, input)
  if (name === 'WebSearch') return describeToolCall('web_search', { query: (input as { query?: unknown } | null)?.query })
  if (name === 'WebFetch') return describeToolCall('web_fetch', { url: (input as { url?: unknown } | null)?.url })
  return `Use ${name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')}`
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean
}

export const MESSAGES = {
  get notFound() { return mainT('engines.chat.mainClaudeCode.claudeCodeIsnT') },
  get signedOut() { return mainT('engines.chat.mainClaudeCode.claudeCodeIsnT2') },
  get noCredit() { return mainT('engines.chat.mainClaudeCode.theAnthropicAccountClaude') },
  get toolsFailed() { return mainT('engines.chat.mainClaudeCode.atelierCouldnTConnect') },
  limited: (resetsAt: number | null): string =>
    mainT('engines.chat.mainClaudeCode.yourClaudeAccountHas', { value: resetsAt ? mainT('engines.chat.mainClaudeCode.itOpensAgainAt', { value: new Date(resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }) : '' }),
  crashed: (detail: string): string => mainT('engines.chat.mainClaudeCode.claudeCodeStoppedUnexpectedly', { value: clip(detail) }),
  get nothingToCompact() { return mainT('engines.chat.mainClaudeCode.claudeCodeHasNothing') },
}

export type { TurnUsage }
