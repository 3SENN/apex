/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Memory build and reorganize jobs (ST-47). "Build from past chats" reads
// your saved chats in batches and has a background chat (no browser, memory
// tool only) save what is worth remembering; "Reorganize" has one tidy up
// the notes already there. Private chats are never read; imported ones are.
// Progress goes out as the `memory-job` event, a job can be cancelled, and
// one that was running when Apex quit is marked interrupted, with Retry
// picking up at the batch it stopped at. With the decision model on for
// memory (DC-17), a build first leaves out the chats it is sure hold nothing
// lasting. Jobs live in userData/memory-jobs.json.
import { randomUUID } from 'node:crypto'
import { approxCostUsd } from '@shared/pricing'
import { SHARED_OWNER, type ChatSummary } from '@shared/chats'
import type { MemoryBuildEstimate, MemoryJob, MemoryJobsMethods } from '@shared/activity'
import type { AgentEvent } from '@shared/ipc'
import type { MemoryFile, Owner } from '@shared/services'
import type { AgentHostApi } from './agent/hostApi'
import { decider } from './decisions/service'
import { worthRemembering } from './decisions/uses'
import { log } from './log'
import { writeAtomic } from './settings'
import { readJson } from './stores'

/** Characters of chat text per background turn (about 12k tokens). */
export const BATCH_CHARS = 48_000
/** Instructions and tool overhead per batch, in tokens, for the estimate. */
const BATCH_OVERHEAD_TOKENS = 1_500
/** Roughly what one batch writes back, in tokens. */
const BATCH_OUTPUT_TOKENS = 1_200
const KEEP_JOBS = 20
/** Chats the decision model judges at once (DC-17). */
const JUDGE_AT_ONCE = 4

export interface Transcript {
  id: string
  text: string
  messages: number
}

/** A chat as plain dialogue: your messages and the replies' text; tool steps and thinking left out. */
export function chatTranscript(summary: Pick<ChatSummary, 'id' | 'title' | 'createdAt'>, events: readonly AgentEvent[], companionName = 'Companion'): Transcript {
  const lines: string[] = [`### ${summary.title} (${new Date(summary.createdAt).toISOString().slice(0, 10)})`]
  let reply = ''
  let messages = 0
  const flush = (): void => {
    if (reply.trim()) {
      lines.push(`${companionName}: ${reply.trim()}`)
      messages++
    }
    reply = ''
  }
  for (const event of events) {
    if (event.type === 'user-message') {
      flush()
      if (event.text.trim()) {
        lines.push(`You: ${event.text.trim()}`)
        messages++
      }
    } else if (event.type === 'text-delta') {
      reply += event.text
    }
  }
  flush()
  return { id: summary.id, text: lines.join('\n\n'), messages }
}

