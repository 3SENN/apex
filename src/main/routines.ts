/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SHARED_OWNER, type ChatStatus, type ChatSummary } from '@shared/chats'
import type { Routine, RoutineRunStatus, RoutineTrigger } from '@shared/routines'
import type { AgentHostApi, BackgroundRunInput } from './agent/hostApi'
import { NOT_YET } from './serviceKit'
import { nextRunAfter } from './routines/schedule'
import type { RoutineRunStore } from './routines/runs'
import type { RoutineStore } from './routines/store'
import { yesNo } from '@shared/decisions'
import type { AgentEvent } from '@shared/ipc'
import { decider, type Decider } from './decisions/service' // DC-07: routine conditions

/** The runner's result for one run (the record is `RoutineRun` in shared/routines.ts). */
export interface RoutineRun {
  ok: boolean
  chatId: string | null
}

/** What the skills-and-routines feature adds to a run; it attaches these once the stores exist. */
export interface RoutineRunnerExtras {
  /** Background runs; without them, `run` (the simple runRoutine path) does the work. */
  host: AgentHostApi
  runs: RoutineRunStore
  /** The active companion, for shared routines. */
  activeCompanionId(): string
  skillName(id: string): string | null
  /** Whether an `append` destination can still take runs; otherwise the run starts a new chat. */
  canAppend(chatId: string): boolean
  /** Fills summary fields on the simple path (SK-12's run header reads `routineRun`). */
  patchChat(chatId: string, patch: Pick<ChatSummary, 'routineRun'>): void
}

interface RoutineRunnerDeps extends Partial<RoutineRunnerExtras> {
  store: RoutineStore
  /** The simple path: runs the routine's prompt in a fresh background chat. */
  run: (routine: Routine) => Promise<RoutineRun>
  notify: (routine: Routine, run: RoutineRun) => void
  /** DC-07: the run's closing reply, for an "Only tell me if…" condition. */
  reply?: (chatId: string) => string | null
  now?: () => number
}

/** A run more than this late (the app was closed or asleep) is a catch-up. */
export const CATCH_UP_AFTER_MS = 5 * 60_000

/** Routines whose time has come; a routine waiting for a companion never runs. Missed runs (app was closed) run once. */
export function dueRoutines<T extends { id: string; enabled: boolean; nextRunAt: number | null; needsCompanion?: boolean }>(routines: T[], now: number, running: ReadonlySet<string>): T[] {
  return routines.filter((r) => r.enabled && !r.needsCompanion && r.nextRunAt !== null && r.nextRunAt <= now && !running.has(r.id))
}

/** A background chat's end state as a run status. */
export function runStatusOf(result: { ok: boolean; status: ChatStatus }): RoutineRunStatus {
  if (result.status === 'needs-approval') return 'needs-input'
  if (!result.ok || result.status === 'error') return 'error'
  return result.status === 'idle' ? 'stopped' : 'ok'
}

/**
 * DC-07: whether a run's reply meets its "Only tell me if…" condition. Asked
 * of the decision model when one is on, otherwise of the Claude engine. It
 * stays quiet only on a clear no: a failed check, an empty reply or an unsure
 * answer still notifies, since a missed result costs more than an extra one.
 */
export async function conditionMet(condition: string, reply: string | null, ask: Decider['ask'] = (...a) => decider().ask(...a)): Promise<boolean> {
  if (!condition.trim() || !reply?.trim()) return true
  try {
    const result = await ask('routine', {
      state: reply.trim().slice(-6_000),
      questions: { met: { type: 'noul', instructions: `This is the report a scheduled task just wrote. Judging only from it, is this true: ${condition.trim()}` } },
    })
    return yesNo(result.answers.met, 0.7, result.source === 'claude' ? 0.15 : 0.3) !== false
  } catch {
    return true
  }
}

/** A chat's closing reply: the text of its last turn that wrote any (both engines log it as text deltas). */
export function lastReplyOf(log: readonly AgentEvent[]): string | null {
  let turnId: string | null = null
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!
    // A run that wrote nothing has no reply: an earlier turn's is not this run's.
    if (e.type === 'user-message') return null
    if (e.type === 'text-delta') {
      turnId = e.turnId
      break
    }
  }
  if (turnId === null) return null
  return log.flatMap((e) => (e.type === 'text-delta' && e.turnId === turnId ? [e.text] : [])).join('') || null
}

/** What the background chat is asked: a skill's /name first, then the instructions. */
export function routinePrompt(routine: Pick<Routine, 'prompt' | 'skillId'>, skillName: (id: string) => string | null): string {
  const name = routine.skillId ? skillName(routine.skillId) : null
  if (!name) return routine.prompt
  return routine.prompt ? `/${name} ${routine.prompt}` : `/${name}`
}