/** Greedy batches of whole chats within `budget` characters; a chat longer than that is cut to it. */
export function planBatches(transcripts: readonly Transcript[], budget = BATCH_CHARS): Transcript[][] {
  const batches: Transcript[][] = []
  let current: Transcript[] = []
  let size = 0
  for (const t of transcripts) {
    const piece = t.text.length > budget ? { ...t, text: `${t.text.slice(0, budget - 40)}\n\n[the rest of this chat was left out]` } : t
    if (current.length > 0 && size + piece.text.length > budget) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(piece)
    size += piece.text.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** Chats a build may read: saved, not private, not routine runs, delegated children or Apex's own upkeep chats. */
export function eligibleChats(chats: readonly ChatSummary[], owner: Owner | 'all', own: ReadonlySet<string>): ChatSummary[] {
  return chats
    .filter((c) => !c.private && !c.draft && !c.routineId && !c.parentChatId && !own.has(c.id))
    .filter((c) => owner === 'all' || owner === SHARED_OWNER || c.companionId === owner)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * DC-17: the ids of the transcripts the decision model is sure hold nothing
 * worth remembering, a few at a time. Call it only while the 'memory' use is
 * active; `going` going false stops it early (a cancelled job).
 */
export async function nothingToRemember(transcripts: readonly Transcript[], going: () => boolean = () => true): Promise<Set<string>> {
  const skipped = new Set<string>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < transcripts.length && going()) {
      const t = transcripts[next++] as Transcript
      if (!(await worthRemembering(t.text).catch(() => true))) skipped.add(t.id)
    }
  }
  await Promise.all(Array.from({ length: Math.min(JUDGE_AT_ONCE, transcripts.length) }, worker))
  return skipped
}

function folderOf(owner: Owner): string {
  return owner === SHARED_OWNER ? '/memories/shared/' : '/memories/'
}

export function buildPrompt(batch: readonly Transcript[], owner: Owner, index: number, total: number): string {
  return [
    `You are building long-term memory from the person's past conversations (part ${index + 1} of ${total}).`,
    `Save what is worth remembering across chats in ${folderOf(owner)} with the memory tool: who they are, their preferences, ongoing projects, people and places they mention, and decisions they made.`,
    'Look at the notes already there first. Add to an existing note rather than starting a duplicate, keep each file short and about one topic, and date facts that may change.',
    'Skip one-off details, and anything about health, money, relationships, religion, politics or identity numbers unless they clearly asked you to remember it.',
    'When you are done, reply with one short line about what you saved.',
    '',
    '<conversations>',
    batch.map((t) => t.text).join('\n\n---\n\n'),
    '</conversations>',
  ].join('\n')
}

export function reorganizePrompt(owner: Owner, notes: readonly MemoryFile[]): string {
  const listing = notes.map((n) => `- ${owner === SHARED_OWNER ? n.path.replace(/^\/memories\//, '/memories/shared/') : n.path} (${n.size} bytes)`).join('\n')
  return [
    `Reorganize the notes in ${folderOf(owner)} with the memory tool. Read them first.`,
    'Merge duplicates, settle contradictions in favour of the newest information, split long files by topic, give files clear names, and delete notes that are empty or plainly outdated.',
    'Keep every fact that is still true. Never invent anything.',
    'When you are done, reply with one short line about what changed.',
    '',
    'Notes:',
    listing || '(none)',
  ].join('\n')
}

interface Stored {
  job: MemoryJob
  /** The chats a build reads, in order, so a retry plans the same batches. Null for reorganize. */
  chatIds: string[] | null
  /** DC-17: the decision model still judges these chats before the first batch (set when the build starts while it is on). */
  judge?: boolean
}

export interface MemoryJobsDeps {
  /** userData/memory-jobs.json */
  file: string
  chats: { list(): ChatSummary[]; load(id: string): { log: readonly AgentEvent[] } }
  memory: { list(owner: Owner): MemoryFile[]; read(path: string, owner: Owner): string }
  host: Pick<AgentHostApi, 'runBackground'> & { stop?(chatId: string): unknown }
  activeCompanion(): string
  companionName(id: string): string
  /** The engine and model new chats use, for the cost estimate (API key only). */
  engine(): { engine: string; model: string }
  /** versions.snapshot for a note about to be rewritten. */
  snapshot(owner: Owner, path: string, text: string): void
  broadcast(job: MemoryJob): void
  /** Chats Apex itself started for memory upkeep; builds never read them. Shared with Tidy memory. */
  ownChats: Set<string>
}

export class MemoryJobs {
  readonly #deps: MemoryJobsDeps
  readonly #jobs: Stored[]
  /** Each run of a job takes the next number, so a run left over from before a Cancel and Retry stops instead of running beside the new one. */
  readonly #runs = new Map<string, number>()

  constructor(deps: MemoryJobsDeps) {
    this.#deps = deps
    const raw = readJson(deps.file)
    const list = Array.isArray(raw) ? (raw as Stored[]).filter((s) => s && typeof s === 'object' && s.job && typeof s.job.id === 'string') : []
    // A job that was running when Apex quit can't still be running.
    this.#jobs = list.map((s) => (s.job.state === 'running' ? { ...s, job: { ...s.job, state: 'interrupted' } } : s))
    for (const s of this.#jobs) if (s.job.chatId) deps.ownChats.add(s.job.chatId)
    if (this.#jobs.some((s, i) => s.job.state !== list[i]?.job.state)) this.#save()
  }

  #save(): void {
    writeAtomic(this.#deps.file, JSON.stringify(this.#jobs.slice(0, KEEP_JOBS)))
  }

  #set(id: string, patch: Partial<MemoryJob>): MemoryJob | null {
    const stored = this.#jobs.find((s) => s.job.id === id)
    if (!stored) return null
    stored.job = { ...stored.job, ...patch }
    this.#save()
    this.#deps.broadcast(stored.job)
    return stored.job
  }

  #transcripts(chatIds: readonly string[]): Transcript[] {
    const byId = new Map(this.#deps.chats.list().map((c) => [c.id, c]))
    const out: Transcript[] = []
    for (const id of chatIds) {
      const summary = byId.get(id)
      if (!summary || summary.private) continue
      try {
        out.push(chatTranscript(summary, this.#deps.chats.load(id).log, this.#deps.companionName(summary.companionId)))
      } catch (err) {
        log.warn('memory', 'Skipped a chat that could not be read', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return out.filter((t) => t.messages > 0)
  }

  estimateBuild(owner: Owner | 'all'): MemoryBuildEstimate {
    const chats = eligibleChats(this.#deps.chats.list(), owner, this.#deps.ownChats)
    const transcripts = this.#transcripts(chats.map((c) => c.id))
    const batches = planBatches(transcripts)
    const chars = batches.reduce((n, b) => n + b.reduce((m, t) => m + t.text.length, 0), 0)
    const approxInputTokens = Math.ceil(chars / 4) + batches.length * BATCH_OVERHEAD_TOKENS
    const { engine, model } = this.#deps.engine()
    // A dollar estimate only with the API key, which is billed per token. Another engine runs on the person's
    // own account, so there is no per-token price to estimate: null, and only the token count shows.
    const approxCost = engine === 'api-key' ? approxCostUsd(model, { inputTokens: approxInputTokens, outputTokens: batches.length * BATCH_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 }) : null
    return { chats: transcripts.length, messages: transcripts.reduce((n, t) => n + t.messages, 0), approxInputTokens, approxCostUsd: approxCost }
  }

  jobs(): MemoryJob[] {
    return this.#jobs.map((s) => s.job)
  }

  startJob(kind: MemoryJob['kind'], owner: Owner, options: { chatIds?: string[] } = {}): MemoryJob {
    if (this.#jobs.some((s) => s.job.state === 'running' && s.job.owner === owner)) throw new Error('A memory job is already running for these notes. Wait for it or cancel it first.')
    let chatIds: string[] | null = null
    let total = 1
    if (kind === 'build') {
      const eligible = eligibleChats(this.#deps.chats.list(), owner, this.#deps.ownChats)
      const wanted = options.chatIds ? new Set(options.chatIds) : null
      chatIds = eligible.filter((c) => !wanted || wanted.has(c.id)).map((c) => c.id)
      total = planBatches(this.#transcripts(chatIds)).length
      if (total === 0) throw new Error('There are no saved chats to build memory from yet.')
    } else if (this.#deps.memory.list(owner).length === 0) {
      throw new Error('There are no notes to reorganize yet.')
    }
    const job: MemoryJob = { id: randomUUID(), kind, owner, state: 'running', done: 0, total, chatId: null }
    this.#jobs.unshift(kind === 'build' && decider().active('memory') ? { job, chatIds, judge: true } : { job, chatIds })
    this.#save()
    this.#deps.broadcast(job)
    void this.#run(job.id)
    return job
  }

  retryJob(id: string): MemoryJob {
    const stored = this.#jobs.find((s) => s.job.id === id)
    if (!stored) throw new Error('That memory job is gone.')
    if (stored.job.state === 'running' || stored.job.state === 'done') return stored.job
    if (this.#jobs.some((s) => s.job.state === 'running' && s.job.owner === stored.job.owner)) throw new Error('A memory job is already running for these notes.')
    const job = this.#set(id, { state: 'running', error: undefined }) as MemoryJob
    void this.#run(id)
    return job
  }

  cancelJob(id: string): void {
    const stored = this.#jobs.find((s) => s.job.id === id)
    if (!stored || stored.job.state !== 'running') return
    this.#set(id, { state: 'cancelled' })
    if (stored.job.chatId) {
      try {
        this.#deps.host.stop?.(stored.job.chatId)
      } catch {
        // Already stopped.
      }
    }
  }

  async #run(id: string): Promise<void> {
    const stored = this.#jobs.find((s) => s.job.id === id)
    if (!stored) return
    const { owner, kind } = stored.job
    const run = (this.#runs.get(id) ?? 0) + 1
    this.#runs.set(id, run)
    const running = (): boolean => this.#runs.get(id) === run && this.#jobs.find((s) => s.job.id === id)?.job.state === 'running'
    try {
      const companionId = owner === SHARED_OWNER ? this.#deps.activeCompanion() : owner
      const prompts: string[] = []
      if (kind === 'build') {
        let transcripts = this.#transcripts(stored.chatIds ?? [])
        if (stored.judge) {
          // DC-17: chats the model is sure hold nothing lasting are left out once, and the ids kept are
          // stored, so a retry plans the same batches. Cancelled meanwhile, a retry judges again.
          const skipped = decider().active('memory') ? await nothingToRemember(transcripts, running) : new Set<string>()
          if (!running()) return
          transcripts = transcripts.filter((t) => !skipped.has(t.id))
          stored.chatIds = (stored.chatIds ?? []).filter((c) => !skipped.has(c))
          delete stored.judge
          if (skipped.size > 0) this.#set(id, { skippedChats: skipped.size })
          else this.#save()
        }
        const batches = planBatches(transcripts)
        batches.forEach((batch, i) => prompts.push(buildPrompt(batch, owner, i, batches.length)))
        if (batches.length !== stored.job.total) this.#set(id, { total: batches.length, done: Math.min(stored.job.done, batches.length) })
      } else {
        const notes = this.#deps.memory.list(owner)
        // Every note is kept as a version before the agent rewrites it.
        for (const note of notes) {
          try {
            this.#deps.snapshot(owner, note.path, this.#deps.memory.read(note.path, owner))
          } catch (err) {
            log.warn('memory', 'Could not keep a version before reorganizing', { error: err instanceof Error ? err.message : String(err) })
          }
        }
        prompts.push(reorganizePrompt(owner, notes))
      }
      for (let i = stored.job.done; i < prompts.length; i++) {
        if (!running()) return
        const current = this.#jobs.find((s) => s.job.id === id)?.job
        const result = await this.#deps.host.runBackground({
          companionId,
          prompt: prompts[i] as string,
          kind: 'tidy',
          title: kind === 'build' ? 'Building memory from past chats' : 'Reorganizing memory',
          appendTo: current?.chatId ?? undefined,
          capabilities: { memory: true, webTools: false, connectors: false },
        })
        if (result.chatId) this.#deps.ownChats.add(result.chatId)
        if (!running()) return
        if (!result.ok) {
          this.#set(id, { state: 'failed', chatId: result.chatId ?? current?.chatId ?? null, error: `The background chat ended (${result.status}). Open it to see why.` })
          return
        }
        this.#set(id, { done: i + 1, chatId: result.chatId ?? current?.chatId ?? null })
      }
      if (running()) this.#set(id, { state: 'done' })
    } catch (err) {
      if (running()) this.#set(id, { state: 'failed', error: err instanceof Error ? err.message : String(err) })
    }
  }

  methods(): Pick<MemoryJobsMethods, 'estimateBuild' | 'startJob' | 'cancelJob' | 'retryJob' | 'jobs'> {
    return {
      estimateBuild: (owner) => this.estimateBuild(owner),
      startJob: (kind, owner, options) => this.startJob(kind, owner, options),
      cancelJob: (id) => this.cancelJob(id),
      retryJob: (id) => this.retryJob(id),
      jobs: () => this.jobs(),
    }
  }
}