/**
 * Runs scheduled routines while Atelier is open. Routines run in their own
 * background chats without browser control, so they never take over the
 * tab the user is looking at. Each run gets a record (SK-09) that links to
 * its chat; a run that was missed while Atelier was closed runs once, marked
 * as a catch-up.
 */
export class RoutineRunner {
  readonly #deps: RoutineRunnerDeps
  readonly #running = new Set<string>()
  #timer: NodeJS.Timeout | null = null

  constructor(deps: RoutineRunnerDeps) {
    this.#deps = deps
  }

  /** The extras, attached by the skills-and-routines feature. */
  attach(extras: Partial<RoutineRunnerExtras>): void {
    Object.assign(this.#deps, extras)
  }

  start(intervalMs = 30_000): void {
    this.stop()
    this.#timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** How many routines are running now (the restart card and tray read it). */
  runningCount(): number {
    return this.#running.size
  }

  isRunning(id: string): boolean {
    return this.#running.has(id)
  }

  async tick(): Promise<void> {
    const now = this.#now()
    await Promise.all(
      dueRoutines(this.#deps.store.list(), now, this.#running).map((r) => {
        const scheduledFor = r.nextRunAt ?? now
        return this.#execute(r.id, now - scheduledFor > CATCH_UP_AFTER_MS ? 'catch-up' : 'schedule', scheduledFor)
      }),
    )
  }

  /** Run now (from the page, the card or a notification): records a manual run. */
  async runNow(id: string): Promise<void> {
    await this.#execute(id, 'manual', this.#now())
  }

  async #execute(id: string, trigger: RoutineTrigger, scheduledFor: number): Promise<void> {
    const routine = this.#deps.store.get(id)
    if (!routine || routine.needsCompanion || this.#running.has(id)) return
    this.#running.add(id)
    const record = this.#deps.runs?.start({ routineId: id, scheduledFor, trigger, startedAt: this.#now() }) ?? null
    let run: RoutineRun = { ok: false, chatId: null }
    let status: RoutineRunStatus = 'error'
    try {
      const result = await this.#background(routine, record ? { runId: record.id, scheduledFor, trigger } : null)
      run = { ok: result.ok, chatId: result.chatId }
      status = runStatusOf(result)
    } catch {
      run = { ok: false, chatId: null }
      status = 'error'
    } finally {
      this.#running.delete(id)
    }
    const finishedAt = this.#now()
    if (record) this.#deps.runs?.finish(record.id, { status, chatId: run.chatId, finishedAt })
    const latest = this.#deps.store.get(id)
    if (!latest) return
    this.#deps.store.upsert({
      ...latest,
      lastRunAt: finishedAt,
      lastChatId: run.chatId,
      lastStatus: status === 'ok' ? 'ok' : status === 'error' ? 'error' : latest.lastStatus,
      // A one-off task moves to Past once it has run; the others go on from now.
      nextRunAt: latest.schedule.kind === 'once' ? null : latest.enabled ? nextRunAfter(latest.schedule, finishedAt, latest.timeZone) : null,
    })
    // DC-07: a condition that the reply clearly doesn't meet keeps the run quiet (it's still in the routine's runs, read).
    if (status === 'ok' && latest.notifyIf && run.chatId && !(await conditionMet(latest.notifyIf, this.#deps.reply?.(run.chatId) ?? null))) {
      if (record) this.#deps.runs?.finish(record.id, { status, chatId: run.chatId, finishedAt, read: true })
      return
    }
    this.#deps.notify(latest, run)
  }

  async #background(routine: Routine, routineRun: ChatSummary['routineRun']): Promise<{ ok: boolean; chatId: string | null; status: ChatStatus }> {
    const d = this.#deps
    const prompt = routinePrompt(routine, (sid) => d.skillName?.(sid) ?? null)
    const appendTo = routine.destination.kind === 'append' && (d.canAppend?.(routine.destination.chatId) ?? false) ? routine.destination.chatId : undefined
    if (d.host) {
      const companionId = routine.owner === SHARED_OWNER ? (d.activeCompanionId?.() ?? routine.owner) : routine.owner
      // `routineId` rides along for the chat's routine pill; BackgroundRunInput doesn't name it yet.
      const input: BackgroundRunInput & { routineId: string } = { companionId, prompt, kind: 'routine', title: routine.name, routineRun, routineId: routine.id, ...(appendTo ? { appendTo } : {}) }
      try {
        return await d.host.runBackground(input)
      } catch (err) {
        if (!(err instanceof Error) || err.message !== NOT_YET) throw err
      }
    }
    // The simple path, while the host has no runBackground.
    const legacy = await d.run({ ...routine, prompt })
    if (legacy.chatId && routineRun) d.patchChat?.(legacy.chatId, { routineRun })
    return { ...legacy, status: legacy.ok ? 'finished' : 'error' }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }
}
